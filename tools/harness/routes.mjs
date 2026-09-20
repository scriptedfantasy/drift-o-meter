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
 * The times are for `sim=harbor&seed=1&laps=2`, whose drifts run 11.6–17.9, 19.3–48.9 (3
 * transitions, MANJI), 50.6–54.0, 58.6–66.5, 69.7–76.2 and 77.4–123.3 s (6 transitions).
 */
export const defaultRoutes = [
  { name: 'home', path: '/', waitMs: 900 },
  { name: 'calibrate', path: '/calibrate', waitMs: 900 },

  // ---- drive: the live HUD at the moments that matter -----------------------------------
  // Armed, before the run: the gauge at rest, the GO control, nothing claimed yet.
  { name: 'drive-idle', path: '/drive?sim=harbor&rate=1', waitMs: 1800, expectCanvas: true, minEmber: 1500 },
  // LIVE (this is the one to record video of): warped to 96.3 s and left running, so the shot
  // lands ~4.5 s later on the MANJI transition at 100.0 s and EXTREME ANGLE at 100.6 s, and the
  // video covers the whole flick and the 60° hold that follows.
  { name: 'drive', path: '/drive?sim=harbor&rate=1&at=96.3', waitMs: 3200, expectCanvas: true, minEmber: 2000 },
  // HELD 0.25 s after EXTREME ANGLE: 59° right, ×4.5, 20 800 points, three callouts stacked.
  { name: 'drive-peak', path: '/drive?sim=harbor&rate=1&at=100.85&hold=1', waitMs: 2800, expectCanvas: true, minEmber: 2000 },
  // HELD 110 ms after TRANSITION ×2, mid-swing through zero: the magenta moment.
  { name: 'drive-transition', path: '/drive?sim=harbor&rate=1&at=85.05&hold=1', waitMs: 2800, expectCanvas: true, minEmber: 800 },
  // HELD just after a 10 570-point chain banked and the next drift (LINK ×3) started.
  { name: 'drive-bank', path: '/drive?sim=harbor&rate=1&at=50.75&hold=1', waitMs: 2800, expectCanvas: true, minEmber: 1200 },
  // HELD on the same frame as drive-peak with the mount verdict overridden: the warning has to
  // be impossible to miss even while the run is going well.
  { name: 'drive-warn', path: '/drive?sim=harbor&rate=1&at=100.85&hold=1&integrity=loose', waitMs: 2800, expectCanvas: true, minEmber: 1500 },

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
  { name: 'results-integrity', path: '/results/fixture-rough?reveal=off', waitMs: 2000, actions: [{ type: 'scroll', y: 5200 }, { type: 'wait', ms: 900 }] },
  // the same screen fed by the REAL engine pipeline (mount → slip → detector → scorer), not ground truth
  { name: 'results-pipeline', path: '/results/fixture-good?reveal=off&source=pipeline', waitMs: 3600 },
  // reduce-motion: state changes keep, shake and embers go
  { name: 'results-reduced', path: '/results/fixture-hero?reveal=hold&motion=reduce', waitMs: 2000 },
  { name: 'results-missing', path: '/results/no-such-session', waitMs: 1200 },
  { name: 'replay', path: '/replay/demo', waitMs: 900 },
  { name: 'settings', path: '/settings', waitMs: 900 },
];
