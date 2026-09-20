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
  /** The world band between the bars. */
  stage: Rect;
  /**
   * What the CAMERA frames: the stage minus anything that floats over it. The world is still
   * drawn full-bleed behind the bars, but the car is centred here, so it never ends up behind the
   * transport controls.
   */
  action: Rect;
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
  const topBar = (landscape ? 72 : 104) + insets.top;
  const bottomBar = (landscape ? 70 : 96) + insets.bottom;
  const scrub: Rect = { x: insets.left, y: h - bottomBar - scrubH, w: w - insets.left - insets.right, h: scrubH };
  const stage: Rect = { x: 0, y: topBar, w, h: scrub.y - topBar };
  const rowH = 46;
  const rows = landscape ? 1 : controlsRows;
  const controlsH = rows * rowH + (rows - 1) * 8;
  // Landscape has a wide bottom bar and puts the transport IN it; portrait floats the controls
  // over the bottom of the stage, so the frame keeps the proportions of the reference.
  const controls: Rect = landscape
    ? { x: left, y: scrub.y + scrubH + 12, w: right - left, h: controlsH }
    : { x: left, y: scrub.y - controlsH - 10, w: right - left, h: controlsH };
  const hero = landscape
    ? { x: left, baseline: scrub.y - 30, inBar: false }
    : { x: left, baseline: insets.top + 86, inBar: true };
  const readout = landscape ? { x: right, baseline: scrub.y - 30 } : { x: right, baseline: insets.top + 86 };
  // Landscape runs the lap / track / total line as a second row of the top bar, because the
  // bottom bar belongs to the transport.
  const info = landscape ? { x: left, y: insets.top + 52, right } : { x: left, y: h - bottomBar + 26, right };
  const chrome = { y: insets.top + (landscape ? 24 : 30), left, right };
  const action: Rect = landscape ? { ...stage } : { x: 0, y: stage.y, w, h: Math.max(120, controls.y - stage.y) };
  return { w, h, landscape, insets, gutter, topBar, bottomBar, scrub, stage, action, controls, hero, readout, info, chrome };
}
