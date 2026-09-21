/**
 * Default route list for `shoot.mjs`. Each entry:
 *   name          file stem for the screenshot / video
 *   path          URL path (+ query); `?sim=harbor&rate=1` picks the simulated sensor source
 *   waitMs        settle time after load + fonts before the screenshot (default 800)
 *   actions       optional steps run before the screenshot (see README: tap / wait / scroll / press / eval / waitFor / screenshot)
 *   expectCanvas  fail if no <canvas> (Skia) is present
 *   minEmber      fail if fewer ember-coloured pixels than this are visible (proves the ring rendered)
 *   fullPage      capture the full scroll height instead of the viewport
 *
 * The `/drive` routes capture MOMENTS, not t=0. `?at=<s>` warps the simulated recording to that
 * instant before anything is drawn and `?hold=1` freezes it there, so every HUD state below is
 * the same frame on every run — see tools/harness/README.md and `src/ui/hud/hudParams.ts`.
 * The times below are for `sim=harbor&seed=1&laps=2` and they MOVE when the engine is tuned
 * (the detector and the scorer decide when a callout fires). To re-derive them, push that run
 * through the pipeline and print the callout times — see tools/harness/README.md.
 */
/**
 * A long press, as a page script: react-native-web's press responder starts its long-press timer
 * on pointerdown, so a synthetic down / wait / up pair is a real long press to it. `tap()` cannot
 * hold, and the harness's action vocabulary is deliberately small.
 *
 * MOUSE EVENTS, not pointer and not touch. react-native-web's responder system listens on the
 * document for `mousedown` / `touchstart` (`useResponderEvents/ResponderSystem.js`) and ignores
 * pointer events entirely, so a synthetic `pointerdown` is a no-op — and an empty
 * `new TouchEvent('touchstart')` carries no `changedTouches`, which `createResponderEvent` reads
 * as `changedTouches[0].force`. That is where `TypeError: Cannot read properties of undefined
 * (reading 'force')` came from: the harness, not the app.
 */
function longPress(testId, ms = 700) {
  return `(async () => {
    const el = document.querySelector('[data-testid="${testId}"]');
    if (!el) throw new Error('no element ${testId}');
    const r = el.getBoundingClientRect();
    const at = { bubbles: true, cancelable: true, view: window, clientX: r.x + r.width / 2, clientY: r.y + 24, button: 0, buttons: 1, detail: 1 };
    el.dispatchEvent(new MouseEvent('mousedown', at));
    await new Promise((res) => setTimeout(res, ${ms}));
    el.dispatchEvent(new MouseEvent('mouseup', { ...at, buttons: 0 }));
  })()`;
}

export const defaultRoutes = [
  // ---- garage: the home screen ----------------------------------------------------------
  // `?demo=<set>` writes REAL sessions into storage before the list is drawn: each one is built
  // by the results fixture builder (simulator, and the real engine pipeline for the hand-held
  // one), scored by the real scorer and stored trimmed of its sample arrays. Every browser
  // context starts with empty storage, so `/` on its own IS the empty garage.
  // An empty garage that has to be inviting rather than apologetic.
  { name: 'home', path: '/', waitMs: 1200 },
  // Six runs across two tracks, newest first: the big last-run card, then the board, then rows.
  { name: 'garage', path: '/?demo=night', waitMs: 8000 },
  // Scrolled to the personal-best board: four records per track, empty tiles where nothing counts.
  { name: 'garage-bests', path: '/?demo=night', waitMs: 8000, actions: [{ type: 'scroll', y: 780 }, { type: 'wait', ms: 900 }] },
  // Scrolled to the run list, which is where the NOT SCORED row lives (the hand-held recording).
  { name: 'garage-runs', path: '/?demo=night', waitMs: 8000, actions: [{ type: 'scroll', y: 1400 }, { type: 'wait', ms: 900 }] },
  // One track, four scored runs: every record filled, nothing dashed out.
  { name: 'garage-bests-harbor', path: '/?demo=harbor', waitMs: 7000, actions: [{ type: 'scroll', y: 760 }, { type: 'wait', ms: 900 }] },
  // The demo bay at the bottom: the simulated source made selectable, looseness and dropouts included.
  { name: 'garage-simbay', path: '/?demo=first', waitMs: 6000, actions: [{ type: 'scroll', y: 1600 }, { type: 'wait', ms: 900 }] },
  // The ONLY state in which the garage mentions calibration: the last run was thrown out, so it
  // says what was wrong (the monitor's own words) and offers the screen that fixes it.
  { name: 'garage-flagged', path: '/?demo=flagged', waitMs: 8000 },
  // Deleting asks first — a long press on a row opens the app's own confirmation (Alert is a
  // no-op on web, so the question has to be the app's own).
  {
    name: 'garage-delete',
    path: '/?demo=first',
    waitMs: 6000,
    actions: [
      { type: 'waitFor', testId: 'last-run' },
      { type: 'eval', js: longPress('last-run') },
      { type: 'wait', ms: 900 },
    ],
  },

  // ---- calibrate: phone in hand to "this app can measure my car" -------------------------
  // `?at=<s>` feeds the calibrator that many seconds of the recording at once and `?hold=1`
  // stops there, so each state below is the same frame every run. The times come from the real
  // calibrator on `sim=harbor&seed=1`: the vertical settles at ~1.5 s, the forward axis resolves
  // at 5.31 s, and confidence plateaus at 0.74 (see tools/harness/README.md).
  // ZERO samples — `hold=1` with no `at`, so the recording is armed and never fed. The screen
  // has nothing to report and must say exactly that: this frame used to read CALIBRATED /
  // "Ready to measure" over dashes and a red "No reading" light, because `IntegrityMonitor`
  // starts with `calibrationOk` true so that it cannot veto a run it knows nothing about.
  { name: 'calibrate-nothing', path: '/calibrate?sim=harbor&hold=1', waitMs: 2200, expectCanvas: true },
  // At rest, half a second in: gravity seen, nothing worked out yet.
  { name: 'calibrate', path: '/calibrate?sim=harbor&at=0.5&hold=1', waitMs: 2200, expectCanvas: true },
  // Vertical settled (up-axis 85 %), forward axis still unresolved — the state the screen exists for.
  { name: 'calibrate-level', path: '/calibrate?sim=harbor&at=3&hold=1', waitMs: 2200, expectCanvas: true },
  // Calibrated: past the bar the judge uses, both axes resolved.
  { name: 'calibrate-ready', path: '/calibrate?sim=harbor&at=12&hold=1', waitMs: 2400, expectCanvas: true },
  // A hand-held phone, from a REAL hand-held recording (`looseness=1`): the monitor's own words.
  { name: 'calibrate-loose', path: '/calibrate?sim=harbor&looseness=1&dropouts=1&at=12&hold=1', waitMs: 2400, expectCanvas: true },
  // The phone lying flat, from a recording the simulator really put on the console.
  { name: 'calibrate-flat', path: '/calibrate?sim=harbor&mount=flat-console&at=12&hold=1', waitMs: 2400, expectCanvas: true },
  // Arrived here because a run was thrown out (`?why=`): the screen leads with that, not with
  // a generic invitation. This is how a driver normally reaches this screen at all.
  { name: 'calibrate-rejected', path: '/calibrate?sim=harbor&looseness=1&dropouts=1&at=12&hold=1&why=rejected', waitMs: 2400, expectCanvas: true },
  // The four faults. They are the whole reason this screen exists now, and none of them is
  // reachable in a browser without `?fault=` (the drive display's `?integrity=` for the same
  // reason). No canvas: the screen never starts the sensors in this state.
  { name: 'calibrate-fault-permission', path: '/calibrate?fault=permission', waitMs: 1200 },
  { name: 'calibrate-fault-unsupported', path: '/calibrate?fault=unsupported', waitMs: 1200 },
  { name: 'calibrate-fault-services', path: '/calibrate?fault=services', waitMs: 1200 },
  { name: 'calibrate-fault-failed', path: '/calibrate?fault=failed', waitMs: 1200 },

  // ---- drive: the live HUD at the moments that matter -----------------------------------
  // The instant the screen opens. There is no GO gate: entering /drive IS the arming step, so
  // this is the first frame of a live run — gauge at rest, clock at zero, nothing claimed.
  { name: 'drive-open', path: '/drive?sim=harbor&rate=1&at=0.3&hold=1', waitMs: 2400, expectCanvas: true, minEmber: 100 },
  // The first seconds of EVERY run: the calibrator has not resolved which way the car points and
  // there is no fix yet. Calm cyan FINDING FORWARD, gauge muted, score not counting.
  { name: 'drive-start', path: '/drive?sim=harbor&rate=1&at=2.2&hold=1', waitMs: 2600, expectCanvas: true, minEmber: 200 },
  // LIVE (the route to record video of): warped to 38 s and left running, so the shot lands on
  // the MANJI flick at 42.4 s and EXTREME ANGLE at 42.8 s, and the video covers the whole flick.
  { name: 'drive', path: '/drive?sim=harbor&rate=1&at=39.2', waitMs: 3200, expectCanvas: true, minEmber: 2000 },
  // HELD 20 ms after EXTREME ANGLE in the second lap's long drift: 48° right, ×4.5, 22,675
  // points with 7,927 at risk, 47 km/h, three callouts stacked, peak 50°, 23.9 s held.
  { name: 'drive-peak', path: '/drive?sim=harbor&rate=1&at=100.85&hold=1', waitMs: 2800, expectCanvas: true, minEmber: 2000 },
  // HELD 190 ms after TRANSITION ×2, mid-swing through zero: 40° left, chevron flipped, ×2.75.
  { name: 'drive-transition', path: '/drive?sim=harbor&rate=1&at=85.55&hold=1', waitMs: 2800, expectCanvas: true, minEmber: 800 },
  // HELD just after a 10,528-point chain banked and the next drift opened with LINK ×3.
  { name: 'drive-bank', path: '/drive?sim=harbor&rate=1&at=50.75&hold=1', waitMs: 2800, expectCanvas: true, minEmber: 1200 },
  // A REAL hand-held phone (`looseness=1` goes through the simulator, not through the view):
  // the mount reads loose, so the gauge is drawn muted with no bloom and the score block says
  // NOT SCORING — the HUD must not celebrate an angle the scorer has already thrown away.
  { name: 'drive-loose', path: '/drive?sim=harbor&looseness=1&rate=1&at=21.5&hold=1', waitMs: 2800, expectCanvas: true, minEmber: 100 },
  // The same run 0.2 s after the slide became a spin: CHAIN LOST, the chain bar emptied.
  { name: 'drive-lost', path: '/drive?sim=harbor&looseness=1&rate=1&at=21.95&hold=1', waitMs: 2800, expectCanvas: true, minEmber: 100 },
  // A REAL GPS dropout (`dropouts=1`), 1.2 s into the second gap: GPS LOST is severe here
  // because a fix HAS been held before — "no fix yet" at the start of a run is not an alarm.
  { name: 'drive-gps', path: '/drive?sim=harbor&dropouts=1&rate=1&at=24.6&hold=1', waitMs: 2800, expectCanvas: true, minEmber: 100 },
  // STOP on a run that never left walking pace: it is the walk to the car, not a session, so the
  // HUD says so instead of filing it or dropping the driver into the garage with no word.
  {
    name: 'drive-discarded',
    path: '/drive?sim=harbor&rate=1&at=0.3&hold=1',
    waitMs: 2400,
    expectCanvas: true,
    actions: [{ type: 'tap', testId: 'cta-stop', timeout: 30000 }, { type: 'wait', ms: 1200 }],
  },
  // STOP on a REAL run whose write then fails. The failure is made the way the device makes it —
  // `Storage.prototype.setItem` throws QuotaExceededError, which is exactly what a full
  // localStorage does — so `src/platform/storage.ts` raises its own StorageError and the HUD has
  // to hand back the verdict rather than stranding a finished run behind a dialog.
  {
    name: 'drive-savefail',
    path: '/drive?sim=harbor&rate=1&at=100.85&hold=1',
    waitMs: 2800,
    expectCanvas: true,
    actions: [
      { type: 'eval', js: "Storage.prototype.setItem = function () { const e = new Error('disk is full'); e.name = 'QuotaExceededError'; throw e; };" },
      { type: 'tap', testId: 'cta-stop', timeout: 30000 },
      { type: 'wait', ms: 1400 },
    ],
  },

  // ---- results: the verdict screen ------------------------------------------------------
  // `?fixture=<name>` (or the id `fixture-<name>`) rebuilds a deterministic session from the
  // simulator and scores it with the real scorer, so every shot below reproduces byte for byte.
  // `?reveal=` plays (full), skips (off) or FREEZES a frame of the grade reveal.
  // the reveal playing end to end — shoot this one with --video and pull frames out with ffmpeg
  { name: 'results-reveal', path: '/results/fixture-hero', waitMs: 3400 },
  // the reveal is skippable: tap anywhere during it and the page is there, already settled
  // frozen at the slam, then tapped: proves a tap ends the reveal and hands over an interactive,
  // settled page (tapping a frozen frame keeps the shot deterministic — no 2-second window to hit)
  {
    name: 'results-skip',
    path: '/results/fixture-hero?reveal=slam',
    waitMs: 1600,
    actions: [{ type: 'tap', testId: 'reveal-skip' }, { type: 'wait', ms: 1200 }],
  },
  { name: 'results-reveal-hold', path: '/results/fixture-hero?reveal=hold', waitMs: 1600 },
  { name: 'results-reveal-slam', path: '/results/fixture-hero?reveal=slam', waitMs: 2200, expectCanvas: true, minEmber: 300 },
  { name: 'results', path: '/results/fixture-hero?reveal=off', waitMs: 2000, minEmber: 1500 },
  { name: 'results-sloppy', path: '/results/fixture-sloppy?reveal=off', waitMs: 2000 },
  { name: 'results-spin', path: '/results/fixture-spin?reveal=off', waitMs: 2000 },
  { name: 'results-clean', path: '/results/fixture-clean?reveal=off', waitMs: 2000 },
  { name: 'results-best', path: '/results/fixture-hero?reveal=off', waitMs: 2000, actions: [{ type: 'scroll', y: 1150 }, { type: 'wait', ms: 900 }] },
  { name: 'results-drifts', path: '/results/fixture-spin?reveal=off', waitMs: 2000, actions: [{ type: 'scroll', y: 2200 }, { type: 'wait', ms: 900 }] },
  { name: 'results-laps', path: '/results/fixture-sloppy?reveal=off', waitMs: 2000, actions: [{ type: 'scroll', y: 4200 }, { type: 'wait', ms: 900 }] },
  // the refusal state: a hand-held recording the engine will not publish a score for
  { name: 'results-untrusted', path: '/results/fixture-handheld?reveal=off', waitMs: 3600 },
  { name: 'results-untrusted-foot', path: '/results/fixture-handheld?reveal=off', waitMs: 3600, actions: [{ type: 'scroll', y: 2600 }, { type: 'wait', ms: 900 }] },
  // the warned-but-scored run: its hero carries the PIPELINE's grade (B), which is what the
  // garage row and the end of the replay show — a re-score from storage would have said A
  {
    name: 'results-integrity',
    path: '/results/fixture-rough?reveal=off',
    waitMs: 2000,
    actions: [{ type: 'screenshot', name: 'results-warned' }, { type: 'scroll', y: 5200 }, { type: 'wait', ms: 900 }],
  },
  // the same screen fed by the REAL engine pipeline (mount → slip → detector → scorer), not ground truth
  { name: 'results-pipeline', path: '/results/fixture-good?reveal=off&source=pipeline', waitMs: 3600 },
  // reduce-motion: state changes keep, shake and embers go
  { name: 'results-reduced', path: '/results/fixture-hero?reveal=hold&motion=reduce', waitMs: 2000 },
  { name: 'results-missing', path: '/results/no-such-session', waitMs: 1200 },
  // ---- replay: the cinematic stage -------------------------------------------------------
  // The scene comes from `src/engine/replay` and is drawn in Skia by `src/ui/replay/scene.ts`.
  // `/replay/<id>` plays a STORED session; `/replay/demo` (or `?fixture=`) rebuilds the same
  // deterministic fixture the results screen uses, so every frame below reproduces exactly.
  // `play=0` freezes a moment, `ui=1` pins the transport and `ui=0` hides it (which is what the
  // app itself does a few seconds into playback, so those frames are the watching state), `cam=`
  // picks the camera — the full
  // parameter table is in tools/harness/README.md. Times are for the `good` fixture and MOVE
  // when the detector or the scorer is retuned.
  // LIVE, chase camera, a moment before TRANSITION x3 fires: this is the one to record video of
  // (the callout slam, the shake, the smoke and the camera cut only exist in motion). The times
  // sit close to their beats on purpose — this scene draws at a fraction of a frame a second in
  // the harness's software rasteriser, so a live route advances about a second of replay in the
  // few seconds it is watched.
  { name: 'replay', path: '/replay/demo?cam=chase&t=94.9', waitMs: 3000, expectCanvas: true, minEmber: 1500 },
  // MOTION, at quarter speed: the frame the callout slams in on. Shoot this one with --video and
  // --scale 1 — the harness's software rasteriser (SwiftShader) draws this full-bleed scene at
  // about 6 fps at 1x and 1.5 fps at 3x, so a quarter-speed pass is what resolves a 320 ms slam
  // and a 180 ms shake into frames. The motion is the app's own, sampled finer.
  { name: 'replay-motion', path: '/replay/demo?cam=chase&t=95&rate=0.25&ui=0', waitMs: 5000, expectCanvas: true, minEmber: 1200 },
  // A CAMERA CUT driven by the control, at quarter speed: chase, then CINE 1.2 s in. The engine
  // makes a mode switch a cut with a 120 ms cross-fade; the video shows it.
  // `cutTo`/`cutAt` fire the same mode switch the CINE control fires, off the replay clock: a
  // synthetic tap on a control drawn over this canvas waits tens of seconds for the element to
  // "hold still" at a few frames a second, which is a property of the rasteriser, not the app.
  { name: 'replay-cut', path: '/replay/demo?cam=chase&t=95.5&rate=0.25&cutTo=cinematic&cutAt=95.65&ui=0', waitMs: 6000, expectCanvas: true, minEmber: 800 },
  // The SHAKE, at quarter speed, from TRACK CAM where the camera itself is still: the exit beat
  // at 99.98 s carries magnitude 1, and `shakeAt` throws the whole world +/- 2.4 pt for 180 ms.
  { name: 'replay-shake', path: '/replay/demo?cam=overview&t=99.9&rate=0.25&ui=0', waitMs: 4000, expectCanvas: true, minEmber: 1200 },
  // TRACK CAM at the half-way point: the whole circuit, the played line only, drift peaks blooming.
  { name: 'replay-overview', path: '/replay/demo?cam=overview&t=60&play=0&ui=0', waitMs: 2600, expectCanvas: true, minEmber: 1500 },
  // CHASE at the peak of the 3-link chain in lap 2: 54 deg, ember ribbon, smoke, slip arc.
  { name: 'replay-chase', path: '/replay/demo?cam=chase&t=95.9&play=0&ui=1', waitMs: 2600, expectCanvas: true, minEmber: 2000 },
  // CINEMATIC 120 ms after TRANSITION x3 fired: the magenta chip, the callout mid-hold.
  { name: 'replay-cinematic', path: '/replay/demo?cam=cinematic&t=39.14&play=0&ui=0', waitMs: 2600, expectCanvas: true, minEmber: 800 },
  // The best-lap ghost, far enough off the line to be a car rather than a badge (the `rough`
  // fixture is the REAL pipeline, so its two laps genuinely differ).
  { name: 'replay-ghost', path: '/replay/x?fixture=rough&cam=chase&t=18&play=0&ui=0', waitMs: 3600, expectCanvas: true, minEmber: 800 },
  // A highlight jump: the transport lands on the best moment of the run and names it.
  { name: 'replay-highlight', path: '/replay/demo?hl=1&play=0&cam=chase&ui=1', waitMs: 2600, expectCanvas: true, minEmber: 1200 },
  // The scrubber MID-DRAG. `scrub=<0..1>` opens with the playhead GRABBED at that fraction: the
  // same shared values a real drag writes (scrubbing = 1, the clock following the finger), so the
  // frame is the held state — fat playhead, time bubble, camera cut to the new moment. A
  // synthetic pointer sequence cannot be used here: react-native-gesture-handler calls
  // setPointerCapture, which throws for a pointer id the browser never issued.
  { name: 'replay-scrub', path: '/replay/demo?cam=chase&scrub=0.36&ui=1', waitMs: 2600, expectCanvas: true, minEmber: 800 },
  // A hand-held recording: it still replays, and it must not present points or a grade.
  // deliberately almost ember-free: on a recording the engine does not believe, the slip angle
  // loses its escalation colours along with the points, so `minEmber` is only a "something drew"
  // floor here
  { name: 'replay-untrusted', path: '/replay/fixture-handheld?cam=chase&t=17&play=0&ui=0', waitMs: 4200, expectCanvas: true, minEmber: 150 },
  // Bad data: `gaps=6` blanks six seconds of recorded position (a tunnel), so buildReplay's own
  // warnings fire and the dead-reckoned stretch is dashed instead of glowing.
  { name: 'replay-warnings', path: '/replay/x?fixture=rough&gaps=6&cam=overview&t=62&play=0&ui=0', waitMs: 3600, expectCanvas: true, minEmber: 1200 },
  // The warnings plate opened: the sentences behind the red plate.
  {
    name: 'replay-warnings-open',
    path: '/replay/x?fixture=rough&gaps=6&cam=chase&t=56&play=0&ui=1',
    waitMs: 3600,
    expectCanvas: true,
    actions: [{ type: 'tap', testId: 'replay-warn-toggle', timeout: 60000 }, { type: 'wait', ms: 700 }],
  },
  // The last frame: the grade lands only once the run is over.
  { name: 'replay-end', path: '/replay/demo?cam=overview&t=999&play=0&ui=0', waitMs: 2600, expectCanvas: true, minEmber: 1500 },
  // The deep link the results screen pushes, end to end: scroll to the best drift, tap REPLAY
  // THIS DRIFT, and land in the replay at that moment with the drift picked out.
  {
    name: 'replay-from-results',
    path: '/results/fixture-good?reveal=off',
    waitMs: 2600,
    // no `expectCanvas`: the check runs on the page that is LOADED, and that is the results
    // screen, which has no canvas once its reveal is off
    actions: [
      { type: 'scroll', y: 1150 },
      { type: 'wait', ms: 700 },
      { type: 'tap', testId: 'cta-watch-best', timeout: 60000 },
      { type: 'waitFor', testId: 'screen-replay', timeout: 60000 },
      { type: 'wait', ms: 2000 },
    ],
  },
  // A point-to-point stage: no laps, so no lap ticks and no ghost — STAGE, not LAP 1/2.
  { name: 'replay-touge', path: '/replay/x?fixture=touge&cam=cinematic&t=69.2&play=0&ui=0', waitMs: 2800, expectCanvas: true, minEmber: 1200 },
  { name: 'settings', path: '/settings', waitMs: 900 },

  // ---- /sound: the feel lab ---------------------------------------------------------------
  // Every clip in the bank drawn and playable, the continuous layer on a slider, the mixer's own
  // decision log. A browser will not start an AudioContext before the page is touched, so the
  // first frame is the LOCKED state — which is the state that must not put anything in the
  // console. The second shoots it after a real tap on a play button: the context resumes, the
  // clip is dispatched and the decision log names what happened to it.
  { name: 'sound', path: '/sound', waitMs: 2600 },
  {
    name: 'sound-played',
    path: '/sound',
    waitMs: 2600,
    actions: [
      { type: 'tap', testId: 'play-transition', timeout: 30000 },
      { type: 'wait', ms: 400 },
      { type: 'tap', testId: 'seq-mud', timeout: 30000 },
      { type: 'wait', ms: 900 },
      { type: 'scroll', y: 260 },
      { type: 'wait', ms: 600 },
    ],
  },
  // The bank itself, scrolled to the clip rows: waveform, levels, priority, haptic, rationale.
  { name: 'sound-bank', path: '/sound', waitMs: 2600, actions: [{ type: 'scroll', y: 1500 }, { type: 'wait', ms: 700 }] },
  // The continuous layer open: 40 degrees of slip held, the two bed gains on their meters.
  {
    name: 'sound-slide',
    path: '/sound',
    waitMs: 2600,
    actions: [
      { type: 'waitFor', testId: 'bed-40' },
      { type: 'eval', js: "document.querySelector('[data-testid=\"bed-40\"]').click()" },
      { type: 'wait', ms: 1400 },
      { type: 'tap', testId: 'bed-40', timeout: 30000 },
      { type: 'wait', ms: 800 },
    ],
  },
  // The gate, on screen: sound switched off, then a cue that the mixer refuses.
  {
    name: 'sound-muted',
    path: '/sound',
    waitMs: 2600,
    actions: [
      { type: 'waitFor', testId: 'lab-sound' },
      // A plain `.click()` on the OFF segment: react-native-web's Pressable installs a click
      // handler for accessibility roles, and a synthetic mousedown/mouseup pair does NOT reach
      // it (verified against this page — the setting did not move).
      { type: 'eval', js: "document.querySelectorAll('[data-testid=\"lab-sound\"] [role=\"radio\"]')[1].click()" },
      { type: 'wait', ms: 500 },
      { type: 'tap', testId: 'seq-flick', timeout: 30000 },
      { type: 'wait', ms: 700 },
      // Back to the top, where the status panel names what the mixer did with that cue.
      { type: 'scroll', y: -4000 },
      { type: 'wait', ms: 600 },
    ],
  },

  // ---- results in landscape ---------------------------------------------------------------
  // Shoot these with `--landscape`. The verdict screen is not one column stretched wide there:
  // the grade, the total, the scale and the three actions dock in a fixed rail on the left and
  // the report scrolls in the column beside it (`src/ui/results/layout.ts`). That column is
  // narrower than a portrait page, so the same section sits at a different scroll depth — hence
  // these entries rather than reusing `results-best` / `results-drifts` / `results-laps` with
  // the flag. In portrait they land a little further down the same page and are still valid
  // frames, just not the ones they are named for.
  { name: 'results-wide-breakdown', path: '/results/fixture-hero?reveal=off', waitMs: 2000, actions: [{ type: 'scroll', y: 300 }, { type: 'wait', ms: 900 }] },
  { name: 'results-wide-best', path: '/results/fixture-hero?reveal=off', waitMs: 2000, actions: [{ type: 'scroll', y: 1080 }, { type: 'wait', ms: 900 }] },
  { name: 'results-wide-drifts', path: '/results/fixture-spin?reveal=off', waitMs: 2000, actions: [{ type: 'scroll', y: 2150 }, { type: 'wait', ms: 900 }] },
  { name: 'results-wide-laps', path: '/results/fixture-sloppy?reveal=off', waitMs: 2000, actions: [{ type: 'scroll', y: 3000 }, { type: 'wait', ms: 900 }] },
  // The handoff frame: the reveal's letter on its way to the hero letter's place, which is in
  // the rail in landscape and at the top of the column in portrait.
  { name: 'results-reveal-settle', path: '/results/fixture-hero?reveal=settle', waitMs: 2000 },
  // The refusal with its reasoning opened. The screen leads with the one line the driver can act
  // on and the recording; every integrity note is still there, verbatim, one tap behind this
  // control — these two frames are the proof that nothing was softened, only reordered.
  { name: 'results-why-open', path: '/results/fixture-handheld?reveal=off', waitMs: 3600, actions: [{ type: 'tap', testId: 'why-unscored', timeout: 30000 }, { type: 'wait', ms: 800 }] },
  {
    name: 'results-why-foot',
    path: '/results/fixture-handheld?reveal=off',
    waitMs: 3600,
    actions: [{ type: 'tap', testId: 'why-unscored', timeout: 30000 }, { type: 'wait', ms: 800 }, { type: 'scroll', y: 480 }, { type: 'wait', ms: 700 }],
  },
  // ---- calibrate: the states the 6.5/10 critique named ------------------------------------
  // Appended, not inserted: the block above is what other agents' reports already point at.
  // A location permission that was DENIED is not a motion permission that was denied. The one
  // `permission-denied` code sent this frame to "Motion access is off / Turn on Motion &
  // Fitness" — the driver told to fix the sensor that already works.
  { name: 'calibrate-fault-location', path: '/calibrate?fault=location', waitMs: 1200 },
  // The mount is shaking but not loose: everything else has resolved and the confidence sits in
  // the low thirties. This frame read CALIBRATED / "Ready to measure" directly above a gold
  // MOUNT LOOKS UNSTEADY. Measured across seeds with
  // `npx tsx tools/analysis/calibration-sweep.ts suspect`.
  { name: 'calibrate-shaking', path: '/calibrate?sim=touge&looseness=0.2&at=40&hold=1', waitMs: 2400, expectCanvas: true },
  // Two seconds into a genuinely hand-held recording: inside the 4 s mount warm-up, so the
  // monitor has NOT decided. Step 01 used to be struck through with a green tick here while the
  // mount light beside it still read "Listening".
  { name: 'calibrate-early', path: '/calibrate?sim=harbor&looseness=1&dropouts=1&at=2&hold=1', waitMs: 2400, expectCanvas: true },
  // ---- drive display, appended ------------------------------------------------------------
  // BETWEEN slides with the chain still open: 48.5 s, 10 528 points at risk, two slides done.
  // The middle band is the one that used to go dark here (0.71 % lit on an idle frame), and the
  // coaching line that used to be 11 px is the thing to read in this shot.
  { name: 'drive-chain', path: '/drive?sim=harbor&rate=1&at=48.5&hold=1', waitMs: 2800, expectCanvas: true, minEmber: 200 },
  // The warn tier, via the presentation-only `?integrity=` override: MOUNT SHAKING over a clean
  // recording. `drive-warn.png` existed with no route behind it, so it had gone stale; it is now
  // shot again, and it is where the chain bar and the integrity note appear TOGETHER (a note
  // used to replace the bar, taking AT RISK off the screen exactly when it mattered).
  { name: 'drive-warn', path: '/drive?sim=harbor&rate=1&at=100.85&hold=1&integrity=suspect', waitMs: 2800, expectCanvas: true, minEmber: 1000 },
  // ---- the feel layer's settings, appended ------------------------------------------------
  // The Feedback section, which is below the fold on `settings`: the two switches and the way
  // through to the lab. A switch is a stronger claim than a label, so this screen has to be able
  // to make good on it without a drive.
  { name: 'settings-feedback', path: '/settings', waitMs: 900, actions: [{ type: 'scroll', y: 900 }, { type: 'wait', ms: 700 }] },
  // ---- garage: the state the run list cannot be read in, appended --------------------------
  // With one perfectly readable recording on disk and a TRUNCATED index, the garage used to draw
  // "THE GARAGE · EMPTY · FIRST RUN · NOTHING TO BEAT YET" — and the next save then wrote a fresh
  // one-entry index over the top and orphaned every stored body permanently. Seed one real run,
  // truncate the index, then load `/` with no `?demo=` so nothing re-seeds over the evidence.
  {
    name: 'garage-index-broken',
    path: '/?demo=first',
    waitMs: 6000,
    actions: [
      { type: 'waitFor', testId: 'last-run', timeout: 30000 },
      { type: 'eval', js: 'localStorage.setItem("dom.sessions.index.v1", localStorage.getItem("dom.sessions.index.v1").slice(0, 40))' },
      { type: 'goto', path: '/' },
      { type: 'wait', ms: 1800 },
    ],
  },
  // ... and the repair, which reads the recordings themselves and writes a new list.
  {
    name: 'garage-index-rebuilt',
    path: '/?demo=first',
    waitMs: 6000,
    actions: [
      { type: 'waitFor', testId: 'last-run', timeout: 30000 },
      { type: 'eval', js: 'localStorage.setItem("dom.sessions.index.v1", localStorage.getItem("dom.sessions.index.v1").slice(0, 40))' },
      { type: 'goto', path: '/' },
      { type: 'wait', ms: 1500 },
      { type: 'tap', testId: 'cta-rebuild-index', timeout: 30000 },
      { type: 'wait', ms: 2000 },
    ],
  },
  // The run list at LANDSCAPE depth. `garage-runs` scrolls 1400 px, which is right in portrait and
  // lands on the demo bay in landscape, where the two-column layout is barely half as tall — so
  // the run list had no landscape frame at all. 1020 px puts the rows at the top of both.
  { name: 'garage-runs-wide', path: '/?demo=night', waitMs: 8000, actions: [{ type: 'scroll', y: 1020 }, { type: 'wait', ms: 900 }] },

  // THE VERDICT LANDING. The grade reveal is a motion beat — the letter slams 2.2 → 1.0 with a
  // shockwave ring and ember particles over the last 1.1 s of the run — so it only exists as
  // frames. Quarter speed from just before it starts, `play=1`, and the run stops itself at the
  // end: shoot with --video (and --scale 1, like the other motion routes) to resolve the slam.
  { name: 'replay-grade', path: '/replay/demo?cam=overview&t=118.2&rate=0.25&play=1&ui=0', waitMs: 11000, expectCanvas: true, minEmber: 800 },
  // ---- garage: the two states the slide count exists for, appended -------------------------
  // A night that ENDED on the scruffy run: eleven slides, three of them spun. "SLIDES 11" with
  // no mention of the spins was a finding, and `night` ends on a clean run, so the fix had
  // nowhere to appear. This is the frame it appears in ("8 of 11 · 3 spun").
  { name: 'garage-spun', path: '/?demo=spun', waitMs: 7000 },
  // The hand-held card's own numbers, one viewport down: angle, slides and points all `--` on a
  // run the monitor did not believe, over a trace drawn hollow and captioned as a recording.
  { name: 'garage-flagged-stats', path: '/?demo=flagged', waitMs: 8000, actions: [{ type: 'scroll', y: 300 }, { type: 'wait', ms: 900 }] },

  // THE SPIN, which is the whole reason the replay and the results screen disagreed. The engine
  // marks drift #6 of the `spin` fixture as a spin and the scorer takes its chain away; these
  // three frames are where that has to be visible. 97.55 s is inside the spin beat's hold
  // (LOST IT 118°, red); 98.10 s is inside the exit beat that follows it (CHAIN LOST −N, fired a
  // beat later exactly as the live HUD fires it); and the last frame carries the grade and the
  // total, which must be the number the results screen prints for the same session.
  { name: 'replay-spin', path: '/replay/fixture-spin?cam=chase&t=97.55&play=0&ui=0', waitMs: 3200, expectCanvas: true, minEmber: 400 },
  { name: 'replay-chain-lost', path: '/replay/fixture-spin?cam=chase&t=98.1&play=0&ui=0', waitMs: 3200, expectCanvas: true, minEmber: 400 },
  // no `minEmber`: this run grades B, the reveal's letter and label are CYAN, and the world
  // behind them is dimmed to 42 % for the slam — an ember floor would be a check on the grade
  { name: 'replay-spin-end', path: '/replay/fixture-spin?cam=overview&t=999&play=0&ui=0', waitMs: 3200, expectCanvas: true },

  // ---- /sound: the rows that have no clip, and the two the run hopes never to need ---------
  // THE LANDING. The exit phase edge is the one row in the bank with no file: a light haptic and
  // nothing to hear, because docs/DESIGN.md gives the exit a haptic and leaves the sound to the
  // bed's own release — and because a driver with the phone on silent still has to feel a slide
  // end. The row says FELT where the others say PLAY, and this is the frame that shows it.
  {
    name: 'sound-felt',
    path: '/sound',
    waitMs: 2600,
    actions: [
      { type: 'waitFor', testId: 'clip-exit-edge' },
      { type: 'eval', js: "document.querySelector('[data-testid=\"clip-exit-edge\"]').scrollIntoView({ block: 'center' })" },
      { type: 'wait', ms: 700 },
    ],
  },
  // THE FAULT PAIR. A hand-held run offers the mixer 56 cues and plays none of them; these two
  // rows are the one sound that says why, and the one that says it is over.
  {
    name: 'sound-fault',
    path: '/sound',
    waitMs: 2600,
    actions: [
      { type: 'waitFor', testId: 'clip-fault' },
      { type: 'eval', js: "document.querySelector('[data-testid=\"clip-fault\"]').scrollIntoView({ block: 'start' })" },
      { type: 'wait', ms: 700 },
    ],
  },
  // THE TWO GRADE RENDERS, side by side at the end of the bank: the gold one for S/A/B and the
  // unlit one for C/D, same figure, same length, same tier, measurably darker.
  {
    name: 'sound-grades',
    path: '/sound',
    waitMs: 2600,
    actions: [
      { type: 'waitFor', testId: 'clip-grade-low' },
      { type: 'eval', js: "document.querySelector('[data-testid=\"clip-grade\"]').scrollIntoView({ block: 'start' })" },
      { type: 'wait', ms: 700 },
    ],
  },
];
