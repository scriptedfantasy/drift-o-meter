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

## What only a phone can settle

Everything below is calibrated against the simulator, because that is the only ground truth
this box has. Each item names the symptom that says it needs re-deriving, so whoever gets real
recordings knows what to look for rather than re-tuning on a hunch.

* **The angle curve's top end** (`score/rules.ts`, `angleCurve`). The knots are fitted to the
  simulator's driver model, whose duration-weighted held peaks run **27–41°** (individual
  drifts reach ~50°). The 44–60° band is deliberately compressed — 97 at 44°, 100 at 60° —
  because the model rarely reaches it and stretching the scale to real competition angles would
  put grade S out of reach of every driver we can measure. Real drifting routinely sits at
  45–60°, so on real recordings that compressed band is where much of the genuine skill will
  live. **This is the first thing to re-derive from real data. The symptom is real drivers
  clustering above 95 on the angle component.**
* **CoreMotion units and timing.** The adapter assumes `rotationRate` in deg/s, `rotation` in
  radians, and that `setUpdateInterval(10)` really delivers ~100 Hz with monotonic timestamps.
  Symptom: yaw rates off by 57×, or a `dtEma` that settles anywhere but ~10 ms.
* **GPS latency in the field.** The estimator and the mount calibrator are seeded with
  `gpsLatencyS` ≈ 0.45 s, measured from the simulator's model, not from a phone on a road.
  Symptom: a standing slip-angle bias that flips sign with direction of travel, or lap
  boundaries biased one way (the metrics table in `track.test.ts` prints signed lap error —
  every row the same sign is the tell).
* **Loose-mount thresholds against a real hand.** `integrity/monitor.ts` is tuned on the
  simulator's sway signature; the independent veto (calibration quality + `forwardResolved`) is
  what currently catches a mid-loose mount the sway cues miss. Nobody has waved a real phone at
  it. Symptom: a rigid phone flagged loose, or a genuinely shaking one still scoring — check
  `looseScore` and `calibrationQuality` together against a run you have watched.
  Known residual: at simulator looseness ≤ 0.2 the sway inflates the measured angle by roughly
  15–18 % and nothing flags it.
* **Forward-axis resolution time.** The mount calibrator resolves *which way the car points*
  from longitudinal acceleration, and how long that takes was measured against a simulated
  drift circuit that offers braking and throttle at a particular rate. A real street, or a
  track of long sweepers, offers less. Symptom: the forward axis staying unresolved for a whole
  session — visible as a calibration quality that never climbs past the mid range
  (`diagnostics.calibrationQuality` / `calibrationForwardResolved`). Note this now gates
  scoring: an unresolved forward axis vetoes `driftPlausible`, so getting this wrong on real
  roads would refuse to score runs that deserve it.
* **The lever arm.** The estimator assumes a fixed 0.9 m from the phone to the centre of
  gravity. Real phones sit anywhere from a windscreen mount well forward of it to a console
  mount nearly on it. The calibrator measures its own d̂x and publishes it as a diagnostic, so
  the assumption is checkable against what a given mount actually shows. Symptom: a slip-angle
  bias that scales with yaw rate and reverses with corner direction — left-handers reading high
  and right-handers low by the same amount, growing with how hard the corner is taken.
* **Haptics.** Never exercised — the web harness has no haptic engine, so every callout's feel
  is unverified. Symptom: buzzing on every frame, or nothing at all.
* **Drift durations.** The detector's linked-drift cap (`maxDurationS + chainBonusS × n`) is set
  to the tightest bound that cuts nothing the simulator's commanded plan calls a single drift
  (14 + 12 n). A real driver's longest genuine linked run is unknown. Symptom: real drifts being
  cut in half, or a whole section of road coming back as one drift.

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
