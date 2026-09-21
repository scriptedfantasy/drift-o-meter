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
import type { CameraState } from '../../engine/replay';

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
  /**
   * The speed block: right-aligned at `x`, sitting on `baseline`.
   *
   * It held the speed AND the running points under it, which is why it is a block and not a
   * line; the points went with the scoring and the corner is one number now.
   */
  readout: { x: number; baseline: number };
  /** The bottom info line: which lap, the session name, the slide count and the biggest angle. */
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
  // Landscape runs the lap / track / slides line as a second row of the top bar, because the
  // bottom bar belongs to the transport.
  const info = landscape ? { x: left, y: insets.top + 52, right } : { x: left, y: h - bottomBar + 26, right };
  const chrome = { y: insets.top + (landscape ? 24 : 30), left, right };
  const action: Rect = landscape ? { ...stage } : { x: 0, y: stage.y, w, h: Math.max(120, controls.y - stage.y) };
  return { w, h, landscape, insets, gutter, topBar, bottomBar, scrub, stage, action, controls, hero, readout, info, chrome };
}

/**
 * How far from the centre of the action rectangle the car is allowed to sit, as a fraction of
 * that rectangle. The car therefore lives in the middle 68 % × 64 % of what the viewer can see.
 */
export const SAFE_FRAME = { maxXFrac: 0.34, maxYFrac: 0.32 } as const;

/**
 * THE SAFE FRAME: the camera state the renderer actually draws with.
 *
 * `worldToScreen` puts (cx, cy) at (cam.w / 2, cam.h / 2), so handing the renderer a state whose
 * half-extents ARE the action rectangle's centre on screen centres the world on the band the
 * viewer can actually see, and the engine's camera never has to know about the chrome. This then
 * slides that frame — not the camera — back along the same line until the car is inside
 * `SAFE_FRAME` of its centre. The camera's own motion, its rate limits and its cuts are
 * untouched; only where the result is printed moves.
 *
 * IT IS OUT HERE BECAUSE IT IS A GUARANTEE, and a guarantee that lives inside a
 * requestAnimationFrame closure is one nothing can run. The camera's pan limiter saturates on
 * exactly one shipped fixture — `handheld`, whose own estimated position steps 9.28 m between
 * two trail samples 50 ms apart (185.6 m/s against 37.0 m/s driven) — and following a teleport
 * at 60 m/s means lagging it. Measured on the raw camera against the portrait action rect
 * (393×852, 0 insets): `handheld` chase leaves it on 27 frames of 6 819, up to 40.0 pt past the
 * left edge, worst at t = 20.35 s; cinematic on 12; every other fixture × mode on 0. Raising the
 * limiter would not fix that — it would let the 186 m/s jump through as a jump cut in the
 * middle of a corner. Holding the FRAME instead costs the shot nothing and keeps the car on
 * screen: through this function the same sweep leaves the rectangle on 0 frames of all sixteen
 * fixture × mode combinations, in portrait and in landscape. `replay-ui.test.ts` runs that sweep.
 */
export function safeFrame(cam: CameraState, carX: number, carY: number, action: Rect): CameraState {
  let cxs = action.x + action.w / 2;
  let cys = action.y + action.h / 2;
  const dx = carX - cam.cx;
  const dy = carY - cam.cy;
  const c = Math.cos(cam.rotation);
  const sn = Math.sin(cam.rotation);
  const offX = cam.zoom * (c * dx - sn * dy);
  const offY = -cam.zoom * (sn * dx + c * dy);
  const maxY = action.h * SAFE_FRAME.maxYFrac;
  const maxX = action.w * SAFE_FRAME.maxXFrac;
  if (offY > maxY) cys -= offY - maxY;
  else if (offY < -maxY) cys += -maxY - offY;
  if (offX > maxX) cxs -= offX - maxX;
  else if (offX < -maxX) cxs += -maxX - offX;
  return { ...cam, w: 2 * cxs, h: 2 * cys };
}
