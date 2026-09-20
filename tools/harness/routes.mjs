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
 * A long press, as a page script: react-native-web's Pressable starts its long-press timer on
 * pointerdown, so a synthetic down / wait / up pair is a real long press to it. `tap()` cannot
 * hold, and the harness's action vocabulary is deliberately small.
 */
function longPress(testId, ms = 700) {
  return `(async () => {
    const el = document.querySelector('[data-testid="${testId}"]');
    if (!el) throw new Error('no element ${testId}');
    const r = el.getBoundingClientRect();
    const at = { bubbles: true, cancelable: true, clientX: r.x + r.width / 2, clientY: r.y + 24, pointerId: 1, pointerType: 'touch', isPrimary: true, button: 0, buttons: 1 };
    el.dispatchEvent(new PointerEvent('pointerdown', at));
    el.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, ${ms}));
    el.dispatchEvent(new PointerEvent('pointerup', { ...at, buttons: 0 }));
  })()`;
}

/**
 * A real drag on the replay scrubber, as a page script: pointer down on the touch target, three
 * moves, and NO release, so the screenshot catches the grabbed state. react-native-gesture-handler
 * on web is driven by pointer events, so this is the same path a thumb takes.
 */
function dragScrubber(testId, to = 0.4) {
  return `(async () => {
    const el = document.querySelector('[data-testid="${testId}"]');
    if (!el) throw new Error('no element ${testId}');
    const r = el.getBoundingClientRect();
    const y = r.y + r.height / 2;
    const at = (f) => ({ bubbles: true, cancelable: true, clientX: r.x + 18 + (r.width - 36) * f, clientY: y, pointerId: 7, pointerType: 'touch', isPrimary: true, button: 0, buttons: 1 });
    el.dispatchEvent(new PointerEvent('pointerdown', at(0.02)));
    for (const f of [0.1, 0.22, ${to}]) {
      await new Promise((r) => requestAnimationFrame(r));
      el.dispatchEvent(new PointerEvent('pointermove', at(f)));
    }
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

  // ---- drive: the live HUD at the moments that matter -----------------------------------
  // Armed, before the run: gauge at rest, GO, nothing claimed yet.
  { name: 'drive-idle', path: '/drive?sim=harbor&rate=1', waitMs: 1800, expectCanvas: true, minEmber: 1500 },
  // The first seconds of EVERY run: the calibrator has not resolved which way the car points and
  // there is no fix yet. Calm cyan FINDING FORWARD, gauge muted, score not counting.
  { name: 'drive-start', path: '/drive?sim=harbor&rate=1&at=2.2&hold=1', waitMs: 2600, expectCanvas: true, minEmber: 200 },
  // LIVE (the route to record video of): warped to 38 s and left running, so the shot lands on
  // the MANJI flick at 42.4 s and EXTREME ANGLE at 42.8 s, and the video covers the whole flick.
  { name: 'drive', path: '/drive?sim=harbor&rate=1&at=38', waitMs: 3200, expectCanvas: true, minEmber: 2000 },
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
  { name: 'results-integrity', path: '/results/fixture-rough?reveal=off', waitMs: 2000, actions: [{ type: 'scroll', y: 5200 }, { type: 'wait', ms: 900 }] },
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
  // LIVE, from the top, chase camera: this is the one to record video of (the callout slam, the
  // shake, the smoke and the camera cut only exist in motion).
  { name: 'replay', path: '/replay/demo?cam=chase&t=93', waitMs: 3000, expectCanvas: true, minEmber: 1500 },
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
  // The scrubber MID-DRAG: a real pointer sequence on the touch target, released nowhere, so the
  // shot is the grabbed state — playhead fat, time bubble up, frame following the finger.
  {
    name: 'replay-scrub',
    path: '/replay/demo?cam=chase&play=0&ui=1',
    waitMs: 2400,
    expectCanvas: true,
    actions: [{ type: 'eval', js: dragScrubber('replay-scrubber', 0.36) }, { type: 'wait', ms: 700 }],
  },
  // A hand-held recording: it still replays, and it must not present points or a grade.
  { name: 'replay-untrusted', path: '/replay/fixture-handheld?cam=chase&t=17&play=0&ui=0', waitMs: 4200, expectCanvas: true, minEmber: 800 },
  // Bad data: `gaps=6` blanks six seconds of recorded position (a tunnel), so buildReplay's own
  // warnings fire and the dead-reckoned stretch is dashed instead of glowing.
  { name: 'replay-warnings', path: '/replay/x?fixture=rough&gaps=6&cam=overview&t=62&play=0&ui=0', waitMs: 3600, expectCanvas: true, minEmber: 1200 },
  // The warnings plate opened: the sentences behind the red plate.
  {
    name: 'replay-warnings-open',
    path: '/replay/x?fixture=rough&gaps=6&cam=chase&t=56&play=0&ui=1',
    waitMs: 3600,
    expectCanvas: true,
    actions: [{ type: 'tap', testId: 'replay-warn-toggle' }, { type: 'wait', ms: 500 }],
  },
  // The last frame: the grade lands only once the run is over.
  { name: 'replay-end', path: '/replay/demo?cam=overview&t=999&play=0&ui=0', waitMs: 2600, expectCanvas: true, minEmber: 1500 },
  // A point-to-point stage: no laps, so no lap ticks and no ghost — STAGE, not LAP 1/2.
  { name: 'replay-touge', path: '/replay/x?fixture=touge&cam=cinematic&t=69.2&play=0&ui=0', waitMs: 2800, expectCanvas: true, minEmber: 1200 },
  { name: 'settings', path: '/settings', waitMs: 900 },
];
