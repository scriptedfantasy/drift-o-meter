/**
 * Default route list for `shoot.mjs`. Each entry:
 *   name          file stem for the screenshot / video
 *   path          URL path (+ query); `?sim=harbor&rate=1` picks the simulated sensor source
 *   waitMs        settle time after load + fonts before the screenshot (default 800)
 *   actions       optional steps run before the screenshot (see README: tap / wait / scroll / press / eval / waitFor / screenshot)
 *   expectCanvas  fail if no <canvas> (Skia) is present
 *   minEmber      fail if fewer ember-coloured pixels than this are visible (proves the ring rendered)
 *   regions       per-colour counts inside one rectangle, each with a `max` and/or a `min`:
 *                 `{ name, colour, testId | rect, padFrac, max, min }`. A CEILING is the only
 *                 shape of check that can certify an ABSENCE (see the header of pixels.mjs), and
 *                 `testId` keeps it pointed at the same thing when the layout moves.
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


/**
 * "The gauge box is cold / hot", as a region check.
 *
 * `testId` rather than a hand-written rectangle: the harness measures the element and hands
 * `pixels.mjs` its box, so the same check means the same thing portrait, landscape and at any
 * device scale, and it cannot quietly start measuring a different band when a row changes
 * height. `padFrac` takes in a little of the bloom that spills past the canvas.
 *
 * THE CEILING IS THE POINT. A minimum proves something drew; only a maximum, measured in the
 * region the claim is about, proves something did NOT. The floor on a muted route measured
 * 30 591 "ember" pixels that were the red banner and the red STOP, and a different moment of the
 * same kind of run drew 63 983 genuine ember pixels inside the gauge on a run worth zero points —
 * which would have passed any floor in this file.
 *
 * 120 is above the harness's own noise floor and far below anything drawn: Chromium renders DOM
 * text with subpixel antialiasing, which leaves a few hundred warm fringe pixels along glyph
 * edges anywhere on the screen. The gauge is SKIA, drawn with greyscale antialiasing, so its box
 * measures 0 ember when the dial is muted and tens of thousands when it is not.
 */
function gaugeIsCold(max) {
  return { name: 'gauge', colour: 'ember', testId: 'hud-gauge-box', padFrac: 0.01, max };
}
function gaugeIsHot(min) {
  return { name: 'gauge', colour: 'ember', testId: 'hud-gauge-box', padFrac: 0.01, min };
}
/**
 * The same two checks on the g-meter's own box. Both instruments obey the same rule — an
 * instrument does not draw hot for a reading the engine has already thrown away — and a ceiling
 * on one of them certifies nothing about the other, which is how the g-meter could have shipped
 * blazing on a hand-held phone under a green `drive-loose`.
 */
function gIsCold(max) {
  return { name: 'g', colour: 'ember', testId: 'hud-g-box', padFrac: 0.01, max };
}
function gIsHot(min) {
  return { name: 'g', colour: 'ember', testId: 'hud-g-box', padFrac: 0.01, min };
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
  {
    name: 'garage',
    path: '/?demo=night',
    waitMs: 8000,
    // The other half of the same claim, as a maximum: this run spun nothing, so the plot holds
    // no footprint ink at all. Red inside `last-run-plot` is what a spin draws.
    regions: [{ name: 'trace-spins', colour: 'red', testId: 'last-run-plot', padFrac: 0.004, max: 0 }],
  },
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
  // calibrator on `sim=harbor&seed=1`: the vertical settles at 1.62 s, the mount cues fill their
  // window at 2.02 s, the forward axis resolves at 5.31 s, and confidence PEAKS at 0.740 at
  // 6.34 s and eases to 0.698 by the end — it does not plateau, and 0.74 is this seed's peak
  // rather than a ceiling. The disproven ceiling is why `docs/DESIGN.md` carries a correction
  // block; tools/harness/README.md has the 48-run spread (0.618–0.864, median 0.750).
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

  // ---- drive: the live display at the moments that matter --------------------------------
  //
  // THE SCREEN IS THREE THINGS: the angle gauge, the g-meter and STOP. The status strip,
  // integrity banner, drift strip, callout stack, score odometer, multiplier chip, chain bar,
  // telemetry row and mini-map were all taken off it — a driver at 60 km/h has no time to read
  // any of them — so every check below names an ELEMENT, and the frame-wide `minEmber` that used
  // to stand in for one is gone. It measured a screen whose ember came mostly from the score
  // block; with that block gone it measures the gauge plus the edge bloom plus the g-meter, all
  // mixed, and a frame-wide floor can be cleared by any one of them while the other two are
  // dead. `regions` anchors each count to `hud-gauge-box` or `hud-g-box` instead.
  //
  // TWO INSTRUMENTS, ONE HONESTY RULE. Neither draws hot for a reading the engine has already
  // thrown away: every opacity in `AngleGauge.tsx` (`glowOpacity`, `bowlOpacity`, `dimmed`) and
  // in `GMeter.tsx` (`glow`, `bowlOpacity`, `dimmed`) scales with `signals.trust`. Measured at
  // the identical instant of the identical run:
  //                              hud-gauge-box   hud-g-box
  //   trusted (peak, below)          44 352 px     7 420 px
  //   suspect (the warn route)       17 716 px     5 356 px
  //   refused (the loose route)           0 px         0 px
  //
  // The gauge carries a BAND because its three readings are well separated — its glow is most of
  // its ember, so doubt halves it. The g-meter carries a FLOOR ONLY, on purpose: its glow is a
  // small share of a small element, so trusted and doubted sit 7 420 against 5 356 portrait and
  // 6 180 against 4 380 landscape, and a ceiling that cleared the doubted portrait figure would
  // have to fit under the trusted landscape one — a 15 % window across two orientations of one
  // route entry, which is a threshold that fails on a font hinting change rather than on a bug.
  // What it still certifies outright is the end of the scale: at `trust` 0 the g-meter draws
  // zero ember inside its own box, on frames whose acceleration is large.
  //
  // The instant the screen opens. There is no GO gate: entering /drive IS the arming step, so
  // this is the first frame of a live run — gauge at rest, nothing claimed.
  // No floor: at t=0.3 the run has no fix yet, so the engine will not stand behind the reading
  // and both instruments are drawn muted. A FLOOR CANNOT CERTIFY THAT; the two ceilings can.
  { name: 'drive-open', path: '/drive?sim=harbor&rate=1&at=0.3&hold=1', waitMs: 2400, expectCanvas: true, regions: [gaugeIsCold(120), gIsCold(120)] },
  // The first seconds of EVERY run: the calibrator has not resolved which way the car points and
  // there is no fix yet. Both instruments muted, nothing counted.
  { name: 'drive-start', path: '/drive?sim=harbor&rate=1&at=2.2&hold=1', waitMs: 2600, expectCanvas: true, regions: [gaugeIsCold(120), gIsCold(120)] },
  // LIVE (the route to record video of): warped to 38 s and left running, so the shot lands on
  // the MANJI flick at 42.4 s and EXTREME ANGLE at 42.8 s, and the video covers the whole flick.
  // This is the one drive route that is NOT held, so its count moves shot to shot: 148 548,
  // 151 260 and 169 268 on three consecutive runs. The floor is set well under the lowest of
  // them rather than near any of them, because the number it is measuring is a moving frame.
  { name: 'drive', path: '/drive?sim=harbor&rate=1&at=39.2', waitMs: 3200, expectCanvas: true, regions: [gaugeIsHot(60000), gIsHot(2000)] },
  // HELD 20 ms after EXTREME ANGLE in the second lap's long drift: 48 deg right, needle hard
  // over, the R chevron lit. The engine is still banking points and still timing the hold behind
  // it — what changed is that the screen no longer prints them.
  { name: 'drive-peak', path: '/drive?sim=harbor&rate=1&at=100.85&hold=1', waitMs: 2800, expectCanvas: true, regions: [gaugeIsHot(20000), gIsHot(2000)] },
  // HELD 190 ms after TRANSITION x2, mid-swing through zero: 40 deg left, chevron flipped.
  { name: 'drive-transition', path: '/drive?sim=harbor&rate=1&at=85.55&hold=1', waitMs: 2800, expectCanvas: true, regions: [gaugeIsHot(60000), gIsHot(2000)] },
  // HELD 0.46 s after a 10,259-point chain banked.
  //
  // IT USED TO PHOTOGRAPH the bank banner rising over 900 ms, and there is no banner now. What it
  // still photographs is the gauge 0.46 s after the chain closed — the slide is over, the angle
  // is falling and the instrument is coming down with it, which is the only account of a bank a
  // driver gets on this screen. The engine's account is unchanged and lands on the results page.
  { name: 'drive-bank', path: '/drive?sim=harbor&rate=1&at=50.75&hold=1', waitMs: 2800, expectCanvas: true, regions: [gaugeIsHot(40000), gIsHot(2000)] },
  // A REAL hand-held phone (`looseness=1` goes through the simulator, not through the view): the
  // mount reads loose, the scorer pays nothing, and BOTH instruments are drawn in muted grey with
  // no glow at all — 0 ember pixels inside either box, on a frame whose angle is large and whose
  // acceleration is larger still, because a hand-held phone is the thing being accelerated.
  //
  // `minEmber: 100` used to stand here. It measured 30 591 — 17 169 of them the red LOOSE MOUNT
  // banner and 9 745 the red STOP, because the pixel classifier counts `#FF3B3B` as ember — so
  // the check was satisfied by the two elements that were SUPPOSED to be loud and could never
  // have failed on the gauge. The banner is gone; the ceiling that replaced the floor is not,
  // because it is now the whole of what this route proves.
  { name: 'drive-loose', path: '/drive?sim=harbor&looseness=1&rate=1&at=21.5&hold=1', waitMs: 2800, expectCanvas: true, regions: [gaugeIsCold(120), gIsCold(120)] },
  // The same run 0.2 s after the slide became a spin. Nothing was ever paid for this run, so
  // there is nothing to take away and no event to announce: both instruments stay grey through
  // the spin exactly as they were grey before it.
  { name: 'drive-lost', path: '/drive?sim=harbor&looseness=1&rate=1&at=21.95&hold=1', waitMs: 2800, expectCanvas: true, regions: [gaugeIsCold(120), gIsCold(120)] },
  // A REAL GPS dropout (`dropouts=1`), 1.2 s into the second gap. The engine KEEPS SCORING
  // through a dropout — slip angle comes off the gyro and acceleration off the accelerometer,
  // neither of which is the fix — so both instruments stay lit, and these floors say so. GPS LOST used to be spelled out in the status
  // strip; it is not spelled out anywhere on this screen now, and the reason it needn't be is
  // that the reading it would qualify has not changed.
  { name: 'drive-gps', path: '/drive?sim=harbor&dropouts=1&rate=1&at=24.6&hold=1', waitMs: 2800, expectCanvas: true, regions: [gaugeIsHot(40000), gIsHot(2000)] },
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
  // On a recording the engine does not believe, the slip angle loses its escalation colours
  // along with the points: EVERY colour off `heatColor` is greyed — the trail ribbon and its
  // halo, the core chunks, the mini-map trail, the two ticks that mark a slide's ends, the
  // previous lap's breadcrumbs and the scrubber's own |β| gradient.
  //
  // NO `minEmber`, on purpose: an ember floor on this frame is a check on the defect. It had one
  // (150) and the frame passed it at 240 px while the lap was still drawn in full ember, because
  // t=17 is BEFORE the hand-held car has slid — the route could not tell the two states apart.
  //
  // AND THE COMMENT THAT REPLACED IT WAS ALSO WRONG. It said "the frame measures 24 ember
  // pixels, so it really is ember-free rather than nearly" — two mistakes in one sentence. The
  // 24 were not ember: sampled, they are `#B28300 / #C69200 / #C89400`, antialiased `#FFC53D`
  // gold scrubber pips that the old box-shaped `isEmber` swallowed (see pixels.mjs). And a
  // sentence about absence backed by no check is not a check: the number was in a comment,
  // nothing ran it, and three ember draws were leaking on the same run two frames later. The
  // ceiling below is the check. Measured with the hue-band classifier: 0.
  {
    name: 'replay-untrusted',
    path: '/replay/fixture-handheld?cam=chase&t=17&play=0&ui=0',
    waitMs: 4200,
    expectCanvas: true,
    regions: [{ name: 'stage', colour: 'ember', testId: 'replay-stage', padFrac: 0.01, max: 0 }],
  },
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
  // decision log.
  //
  // THIS COMMENT USED TO SAY the first frame is the LOCKED state, because a browser will not
  // start an AudioContext before the page is touched. It is not, here: headless Chromium starts
  // one without a gesture, so `/sound` shoots AUDIBLE and this harness cannot certify the locked
  // path at all — a route written for a state it can never reach. The locked path is real on a
  // phone and stays on the list of what only a device can settle. The second route below shoots
  // after a real tap on a play button: the context resumes, the clip is dispatched, and the
  // decision log names what happened to it — which is a thing this harness CAN prove.
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
  // Two seconds into a genuinely hand-held recording. Step 01 used to be struck through with a
  // green tick here while the mount light beside it still read "Listening". The mount cues
  // reach `loose` first at looseness 1 (0.67–1.25 s measured), so this frame is now the
  // monitor having DECIDED — the un-decided state is the first two seconds of a rigid
  // recording, where `mountConfident` is false until the cues have a full window (2.02 s on
  // `sim=harbor&seed=1`) and `calibrate-nothing` / `calibrate` photograph it.
  { name: 'calibrate-early', path: '/calibrate?sim=harbor&looseness=1&dropouts=1&at=2&hold=1', waitMs: 2400, expectCanvas: true },
  // ---- drive display, appended ------------------------------------------------------------
  // MID-CHAIN, 1.2 s after the second link opened. The chain bar and the xN chip that used to
  // report it are gone from the screen; the chain itself is not, and neither is what it pays.
  { name: 'drive-chain', path: '/drive?sim=harbor&rate=1&at=48.5&hold=1', waitMs: 2800, expectCanvas: true, regions: [gaugeIsHot(25000), gIsHot(2000)] },
  // THE DOUBTED MOUNT, and the only route that photographs the middle of the trust scale.
  // `integrity=suspect` at the exact instant of `drive-peak`: same run, same warp, same hold, so
  // the two frames differ in nothing but how far the engine believes the reading. Held side by
  // side they look alike at a glance — the arc, the needle, the numeral and the chevron are all
  // drawn — and they are not alike. Inside `hud-gauge-box`, doubted against trusted:
  //   portrait    17 716  vs  44 352   (x 2.50)
  //   landscape   31 392  vs  77 300   (x 2.46)
  // because `trust` multiplies every opacity in the instrument. The whole thing is dimmer, which
  // is the screen saying "this, but less sure" in the one channel it has left.
  //
  // Hence a BAND and not a floor. The floor says it still drew; the ceiling says it drew dimmer
  // than the trusted twin, and without the ceiling this route would pass on a bug that threw the
  // doubt away and lit the gauge at full.
  //
  // THE CEILING IS SET BY THE LANDSCAPE FRAME AND IS THEREFORE LOOSE IN PORTRAIT. One route entry
  // is shot at both orientations and a pixel count is not orientation-free: the landscape gauge
  // box is 1.78x the area of the portrait one and every count in it scales by very nearly that
  // (31 392 / 17 716 = 1.77). So 38 000 has to clear landscape's 31 392 while staying under
  // portrait's trusted 44 352, and there is only that window to sit in. It catches a full-trust
  // regression at both orientations, which is what it is for; it would not catch a regression
  // that merely doubled the doubted portrait glow. Both figures are stable — consecutive runs of
  // each route returned them unchanged, because `hold=1` freezes the frame.
  {
    name: 'drive-warn',
    path: '/drive?sim=harbor&rate=1&at=100.85&hold=1&integrity=suspect',
    waitMs: 2800,
    expectCanvas: true,
    regions: [{ name: 'gauge', colour: 'ember', testId: 'hud-gauge-box', padFrac: 0.01, min: 6000, max: 38000 }, gIsHot(2000)],
  },

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
  {
    name: 'garage-spun',
    path: '/?demo=spun',
    waitMs: 7000,
    // The same maximum on the run that has spins AND held angles: three spins, none of them on
    // the axis. This is the frame the finding was written from — "the three tallest ridges are
    // the spins, under HELD ANGLE THROUGH THE RUN · 60° TOP, directly above the card's own HELD
    // ANGLE 18°" — and 0 red pixels above the gutter is what makes that sentence false now.
    regions: [{ name: 'axis', colour: 'red', testId: 'last-run-axis', max: 0 }],
  },
  // The hand-held card's own numbers, one viewport down: angle, slides and points all `--` on a
  // run the monitor did not believe, over a trace drawn hollow and captioned as a recording.
  {
    name: 'garage-flagged-stats',
    path: '/?demo=flagged',
    waitMs: 8000,
    actions: [{ type: 'scroll', y: 300 }, { type: 'wait', ms: 900 }],
    // TWO MAXIMA, because the claim is an absence and only a maximum can prove one
    // (docs/CRITIC.md rule 15). `last-run-axis` is the part of the plot ABOVE the footprint
    // gutter — the held-angle axis itself — so "0 red pixels in it" says no slide of a run the
    // monitor did not believe is drawn as an angle. That check FAILS on the build this was found
    // in: all seven slides drew there, in red, at their instantaneous peaks (75–85°), clamped to
    // the 60° ceiling. The second says the same thing from the other side: no ember either, so
    // nothing is dressed up as a believed angle. A floor on this frame proves nothing.
    regions: [
      { name: 'axis', colour: 'red', testId: 'last-run-axis', max: 0 },
      { name: 'plot', colour: 'ember', testId: 'last-run-plot', padFrac: 0.004, max: 0 },
    ],
  },

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

  // ---- replay: the five frames the eight default fixtures could not show, appended ---------
  // A SLIDE THE ENGINE PAID NOTHING FOR. `hero` on seed 13 is a trusted S-grade run whose drift
  // 3 (44.4–47.3 s) had all 2.9 s of it refused by the integrity monitor — `suppressedS` 2.93 —
  // so the scorer published `total: 0` for it while the run as a whole scored 23 982. The replay used to read that 0 as "no score data", run its own estimate
  // and slam "+127" over the road at the exit — a number the engine had refused to pay. This is
  // that exit, 0.14 s after it fires. The eight default fixtures all happen to have every
  // per-drift total above zero, which is why this needs a seed.
  //
  // THE BEAT NO LONGER PLAYS EMPTY. It said nothing at all, "because there is nothing to say",
  // while the same slide was drawn a full ember ribbon with a halo and two ember ticks — so the
  // ribbon and the silence disagreed and no frame said which was right. There IS something to
  // say, and src/engine/types.ts says it is the only form a driver can be shown: the seconds the
  // monitor refused. The callout on this frame reads "2.9 S DID NOT COUNT". It is a measurement,
  // not a score, so `isPointsClaim` leaves it alone and an untrusted run would show it too.
  { name: 'replay-zero-paid', path: '/replay/x?fixture=hero&seed=13&cam=chase&t=47.45&play=0&ui=0', waitMs: 3600, expectCanvas: true, minEmber: 400 },
  // …and the same drift's HIGHLIGHT CHIP, which used to read "19° · 127 PTS" and now reads the
  // one thing that is true about it: 19°.
  { name: 'replay-zero-chip', path: '/replay/x?fixture=hero&seed=13&drift=3&cam=chase&play=0&ui=1', waitMs: 3600, expectCanvas: true, minEmber: 400 },
  // THE UNTRUSTED RUN AFTER IT HAS SLID. `replay-untrusted` freezes at t=17, before the
  // hand-held car has slid, so it could not tell a greyed trail from an ember one. At t=46 the
  // ungated trail measured 39 716 ember pixels beside a NOT SCORED plate and grey peak labels.
  // No `minEmber`: the point of this frame is that the heat ramp is withheld, so a floor on
  // ember pixels would be a check on the defect. The ceiling is the check — and this tick of the
  // run is OFF CAMERA for the ticks that were still leaking, which is why `replay-untrusted-leak`
  // below exists as well. One moment is not a run.
  {
    name: 'replay-untrusted-slid',
    path: '/replay/fixture-handheld?cam=chase&t=46&play=0&ui=0',
    waitMs: 4200,
    expectCanvas: true,
    regions: [{ name: 'stage', colour: 'ember', testId: 'replay-stage', padFrac: 0.01, max: 0 }],
  },
  // A CLEAN LAP'S TELEMETRY STRIP. `clean` peaks at 4.18°, and the scrub band used to rescale
  // itself to that peak — so a lap with nothing in it drew full-height in gold and red, under a
  // footer reading 0 DRIFTS. The band is absolute now (`ribbonScale` is the spin edge, full
  // stop) and this is what a clean lap looks like: a flat line. No `minEmber` for the same
  // reason as above; the ceilings say the thing the sentence says. Gold starts 80 % up the band
  // and red at the top, so on a lap with no drift in it there must be NEITHER inside the strip:
  // measured 0 and 0, portrait and landscape.
  {
    name: 'replay-clean-band',
    path: '/replay/x?fixture=clean&cam=chase&t=66&play=0&ui=1',
    waitMs: 3200,
    expectCanvas: true,
    regions: [
      { name: 'band-gold', colour: 'gold', testId: 'replay-scrubber', max: 0 },
      { name: 'band-red', colour: 'red', testId: 'replay-scrubber', max: 0 },
    ],
  },
  // The same zero-paid slide as a HIGHLIGHT chip (it ranks 8th of 8 on this seed), which is the
  // other string that carried the invented number: "19° · 127 PTS". `replay-zero-chip` above
  // shows the deep-linked THIS DRIFT chip, which has always been measurements only.
  { name: 'replay-zero-highlight', path: '/replay/x?fixture=hero&seed=13&hl=8&cam=chase&play=0&ui=1', waitMs: 3600, expectCanvas: true, minEmber: 300 },
  // ---- /settings: the run list seen from the other screen that counts it, appended ---------
  // `settings` above shoots an EMPTY garage's settings, where "0 stored runs" happens to be
  // true. This is the same section over a night's driving, which is the frame that says the
  // count is a count rather than a constant.
  {
    name: 'settings-stored',
    path: '/?demo=night',
    waitMs: 8000,
    actions: [
      { type: 'waitFor', testId: 'last-run', timeout: 30000 },
      { type: 'goto', path: '/settings' },
      { type: 'wait', ms: 1200 },
      { type: 'scroll', y: 1500 },
      { type: 'wait', ms: 700 },
    ],
  },
  // THE FINDING. Six real recordings on the device and a TRUNCATED index: the Data section read
  // "0 stored runs" — `useSessionIndex` returns `entries: []` AND an error when `listSessions`
  // throws — and greyed out DELETE ALL RUNS, which is the one repair `clearSessions` was written
  // for (it deletes every body the device can name, index or no index). The garage one tap away
  // said "6 recordings are still on this device" on the same storage. Seed six runs, truncate
  // the index, then open `/settings` with no `?demo=` so nothing re-seeds over the evidence.
  {
    name: 'settings-index-broken',
    path: '/?demo=night',
    waitMs: 8000,
    actions: [
      { type: 'waitFor', testId: 'last-run', timeout: 30000 },
      { type: 'eval', js: 'localStorage.setItem("dom.sessions.index.v1", localStorage.getItem("dom.sessions.index.v1").slice(0, 40))' },
      { type: 'goto', path: '/settings' },
      { type: 'wait', ms: 1800 },
      { type: 'scroll', y: 1500 },
      { type: 'wait', ms: 700 },
    ],
  },
  // …and the repair, offered here as well as in the garage, because this is the screen a driver
  // goes to when they want to do something about their data.
  {
    name: 'settings-index-rebuilt',
    path: '/?demo=night',
    waitMs: 8000,
    actions: [
      { type: 'waitFor', testId: 'last-run', timeout: 30000 },
      { type: 'eval', js: 'localStorage.setItem("dom.sessions.index.v1", localStorage.getItem("dom.sessions.index.v1").slice(0, 40))' },
      { type: 'goto', path: '/settings' },
      { type: 'wait', ms: 1800 },
      { type: 'scroll', y: 1500 },
      { type: 'wait', ms: 500 },
      { type: 'tap', testId: 'cta-rebuild-index', timeout: 30000 },
      { type: 'wait', ms: 2500 },
    ],
  },
  // The wipe, ASKED over a broken index: the button is live and the question counts what is
  // really about to go — the recordings, since the list that named them cannot be read.
  {
    name: 'settings-wipe-broken',
    path: '/?demo=night',
    waitMs: 8000,
    actions: [
      { type: 'waitFor', testId: 'last-run', timeout: 30000 },
      { type: 'eval', js: 'localStorage.setItem("dom.sessions.index.v1", localStorage.getItem("dom.sessions.index.v1").slice(0, 40))' },
      { type: 'goto', path: '/settings' },
      { type: 'wait', ms: 1800 },
      { type: 'scroll', y: 1500 },
      { type: 'wait', ms: 500 },
      { type: 'tap', testId: 'setting-wipe', timeout: 30000 },
      { type: 'wait', ms: 900 },
    ],
  },

  // ---- /sound: the one rule the lab advertises, pressed ------------------------------------
  // THE SPIN is the lab's only demonstration of the mixer's first rule, and no route had ever
  // pressed it — which is why "so you hear one" could sit on the screen for a round over a
  // button that played both clips. This presses `seq-lost` and then shows the decision log,
  // where the rule has to be readable: `lost · family · vs spin` under `spin · played`.
  //
  // A NOTE ON THE `sound` ROUTE ABOVE, which says the first frame is the LOCKED state. It is not,
  // here: headless Chromium starts an AudioContext without a gesture, so `/sound` shoots AUDIBLE
  // and this harness cannot certify the locked path at all. The locked path is real on a phone
  // and on a desktop browser with a normal autoplay policy; nothing in `artifacts/shots` is
  // evidence about it either way, and a reader should not take that route's comment as such.
  {
    name: 'sound-lost',
    path: '/sound',
    waitMs: 2600,
    actions: [
      { type: 'waitFor', testId: 'seq-lost' },
      { type: 'tap', testId: 'seq-lost', timeout: 30000 },
      { type: 'wait', ms: 1200 },
      { type: 'eval', js: "document.querySelector('[data-testid=\"sound-decisions\"]').scrollIntoView({ block: 'center' })" },
      { type: 'wait', ms: 700 },
    ],
  },
  // ---- drive display: the two frames nothing was shooting, appended ------------------------
  // THE SAVE-FAIL OVERLAY ON A RUN THE ENGINE REFUSED. `drive-savefail` only ever shoots a clean
  // recording, so nothing caught the overlay building its verdict out of `score.grade` and
  // `score.total` with no `score.trusted` check: the hand-held run below finishes with total 0,
  // grade B and `trusted: false`, and the card used to draw a 64 px cyan B, an ember 0 and
  // "4 DRIFTS · PEAK 76°". `src/engine/types.ts` forbids exactly that. What it must show is the
  // refusal and the recording — no letter, no total, no peak.
  {
    name: 'drive-savefail-untrusted',
    path: '/drive?sim=harbor&looseness=1&rate=1&at=100.85&hold=1',
    waitMs: 2800,
    expectCanvas: true,
    actions: [
      { type: 'eval', js: "Storage.prototype.setItem = function () { const e = new Error('disk is full'); e.name = 'QuotaExceededError'; throw e; };" },
      { type: 'tap', testId: 'cta-stop', timeout: 30000 },
      { type: 'wait', ms: 1400 },
    ],
  },
  // THE CELEBRATION FRAME OF A RUN WORTH NOTHING, which is the frame `drive-loose` cannot show.
  // `looseness=1` reads as a LOOSE mount, so the gauge greys out and the shot proves only the
  // easy case. At 0.3 the mount reads SUSPECT: physics possible, state valid, `believable` true
  // on 95.5 % of the run — and `counting` false on 100.0 % of it, `finish()` total 0, grade C,
  // `trusted: false`. Held at the peak of the second lap's long drift, 56.2 deg — the largest
  // angle the harbor run ever reaches, on a session that will be paid nothing.
  //
  // This is the frame where the instruments are most tempted to celebrate, and the temptation is
  // now the whole of what can go wrong here: the chips, the multiplier and the odometer that used
  // to take a full-colour branch on this frame are off the screen, so the gauge and the g-meter
  // are the only things left that could light up for a slide worth zero. The three ceilings are
  // the assertion that they do not — no ember inside either instrument's box, and no gold
  // anywhere on the frame.
  {
    name: 'drive-loose-peak',
    path: '/drive?sim=harbor&looseness=0.3&rate=1&at=100.78&hold=1',
    waitMs: 2800,
    expectCanvas: true,
    regions: [gaugeIsCold(120), gIsCold(120), { name: 'screen-gold', colour: 'gold', max: 200 }],
  },

  // THE BANKED ROW, which is where the round's headline fix is read. `bank.ts` moved BANKED to
  // tier B on a measurement and its `why` went on saying "Tier A and the loudest thing in a run"
  // — four lines under the row's own "RMS -20.6 DB · TIER B" on this very card. The file said one
  // thing and the half that renders said another, and no frame in `artifacts/shots` showed it.
  // This is that frame: the measurements and the sentence under them, in one shot.
  {
    name: 'sound-banked',
    path: '/sound',
    waitMs: 2600,
    actions: [
      { type: 'waitFor', testId: 'clip-banked' },
      { type: 'eval', js: "document.querySelector('[data-testid=\"clip-banked\"]').scrollIntoView({ block: 'start' })" },
      { type: 'wait', ms: 700 },
    ],
  },
  // ---- calibrate: the states the 7.0 critique named, appended ----------------------------
  // NO PIXEL THRESHOLD ON ANY OF THESE, deliberately. Every calibrate frame is a frozen phase
  // colour, so a `minEmber` here would be a check on whichever colour the phase happens to
  // paint — i.e. a green tick certifying the defect if the phase is wrong. What these routes
  // are for is being LOOKED AT.
  //
  // A mount banner over a sentence about something else, which was 100 % of them.
  // `IntegrityMonitor.message` answers the ROOT CAUSE, and the only way to reach this banner
  // is for `calibrationOk` to be false — which IS the cause that outranks the mount — so the
  // gold MOUNT LOOKS UNSTEADY printed "Can't tell which way the car points" on every frame of
  // every run. `mountMessage` is the monitor's sentence about the mount, and this is the frame
  // where the two differ: the headline is FINDING FORWARD and the banner is about the cradle.
  { name: 'calibrate-cradle-banner', path: '/calibrate?sim=harbor&seed=3&looseness=0.2&dropouts=1&at=40&hold=1', waitMs: 2400, expectCanvas: true },
  // A GPS dropout, on the screen that has no GPS light. It used to surface only as the body of
  // a mount banner ("MOUNT SHAKING / GPS signal lost 5 s ago"); now it is its own row. The same
  // frame is the answer to the READY footer: confidence reads 61 % here having peaked at 76 %,
  // so "as sharp as it gets" was false and "Best so far 76%" is what the calibrator publishes.
  { name: 'calibrate-gps', path: '/calibrate?sim=harbor&seed=2&dropouts=1&at=55&hold=1', waitMs: 2400, expectCanvas: true },

  // ---- replay: the moment the trust gate was leaking, and the two that could not see it -----
  // THE FRAME THE LEAK IS ON. `replay-untrusted` (t=17) and `replay-untrusted-slid` (t=46) both
  // measure 0 ember and both were passing while three draws were still ungated, because at
  // neither instant is a drift-start tick, a drift-end dot or a previous-lap breadcrumb inside
  // the shot. At t=60 the start tick of the lap-2 slide sits beside the start/finish gate: with
  // those three draws outside the gate this frame drew 1 099 ember pixels in one cluster at
  // x 213–320, y 1112–1189 — sampled `#EB7656 / #C85333 / #B84220`, a visible orange streak two
  // inches under the words NOT SCORED. Gated: 0. A ceiling on the STAGE (the world band, by its
  // own testID, so it follows the layout) is what makes that an assertion rather than a sentence.
  {
    name: 'replay-untrusted-leak',
    path: '/replay/fixture-handheld?cam=chase&t=60&play=0&ui=0',
    waitMs: 4200,
    expectCanvas: true,
    regions: [{ name: 'stage', colour: 'ember', testId: 'replay-stage', padFrac: 0.01, max: 0 }],
  },
  // …and the whole route at once, where the breadcrumbs of every finished lap are on screen
  // together: 134 ember pixels before the gate reached them, 0 after. Chase can only ever show
  // the few metres around the car; overview is the frame that can see the lot.
  {
    name: 'replay-untrusted-overview',
    path: '/replay/fixture-handheld?cam=overview&t=90&play=0&ui=0',
    waitMs: 4200,
    expectCanvas: true,
    regions: [{ name: 'stage', colour: 'ember', testId: 'replay-stage', padFrac: 0.01, max: 0 }],
  },
  // A LAP THE ENGINE FOUND NO DRIFT IN SPENDS NO EMBER IN THE WORLD. `replay-clean-band` shoots
  // the same instant with the transport up, and the transport's PLAY button is ember by design,
  // so a frame-wide count there says nothing. This is the same frame with `ui=0`: the driven
  // line, the slip label, the slip arc, the heading line and the L/R chevron, on a run whose
  // footer reads 0 DRIFTS and whose hero numeral is already grey because 4.2° is below the
  // engine's 8° hold edge. The line and the label used to be full ember beside that grey
  // numeral — one frame saying both "not sliding" and "sliding" about the same angle. Measured
  // inside the stage: 11 892 ember pixels before, 0 after (the 508 left on the frame are three
  // rows of the scrub ribbon's own baseline, below the stage, where the gradient bottoms out).
  {
    name: 'replay-clean-world',
    path: '/replay/x?fixture=clean&cam=chase&t=66&play=0&ui=0',
    waitMs: 3200,
    expectCanvas: true,
    regions: [{ name: 'stage', colour: 'ember', testId: 'replay-stage', padFrac: 0.01, max: 0 }],
  },
  // THE OTHER END OF THE SAME SCALE. `sloppy` peaks at 118° and the band used to stretch to
  // 123.9° to hold it, which put the 65° spin edge — where the gradient's stops say red — at
  // 52.5 % of the strip, inside the ember zone, under a world painting the same 70° slide
  // gold-to-red. Fixed at the spin edge, everything past 65° saturates at the top, where the
  // shader already says a spin is: the share of the trace in the top tenth of the band goes from
  // 4.40 % to 16.51 %, and the strip measures 4 524 red pixels in portrait, 10 388 in landscape.
  //
  // The floor below proves the strip paints a spin RED; it is not what proves the scale is
  // absolute, and it should not be read as if it were. Two runs having the same scale is a claim
  // about two frames, so it is asserted where it can be — `replay-ui.test.ts`, "the scrub band is
  // the same scale on a clean lap as on a lap full of spins", which fails on the old rule.
  {
    name: 'replay-sloppy-band',
    path: '/replay/x?fixture=sloppy&cam=chase&t=999&play=0&ui=1',
    waitMs: 3200,
    expectCanvas: true,
    regions: [{ name: 'band-red', colour: 'red', testId: 'replay-scrubber', min: 2000 }],
  },
];
