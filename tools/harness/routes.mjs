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
 * Times below are for `sim=harbor&seed=1&laps=2` (drift entries at 5.3 / 46.3 / 58.3 / 80.5 /
 * 104.1 / 122.8 s).
 */
export const defaultRoutes = [
  { name: 'home', path: '/', waitMs: 900 },
  { name: 'calibrate', path: '/calibrate', waitMs: 900 },

  // Armed, before the run: the gauge at rest and the GO control.
  { name: 'drive-idle', path: '/drive?sim=harbor&rate=1', waitMs: 1600, expectCanvas: true, minEmber: 1500 },
  // Live: warped into the long drift at 104 s and left running (this is the one to record video of).
  { name: 'drive', path: '/drive?sim=harbor&rate=1&at=104', waitMs: 3200, expectCanvas: true, minEmber: 2000 },
  // Held: deep into the same drift — 65°, 120 km/h, ×1.75, SMOOTH still on the stack.
  { name: 'drive-peak', path: '/drive?sim=harbor&rate=1&at=114.5&hold=1', waitMs: 2200, expectCanvas: true, minEmber: 2000 },
  // Held 190 ms after the second transition of the linked drift at 80.5 s: two magenta callouts.
  { name: 'drive-transition', path: '/drive?sim=harbor&rate=1&at=83.95&hold=1', waitMs: 2200, expectCanvas: true, minEmber: 800 },
  // Held just after the chain banked (clean exit at 46.5 s, banked at 48.5 s).
  { name: 'drive-bank', path: '/drive?sim=harbor&rate=1&at=48.62&hold=1', waitMs: 2200, expectCanvas: true, minEmber: 1200 },
  // Held just after a spin threw the chain away.
  { name: 'drive-lost', path: '/drive?sim=harbor&rate=1&at=85.4&hold=1', waitMs: 2200, expectCanvas: true, minEmber: 1200 },
  // Held mid-drift with the mount verdict overridden: the warning must be impossible to miss.
  { name: 'drive-warn', path: '/drive?sim=harbor&rate=1&at=60&hold=1&integrity=loose', waitMs: 2200, expectCanvas: true, minEmber: 1500 },

  { name: 'results', path: '/results/demo', waitMs: 900 },
  { name: 'replay', path: '/replay/demo', waitMs: 900 },
  { name: 'settings', path: '/settings', waitMs: 900 },
];
