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

  AND IT WAS BIGGER THAN IT LOOKED, because a bug was hiding it in both directions. The mount
  calibrator rotated the FIRST SAMPLE OF EVERY RUN with a body-up axis it had not built yet, so
  the very first vehicle-frame sample carried about 12 m/s² of acceleration that never happened
  (measured `az = −7.285`, `ax = −9.416` at t=0 against a phone-frame reading of 0.059). The
  0.3 Hz high-pass rang on that single sample for about half a second, into a 2 s exponential RMS
  that held it for roughly 4.6 — which was the ENTIRE false `suspect` on a bolted-down phone, and
  which the calibration screen had been papering over with a 4 s warm-up guard of its own.
  Two numbers on this list moved when it was fixed, and both are now honest rather than lucky:
    - At looseness 0.15 the sway cues cross `suspect` in **2 of 8** runs, not 6 of 8. The old six
      were the startup artefact latching the label through hysteresis (`suspectExit` 0.18 against
      a steady score of 0.24–0.32). What is left is this residual, no longer masked.
    - A genuinely loose mount is now called **later** — 1.75–6.45 s at looseness 0.5, where it
      used to be 0.7 s — because the cue is no longer pre-charged by the artefact. It still reads
      `loose` for 93–99 % of the run. **This is a real cost, disclosed rather than tuned away: a
      driver with a bad mount gets told a few seconds further into their first corner.** If that
      matters on a real road, the fix is a faster cue, not a return to being right by accident.
  The lesson generalises past this entry. A UI guard sized to hide a symptom will outlive the
  symptom and hide the next one too; the 4 s warm-up existed for exactly as long as nobody asked
  why the first four seconds were wrong.
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
* **What a GPS dropout looks like.** The engine keeps scoring through a dropout, and measurement
  says it should: with the simulator's 2–6 s gaps the slip angle stays within 2.7° of truth on
  average (the error with a *live* fix is 1.4°), with no bias that would inflate the angle
  (+0.46° at 1–3 s, −2.9° at 5 s+, i.e. a long gap costs the driver rather than paying him).
  Past the estimator's `courseTimeoutS` (8 s) the course lock is gone, the state goes
  `valid:false`, and nothing is scored at all — measured 0 points and 0 counting samples beyond
  12 s of a forced total outage, by which point the error has grown to 17°. The threshold that
  matters is therefore the estimator's course timeout, not anything in the scorer.
  **Do not gate this on `betaSigma`:** it is well calibrated while the filter is healthy (p90
  error within a factor of 1.6 of sigma out to 6 s) and saturates at 3.0° once fixes stop, while
  the true error climbs to 24° — it stops being informative exactly where a gate would need to
  fire. Symptom that this needs re-deriving: a real dropout in a street canyon is not a clean
  absence of fixes but a stream of *bad* ones — large `hAcc`, plausible-looking wrong courses —
  which the simulator does not produce, so the 8 s figure is fitted to a clean model. Watch for
  scores accruing through canyon sections with `hAcc` in the tens of metres.
* **What a run survives.** Nothing in the app observes `AppState`, so a run has no idea it was
  ever interrupted. A phone call, a notification the driver taps, a passenger switching apps, or
  the screen locking all put the app in the background mid-recording, and what happens then is
  guessed rather than known. `app.json` declares `UIBackgroundModes: ["location"]` and
  `isIosBackgroundLocationEnabled: true`, and `NSLocationAlwaysAndWhenInUseUsageDescription`
  promises the driver that "a locked screen does not end the session" — but
  `deviceSensorSource.ts` only ever calls `requestForegroundPermissionsAsync()`. It never asks
  for the background permission the entitlement is there to use. That is a code fact, not a
  device unknown, and it is a defect: the app promises the driver something in a system prompt
  that it never requests the right to do.
  What only a phone can settle is the rest of it. CoreMotion keeps delivering in the background
  only while the process stays awake, which on iOS is a side effect of continuous location
  updates rather than a guarantee — so the motion stream may stop, may continue, or may resume
  with a jump, and the three are indistinguishable from here. **Symptom: a recording whose
  sample timestamps jump by seconds, or whose `dtEma` spikes, with no integrity note against it
  — the monitor currently has no concept of "the app was not running", so a hole in a run looks
  like a phone that was merely held badly.** The thing to measure on a real device is what
  arrives, in order, across a 30-second phone call taken mid-lap: whether motion samples
  continue, whether their timestamps stay on the same clock, and whether the GPS stream survives
  a locked screen at all.
* **Haptics.** Never exercised — the web harness has no haptic engine, so every callout's feel
  is unverified. Symptom: buzzing on every frame, or nothing at all. The vocabulary is verified
  against what SDK 57 declares and the requests are verified to be made; whether a Rigid tick on
  top of a Medium impact reads as crisp or as a stutter is unknown.
* **Whether the mix works against a car.** The sound bank is levelled to four RMS tiers spanning
  10.8 dB, which is a coherent design *on a meter*. Nobody has heard it at 60 km/h with road
  noise, tyre roar and the driver's own music mixed underneath. Two specific things could be
  wrong and cannot be told apart from here. The whole ladder may simply need shifting up. Or
  tier D — the quietest clip, at −27.9 dBFS, given to the event that fires on every drift
  precisely because it carries no news — may be inaudible in a moving car, in which case the
  honest answer to "carries no news" was never "quietest clip" but "no clip". **Symptom: a driver
  reporting they can hear the bank and the spin but have never noticed an initiation, or that
  they turned the sound off because it disappeared under the engine note.** Measure it by playing
  the bank in a moving car before changing a single level; the tiers are the design, so shifting
  them on a hunch throws the design away.
* **Whether an AVPlayer is audible within a frame.** The dispatch latency measured here (9 µs
  typical, 0.21 ms worst) stops at the port: everything after `play()` belongs to the OS audio
  stack, which this box does not have. Three things need a phone: whether a player created at
  mount really sounds within a frame of `play()`; whether the async `seekTo(0)` that rewinds a
  finished clip completes inside the tightest gap the bank allows; and whether a clip cut short
  by a screen teardown on web behaves the same on iOS, where the navigation animation may defer
  the unmount. Symptom: a callout that lands visibly before it lands audibly, or a repeated cue
  that swallows its own first syllable.
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
