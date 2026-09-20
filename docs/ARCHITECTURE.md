# Drift-O-Meter — architecture & working agreement

Drift-O-Meter is an iPhone app (Expo SDK 57 / React Native 0.86 / TypeScript) that
turns the phone's gyroscope, accelerometer and GPS into a live drift judge and a
cinematic replay. The bar is *Need for Speed* meets *Tokyo Drift*: every screen,
number and animation has to feel dramatic, legible at a glance from a car mount,
and physically honest.

## Layers

```
src/engine/    pure TypeScript, no RN/Expo imports. Runs in the app, in vitest on Linux,
               and in the harness. THE SAME CODE judges real sensors and simulated ones.
  types.ts     shared contracts + unit conventions  (read this first, every time)
  mount/       phone-frame → vehicle-frame calibration (gravity = up, forward from accel)
  slip/        slip-angle estimator (Kalman: IMU kinematics at 100 Hz, GPS course at 1 Hz)
  detect/      drift state machine → DriftEvent[]  (entry / sustained / transition / exit)
  score/       NFS-style scoring, multipliers, style callouts, grade S–D, consistency
  track/       GPS → local ENU, lap detection, corner detection, cross-lap consistency
  replay/      Session → replay timeline + scene description (data, not pixels)
  pipeline.ts  wires the above into one `DriftPipeline` object with push(motion)/push(gps)
src/sim/       kinematic drift simulator: tracks, scripted drifts, realistic sensor models,
               ground truth. Used by tests, by the harness, and by the in-app demo source.
src/platform/  sensor adapters (expo-sensors, expo-location) → engine sample types,
               SensorSource interface with Device and Simulated implementations, storage.
src/ui/        theme tokens, fonts, primitives (Skia gauges, callouts, buttons)
src/app/       expo-router screens:  /  /calibrate  /drive  /results/[id]  /replay/[id]  /settings
tools/harness/ Playwright: builds the web export, drives the running app with the simulated
               source, captures screenshots + videos into artifacts/ for the critic agents.
tools/progress/ builds the live progress page.
```

## Unit & frame conventions
See the header comment of `src/engine/types.ts`. Short version: SI units, radians,
vehicle frame x-forward / y-left / z-up, yaw rate + = left turn, headings in math
convention (CCW from east), slip angle β = course − heading (β>0 = right-hand drift).

## Sensor facts that shape the design
* `expo-sensors` DeviceMotion on iOS: `acceleration` and `accelerationIncludingGravity` in
  m/s²; `rotationRate` in **deg/s** (convert to rad/s in the adapter); `rotation` is
  attitude in radians; up to 100 Hz via `setUpdateInterval(10)`.
* iPhone GPS: ~1 Hz, `speed` m/s, `course` degrees clockwise from north (velocity
  direction, NOT phone heading), 0.3–1 s latency, `hAcc` typically 3–5 m outdoors.
* Therefore: heading comes from integrating gyro yaw rate; the *direction of travel*
  comes from GPS course; the difference is the slip angle. Between GPS fixes the
  kinematic identity β̇ ≈ a_y / v − r (lateral accel over speed minus yaw rate) propagates β
  at 100 Hz. Gyro bias and heading offset are estimated while driving straight.

## Working agreement for sub-agents
* Own only the files listed in your brief. Never edit `src/engine/types.ts` without
  reporting the exact change (other agents depend on it).
* No `git commit` — the orchestrator commits at checkpoints.
* Network: only registry.npmjs.org and pypi.org are reachable. `npx expo install` FAILS
  (Expo API blocked); use `npm install <pkg>@<version>` with versions from
  `node_modules/expo/bundledNativeModules.json`. No runtime CDN loads: bundle everything.
* Tests: `npx vitest run` (engine + sim). Web build: `npx expo export --platform web`.
  Harness: `node tools/harness/shoot.mjs` (see tools/harness/README.md once it exists).
* This Linux box cannot run the iOS build. The engine is verified by tests against the
  simulator's ground truth; the UI is verified by running the real web build in Chromium.
  Be explicit in your report about what was verified how.
* Report back: what you built, how you verified it (commands + numbers), known gaps.
