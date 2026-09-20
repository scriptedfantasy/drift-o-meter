/**
 * Where every part of the replay frame lives, for BOTH renderers of this screen: the Skia canvas
 * draws the world, the letterbox bars, the HUD readouts and the scrubber from these numbers, and
 * the React overlay puts its controls and its touch targets on exactly the same rectangles.
 *
 * Portrait keeps the proportions of the reference frame the critic judged (a 104 pt top bar, a
 * 34 pt scrubber, a 96 pt bottom bar). Landscape is a different arrangement of the same parts,
 * not a squeezed portrait: thin bars, and the big readouts move into the corners of the stage so
 * the world keeps the middle of a wide screen.
 */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Insets {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface ReplayLayout {
  w: number;
  h: number;
  landscape: boolean;
  insets: Insets;
  /** Horizontal gutter for anything that is not full-bleed. */
  gutter: number;
  /** Height of the solid part of the top letterbox bar (the gradient foot is extra). */
  topBar: number;
  /** Height of the solid part of the bottom letterbox bar, below the scrubber. */
  bottomBar: number;
  /** The scrubber band: the touch target AND the drawn ribbon. */
  scrub: Rect;
  /** The world band between the bars — what the camera viewport should frame. */
  stage: Rect;
  /** Where the floating transport controls are laid out (React overlay). */
  controls: Rect;
  /** The hero |β| numeral: left-aligned at `x`, sitting on `baseline`. */
  hero: { x: number; baseline: number; inBar: boolean };
  /** Speed / points block: right-aligned at `x`, centred on `baseline`. */
  readout: { x: number; baseline: number };
  /** The bottom info line (lap, session name, total). */
  info: { x: number; y: number; right: number };
  /** Top row: the REPLAY tally, the clock and the camera name. */
  chrome: { y: number; left: number; right: number };
}

export const LETTERBOX_FADE = 22;

export function replayLayout(w: number, h: number, insets: Insets, controlsRows = 2): ReplayLayout {
  const landscape = w > h;
  const gutter = 18;
  const left = insets.left + gutter;
  const right = w - insets.right - gutter;
  const scrubH = landscape ? 30 : 34;
  const topBar = (landscape ? 58 : 104) + insets.top;
  const bottomBar = (landscape ? 64 : 96) + insets.bottom;
  const scrub: Rect = { x: insets.left, y: h - bottomBar - scrubH, w: w - insets.left - insets.right, h: scrubH };
  const stage: Rect = { x: 0, y: topBar, w, h: scrub.y - topBar };
  const rowH = 46;
  const rows = landscape ? 1 : controlsRows;
  const controlsH = rows * rowH + (rows - 1) * 8;
  const controls: Rect = { x: left, y: scrub.y - controlsH - 10, w: right - left, h: controlsH };
  const hero = landscape
    ? { x: left, baseline: scrub.y - 26, inBar: false }
    : { x: left, baseline: insets.top + 86, inBar: true };
  const readout = landscape ? { x: right, baseline: topBar + 40 } : { x: right, baseline: insets.top + 86 };
  const info = { x: left, y: h - bottomBar + (landscape ? 22 : 26), right };
  const chrome = { y: insets.top + (landscape ? 24 : 30), left, right };
  return { w, h, landscape, insets, gutter, topBar, bottomBar, scrub, stage, controls, hero, readout, info, chrome };
}
