/**
 * Default route list for `shoot.mjs`. Each entry:
 *   name          file stem for the screenshot / video
 *   path          URL path (+ query); `?sim=harbor&rate=1` picks the simulated sensor source
 *   waitMs        settle time after load + fonts before the screenshot (default 800)
 *   actions       optional steps run before the screenshot (see README: tap / wait / scroll / press / eval / waitFor / screenshot)
 *   expectCanvas  fail if no <canvas> (Skia) is present
 *   minEmber      fail if fewer ember-coloured pixels than this are visible (proves the ring rendered)
 *   fullPage      capture the full scroll height instead of the viewport
 */
export const defaultRoutes = [
  { name: 'home', path: '/', waitMs: 900 },
  { name: 'calibrate', path: '/calibrate', waitMs: 900 },
  { name: 'drive', path: '/drive?sim=harbor&rate=1', waitMs: 2600, expectCanvas: true, minEmber: 2000 },
  { name: 'results', path: '/results/demo', waitMs: 900 },
  { name: 'replay', path: '/replay/demo', waitMs: 900 },
  { name: 'settings', path: '/settings', waitMs: 900 },
];
