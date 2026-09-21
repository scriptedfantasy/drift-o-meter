/**
 * The replay frame, drawn in Skia.
 *
 * This is the app's renderer for the scene model in `src/engine/replay` — the SAME scene the SVG
 * renderer in `tools/analysis/render-replay.ts` draws for the harness, layer for layer and colour
 * for colour: lit ground plane, asphalt and verge, kerbs and apex rings, the ember→gold→red glow
 * trail, multi-lobed heat-graded smoke, the car with its rim glow and slip arc, the cyan velocity
 * arrow, the distance-synced ghost, magenta transition chips, letterbox with vignette and grain,
 * and the 34 pt scrubber. Nothing here invents data: every number comes from the engine.
 *
 * It runs once per displayed frame from `ReplayCanvas`'s loop and draws into a recording canvas.
 * Rules that keep that affordable: static geometry is prebuilt (`geometry.ts`), every paint and
 * shader is reused (`resources.ts`), and anything off screen is culled against the visible world
 * rectangle before it is drawn.
 */
import { ClipOp, PaintStyle, PointMode, Skia, StrokeCap, StrokeJoin, type SkCanvas, type SkFont, type SkPaint, type SkPath } from '@shopify/react-native-skia';

import {
  formatPoints,
  ghostPoseAt,
  lapAt,
  liveSmoke,
  SEVERITY_EDGES,
  screenToWorld,
  smokeAt,
  worldToScreen,
  type ActiveEvent,
  type CameraMode,
  type CameraState,
  type GhostPose,
  type Replay,
  type ReplayMarker,
  type ReplayPose,
} from '../../engine/replay';
import { clamp, wrapAngle } from '../../engine/types';
import { colors, gradeColors } from '../theme';
import type { SceneGeometry, WorldBounds } from './geometry';
import { ROAD_W } from './geometry';
import { smoothPolyline } from './kerbs';
import type { ReplayLayout } from './layout';
import {
  ASPHALT_HI,
  ASPHALT_LO,
  CENTRE_LINE,
  EDGE_LINE,
  GROUND,
  HOT,
  KERB_PALE,
  RUNOFF,
  TYPE,
  VERGE,
  deg,
  eventColor,
  fmtTime,
  headlinePoints,
  heatOf,
  isPointsClaim,
  kmh,
  mix,
  ribbonScale,
  severityWeight,
  tintOf,
} from './palette';
import type { SceneResources } from './resources';
import type { ReplayView } from './source';

export interface SceneFonts {
  /** Barlow Condensed 800, upright — the hero angle and the callouts. */
  hero: SkFont | null;
  callout: SkFont | null;
  /** The slip readout beside the arc, and the big peak labels. */
  mid: SkFont | null;
  peak: SkFont | null;
  grade: SkFont | null;
  /** Barlow Condensed 800 italic — things that move: speed, points, totals. */
  value: SkFont | null;
  /** Barlow Condensed 700 — every uppercase label. */
  label: SkFont | null;
  /** Orbitron 700 — the clock, so a time never reads as a score. */
  clock: SkFont | null;
  /** Barlow 500 — the ONE sentence on this screen (why a run was not scored). */
  body: SkFont | null;
  /** Barlow Condensed 800 at hero-and-a-half: the grade, slammed in on the final frame. */
  slam: SkFont | null;
}

export interface SceneUi {
  playing: boolean;
  rate: number;
  scrubbing: boolean;
  /** A drift the caller deep-linked to (`?drift=`): its ribbon is picked out. */
  focusDriftId: number | null;
  /** The highlight chip, while it is up. */
  highlight: { index: number; total: number; label: string; alpha: number } | null;
  /** How far the warning plate has been expanded (0 = plate only, 1 = the full list). */
  warningsOpen: boolean;
  /** The transport is on screen: in portrait it floats over the world and gets a scrim. */
  controlsVisible: boolean;
  reduceMotion: boolean;
}

export interface SceneInput {
  replay: Replay;
  view: ReplayView;
  geo: SceneGeometry;
  layout: ReplayLayout;
  fonts: SceneFonts;
  res: SceneResources;
  t: number;
  mode: CameraMode;
  cam: CameraState;
  pose: ReplayPose;
  ghost: GhostPose | null;
  events: ActiveEvent[];
  shake: number;
  /** 0..1 cross-fade after a camera cut (wall-clock driven, see ReplayCanvas). */
  cutFade: number;
  ui: SceneUi;
}

interface Frame extends SceneInput {
  vis: WorldBounds;
  /** The band the camera frames — where world labels are allowed to live. */
  action: { x: number; y: number; w: number; h: number };
  /** Trail index reached at `t`. */
  cur: number;
  overview: boolean;
  /** Suppress every points/grade claim (untrusted recording). */
  noScore: boolean;
  /** The run is over and the verdict is in: 0 while playing, 1 once the grade has landed. */
  reveal: number;
}

/**
 * How long the grade takes to land, in replay seconds before the end. The run's last moment is
 * the verdict's moment, so the slam is driven by the playhead rather than by a wall clock: it
 * resolves in a recorded video, it is exactly reproducible in a screenshot, and scrubbing back
 * takes the grade off the screen again.
 */
const REVEAL_S = 1.1;

/**
 * THE GATE, for a live |β| — `heatOf` in palette.ts, with this frame's trust plugged in.
 *
 * It is a one-liner here and a swept, exported rule there because the version that lived only
 * here was applied at sixteen draw sites and missed four, twice: the round before last a run
 * stamped NOT SCORED drew its whole lap in ember and gold, and the round after that the same
 * run drew an ember drift-start tick, an ember exit dot and an ember breadcrumb two inches under
 * the words. Nothing in the suite or the harness could see either. `replay-ui.test.ts` now runs
 * the rule, and runs a guard over the text of THIS FILE that fails if a ramp colour is ever
 * spent outside it.
 */
function heat(f: Frame, beta: number): string {
  return heatOf(beta, !f.noScore);
}

/**
 * The gate for a colour that belongs to a DRIFT THE DETECTOR DECLARED, rather than to the pose
 * the playhead is on: the ribbon's halo, the mini-map's trail, a peak marker, a band tick.
 *
 * The floor is the detector's own assertion. `heat` greys anything below the 8° hold edge
 * because the engine says that is not sliding — which is right for a pose and wrong for a slide
 * the engine has already declared: a drift's running peak is a degree or two for its first tenth
 * of a second (44–115 trail samples per fixture), and greying the head of every ribbon would
 * take the ember off drift ENTRY, the one beat DESIGN.md spends it on.
 */
function driftHeat(f: Frame, beta: number): string {
  return heat(f, Math.max(Math.abs(beta), SEVERITY_EDGES.hold));
}

/**
 * The same gate for a heat colour something else already worked out — the trail ribbon's core
 * chunks (coloured in `geometry.ts`, once, off the same ramp) and the mini-map.
 *
 * Only the trust half; see `tintOf`. Every hex that reaches it belongs to a declared drift.
 */
function tint(f: Frame, hex: string): string {
  return tintOf(hex, !f.noScore);
}

const BG = colors.bg0;
const WHITE = colors.text;
const MUTED = colors.muted;
const CAR_MIN_PT = 34;

// ---------------------------------------------------------------- small helpers
const inView = (f: Frame, x: number, y: number) => x >= f.vis.minX && x <= f.vis.maxX && y >= f.vis.minY && y <= f.vis.maxY;
const overlaps = (f: Frame, b: WorldBounds) => b.maxX >= f.vis.minX && b.minX <= f.vis.maxX && b.maxY >= f.vis.minY && b.minY <= f.vis.maxY;
/** A width in metres that is at least `px` logical points on screen. */
const mOrPx = (f: Frame, m: number, px: number) => Math.max(m, px / f.cam.zoom);
const toS = (f: Frame, x: number, y: number) => worldToScreen(f.cam, x, y);

function carScale(f: Frame): number {
  return Math.max(1, CAR_MIN_PT / (f.replay.options.carLengthM * f.cam.zoom));
}

function fillPaint(f: Frame, hex: string, alpha = 1): SkPaint {
  const p = f.res.fill;
  p.setStyle(PaintStyle.Fill);
  p.setShader(null);
  p.setColor(f.res.color(hex));
  p.setAlphaf(clamp(alpha, 0, 1));
  return p;
}

function strokePaint(f: Frame, hex: string, width: number, alpha = 1, cap: StrokeCap = StrokeCap.Round): SkPaint {
  const p = f.res.stroke;
  p.setStyle(PaintStyle.Stroke);
  p.setShader(null);
  p.setPathEffect(null);
  p.setStrokeCap(cap);
  p.setStrokeJoin(StrokeJoin.Round);
  p.setStrokeWidth(Math.max(1e-4, width));
  p.setColor(f.res.color(hex));
  p.setAlphaf(clamp(alpha, 0, 1));
  return p;
}

/**
 * A stroke that actually blooms. The SVG reference had to fake its glow with layered translucent
 * strokes because SVG cannot blur; this is a GPU, so the trail's halo is a real Gaussian one.
 * `sigma` is in metres — the mask filter respects the CTM, so the bloom scales with the zoom.
 */
function glowStroke(f: Frame, hex: string, width: number, alpha: number, sigma: number): SkPaint {
  const p = f.res.glowStroke;
  f.res.setStrokeGlowBlur(Math.max(0.02, sigma));
  p.setStyle(PaintStyle.Stroke);
  p.setShader(null);
  p.setPathEffect(null);
  p.setStrokeWidth(Math.max(1e-4, width));
  p.setColor(f.res.color(hex));
  p.setAlphaf(clamp(alpha, 0, 1));
  return p;
}

function dashPaint(f: Frame, hex: string, width: number, on: number, off: number, alpha = 1): SkPaint {
  const p = f.res.dashed;
  p.setStyle(PaintStyle.Stroke);
  p.setShader(null);
  p.setStrokeCap(StrokeCap.Butt);
  p.setStrokeWidth(Math.max(1e-4, width));
  p.setPathEffect(f.res.dash(Math.max(1e-3, on), Math.max(1e-3, off)));
  p.setColor(f.res.color(hex));
  p.setAlphaf(clamp(alpha, 0, 1));
  return p;
}

/** Draw a unit-space shader (radius 1 around the origin) as an ellipse at (x, y). */
function shadeEllipse(canvas: SkCanvas, f: Frame, shader: Parameters<SkPaint['setShader']>[0], x: number, y: number, rx: number, ry: number, alpha: number, rotation = 0): void {
  const p = f.res.shaded;
  p.setStyle(PaintStyle.Fill);
  p.setShader(shader);
  p.setColor(f.res.color('#FFFFFF'));
  p.setAlphaf(clamp(alpha, 0, 1));
  canvas.save();
  canvas.translate(x, y);
  if (rotation) canvas.rotate((rotation * 180) / Math.PI, 0, 0);
  canvas.scale(Math.max(1e-4, rx), Math.max(1e-4, ry));
  canvas.drawCircle(0, 0, 1, p);
  canvas.restore();
}

/** Draw a unit-space vertical gradient (0 → 1 down) across a rectangle. */
function shadeRect(canvas: SkCanvas, f: Frame, shader: Parameters<SkPaint['setShader']>[0], x: number, y: number, w: number, h: number, alpha = 1): void {
  const p = f.res.shaded;
  p.setStyle(PaintStyle.Fill);
  p.setShader(shader);
  p.setColor(f.res.color('#FFFFFF'));
  p.setAlphaf(clamp(alpha, 0, 1));
  canvas.save();
  canvas.translate(x, y);
  canvas.scale(Math.max(1e-4, w), Math.max(1e-4, h));
  canvas.drawRect({ x: 0, y: 0, width: 1, height: 1 }, p);
  canvas.restore();
}

type Anchor = 'start' | 'middle' | 'end';

interface TextOpts {
  color?: string;
  alpha?: number;
  anchor?: Anchor;
  /** Letter spacing in points (the labels in this design are tracked 8–12 %). */
  tracking?: number;
  /** Outline colour drawn under the fill, so a label stays legible over the world. */
  outline?: string;
  outlineW?: number;
}

function fontKey(fonts: SceneFonts, font: SkFont): string {
  for (const k of Object.keys(fonts) as Array<keyof SceneFonts>) if (fonts[k] === font) return k;
  return 'x';
}

function measure(f: Frame, font: SkFont, s: string, tracking = 0): number {
  const key = fontKey(f.fonts, font);
  if (!tracking) return f.res.width(font, key, s);
  const run = f.res.glyphs(font, key, s, tracking);
  return run.ids.length > 0 ? run.width : f.res.width(font, key, s) + tracking * Math.max(0, s.length - 1);
}

function drawStr(canvas: SkCanvas, f: Frame, font: SkFont | null, s: string, x: number, y: number, o: TextOpts = {}): number {
  if (!font || !s) return 0;
  const tracking = o.tracking ?? 0;
  const w = measure(f, font, s, tracking);
  const left = o.anchor === 'middle' ? x - w / 2 : o.anchor === 'end' ? x - w : x;
  const paint = f.res.text;
  const draw = (col: string, alpha: number, style: PaintStyle, strokeW = 0) => {
    paint.setStyle(style);
    paint.setShader(null);
    paint.setStrokeWidth(strokeW);
    paint.setStrokeJoin(StrokeJoin.Round);
    paint.setColor(f.res.color(col));
    paint.setAlphaf(clamp(alpha, 0, 1));
    if (!tracking) {
      canvas.drawText(s, left, y, paint, font);
      return;
    }
    const run = f.res.glyphs(font, fontKey(f.fonts, font), s, tracking);
    if (run.ids.length === 0) {
      canvas.drawText(s, left, y, paint, font);
      return;
    }
    canvas.drawGlyphs(run.ids, run.pos, left, y, font, paint);
  };
  const alpha = o.alpha ?? 1;
  if (o.outline) draw(o.outline, alpha, PaintStyle.Stroke, o.outlineW ?? 3);
  draw(o.color ?? WHITE, alpha, PaintStyle.Fill);
  return w;
}

/**
 * A big glowing number: a REAL blurred copy under a thin bloom stroke and the fill. The SVG
 * reference stacked three translucent strokes because SVG has no blur; here the blur is one
 * draw, and reduce-motion falls back to the stroke-only construction.
 */
function drawGlowStr(canvas: SkCanvas, f: Frame, font: SkFont | null, s: string, x: number, y: number, fillCol: string, glowCol: string, glowOpacity: number, anchor: Anchor = 'start', size = 40): number {
  if (!font || !s) return 0;
  const w = measure(f, font, s);
  const left = anchor === 'middle' ? x - w / 2 : anchor === 'end' ? x - w : x;
  if (glowOpacity > 0.02) {
    f.res.setGlowBlur(size * 0.2);
    const g = f.res.glow;
    g.setStyle(PaintStyle.Fill);
    g.setShader(null);
    g.setColor(f.res.color(glowCol));
    g.setAlphaf(clamp(glowOpacity * 0.9, 0, 1));
    canvas.drawText(s, left, y, g, font);
  }
  const p = f.res.text;
  const stroke = (width: number, alpha: number) => {
    p.setStyle(PaintStyle.Stroke);
    p.setShader(null);
    p.setStrokeJoin(StrokeJoin.Round);
    p.setStrokeWidth(width);
    p.setColor(f.res.color(glowCol));
    p.setAlphaf(clamp(alpha, 0, 1));
    canvas.drawText(s, left, y, p, font);
  };
  stroke(size * 0.08, glowOpacity);
  p.setStyle(PaintStyle.Fill);
  p.setColor(f.res.color(fillCol));
  p.setAlphaf(1);
  canvas.drawText(s, left, y, p, font);
  return w;
}

/** Points text; the engine owns the rule so both renderers agree. */
const pts = formatPoints;

// ---------------------------------------------------------------- world layers
function drawGround(canvas: SkCanvas, f: Frame): void {
  const { minX, maxX, minY, maxY } = f.vis;
  canvas.drawRect({ x: minX, y: minY, width: maxX - minX, height: maxY - minY }, fillPaint(f, GROUND));
  const b = f.replay.bounds;
  const cx = f.overview ? 0.5 * (b.minX + b.maxX) : f.pose.x;
  const cy = f.overview ? 0.5 * (b.minY + b.maxY) : f.pose.y;
  const rr = f.overview ? 0.62 * Math.max(b.maxX - b.minX, b.maxY - b.minY) : 0.55 * (maxX - minX);
  shadeEllipse(canvas, f, f.res.pool, cx, cy, rr, rr, 1);
  // NO GRID. A blue graph-paper grid, rebuilt as a Skia path every frame, made the overview read
  // as a chart of a lap rather than a shot of one. The ground is lit instead: a second, tighter
  // pool of sodium light over the action, which is what a night circuit looks like from above.
  if (f.overview) shadeEllipse(canvas, f, f.res.pool, cx, cy, rr * 0.55, rr * 0.55, 0.55);
}

function drawRoad(canvas: SkCanvas, f: Frame): void {
  const g = f.geo;
  if (!g.road) return;
  const verge = ROAD_W + 7;
  // one pass per material: gravel run-off, verge, then the asphalt itself
  canvas.drawPath(g.road, strokePaint(f, RUNOFF, verge + 6));
  canvas.drawPath(g.road, strokePaint(f, VERGE, verge));
  canvas.drawPath(g.road, strokePaint(f, ASPHALT_HI, ROAD_W + 1.4));
  canvas.drawPath(g.road, strokePaint(f, ASPHALT_LO, ROAD_W));
  const ew = mOrPx(f, 0.28, 0.9);
  for (const e of g.edges) canvas.drawPath(e, strokePaint(f, EDGE_LINE, ew, 0.95));
  canvas.drawPath(g.road, dashPaint(f, CENTRE_LINE, mOrPx(f, 0.18, 0.6), 2.5, 3.5));

  if (f.overview) {
    const ring = strokePaint(f, MUTED, mOrPx(f, 0.6, 0.8), 0.3);
    for (const c of g.corners) {
      if (!inView(f, c.x, c.y)) continue;
      canvas.drawCircle(c.x, c.y, mOrPx(f, 6, 9), ring);
    }
  }
  if (g.kerbs) {
    const kw = mOrPx(f, 1.1, 2.4);
    const kerbDash = mOrPx(f, 2, 4);
    canvas.drawPath(g.kerbs, strokePaint(f, KERB_PALE, kw, 0.35));
    canvas.drawPath(g.kerbs, dashPaint(f, colors.red, kw, kerbDash, kerbDash, 0.3));
  }
  if (f.cam.zoom > 2) {
    const chip = strokePaint(f, MUTED, mOrPx(f, 0.2, 0.7), 0.45);
    for (const c of g.corners) {
      if (!inView(f, c.x, c.y)) continue;
      canvas.drawCircle(c.x, c.y, mOrPx(f, 0.55, 1.6), chip);
    }
  }
  if (g.gate) {
    const { ax, ay, bx, by } = g.gate;
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy) || 1;
    const nx = (-dy / len) * 0.8;
    const ny = (dx / len) * 0.8;
    const p = dashPaint(f, '#E8ECF1', 1.5, 1.4, 1.4, 0.85);
    canvas.drawLine(ax - nx, ay - ny, bx - nx, by - ny, p);
    canvas.drawLine(ax + nx, ay + ny, bx + nx, by + ny, p);
  }
}

/**
 * The part of a polyline that has been played, in world metres — broken wherever the position
 * was not measured, so the line is never drawn confidently through a hole in the data.
 */
function partialPath(f: Frame, from: number, to: number): SkPath | null {
  if (to <= from) return null;
  const tr = f.replay.trail;
  // the engine's own mask: 1 where a GPS fix really brackets this sample
  const measured = tr.measured;
  const b = Skia.PathBuilder.Make();
  let drawn = 0;
  // The SAME smoothing the finished ribbon is built with (`geometry.ts`), or the piece being
  // drawn right now would be a faceted polyline that visibly changes shape the instant the
  // segment completes. Endpoints are held, so the tip stays exactly under the car.
  let run: Array<[number, number]> = [];
  const flush = () => {
    if (run.length < 2) {
      run = [];
      return;
    }
    const s = run.length > 2 ? smoothPolyline(run, 2) : run;
    b.moveTo(s[0][0], s[0][1]);
    for (let i = 1; i < s.length; i++) {
      b.lineTo(s[i][0], s[i][1]);
      drawn++;
    }
    run = [];
  };
  for (let i = from; i <= to; i++) {
    if (measured[i] === 0) {
      flush();
      continue;
    }
    run.push([tr.x[i], tr.y[i]]);
  }
  flush();
  if (drawn === 0) {
    const p = b.detach();
    p.dispose();
    return null;
  }
  return b.detach();
}

function drawTrail(canvas: SkCanvas, f: Frame): void {
  const g = f.geo;
  const cur = f.cur;
  const boost = f.overview ? 1.6 : 1;

  // The driven line where the car was NOT drifting (the future is never drawn: it spoils the
  // route). On a run with no drift in it this hairline IS the replay, so it is drawn to be seen
  // rather than to stay out of the ribbons' way.
  //
  // AND IT IS NOT EMBER. It was, at 0.55 alpha and double width, which put the whole driven line
  // of `clean` — footer: 0 DRIFTS — in the colour that means a slide. `heat(f, 0)` is the ramp
  // asked what zero slip looks like, and the gate's answer is the neutral: one rule, no second
  // constant to keep in step with it.
  const clean = f.replay.segments.length === 0;
  const lineCol = heat(f, 0);
  const lineW = mOrPx(f, clean ? 0.6 : 0.35, clean ? 1.8 : 1);
  const lineAlpha = clean ? 0.55 : 0.18;
  // stretches with no GPS behind them are a guess: dashed, never lit, whatever the car was doing
  const gapDash = mOrPx(f, 1.6, 4);
  for (const run of g.gaps) {
    if (run.startIndex > cur || !overlaps(f, run.bounds)) continue;
    const whole = run.endIndex <= cur;
    const path = whole ? run.path : gapPath(f, run.startIndex, cur);
    if (!path) continue;
    canvas.drawPath(path, dashPaint(f, MUTED, mOrPx(f, 0.35, 1.2), gapDash, gapDash, 0.5));
    if (!whole) path.dispose();
  }
  for (const run of g.runs) {
    if (run.startIndex > cur || !overlaps(f, run.bounds)) continue;
    if (run.endIndex <= cur) {
      canvas.drawPath(run.path, strokePaint(f, lineCol, lineW, lineAlpha));
    } else {
      const path = partialPath(f, run.startIndex, cur);
      if (path) {
        canvas.drawPath(path, strokePaint(f, lineCol, lineW, lineAlpha));
        path.dispose();
      }
    }
  }

  // drift ribbons: halo + glow per segment (one polyline each — overlapping translucent chunks
  // make a lattice), then the opaque core/hot chunks whose width AND colour follow |β|
  const haloW = mOrPx(f, 4.6, 6);
  const glowW = mOrPx(f, 2.2, 3);
  for (const sg of g.segments) {
    const seg = sg.seg;
    if (seg.startIndex > cur || !overlaps(f, sg.bounds)) continue;
    const done = seg.endIndex <= cur;
    const path = done ? sg.ribbon : partialPath(f, seg.startIndex, cur);
    if (!path) continue;
    const w = severityWeight(seg.severity);
    const focus = f.ui.focusDriftId !== null && f.ui.focusDriftId === seg.driftId;
    // the halo's heat is the peak SO FAR, never the peak this slide will reach
    const col = driftHeat(f, sg.peakTo[Math.max(0, Math.min(seg.endIndex, cur) - seg.startIndex)]);
    canvas.drawPath(path, glowStroke(f, col, haloW * (0.55 + 0.5 * w), (0.09 + 0.13 * w) * boost, haloW * 0.28));
    canvas.drawPath(path, strokePaint(f, col, glowW * (0.8 + 0.5 * w), (0.18 + 0.22 * w) * boost));
    if (focus) canvas.drawPath(path, strokePaint(f, WHITE, haloW * 1.1, 0.16));
    if (!done) path.dispose();
  }
  for (const sg of g.segments) {
    const seg = sg.seg;
    if (seg.startIndex > cur || !overlaps(f, sg.bounds)) continue;
    for (const chunk of sg.chunks) {
      if (!overlaps(f, chunk.bounds)) continue;
      const i = chunk.intensity;
      const width = chunk.hot ? mOrPx(f, 0.05 + 0.3 * i, 0.4) : mOrPx(f, 0.3 + 0.75 * i, 1.2);
      const paint = strokePaint(f, tint(f, chunk.color), width, chunk.hot ? 0.92 : 1);
      if (chunk.endIndex <= cur) {
        canvas.drawPath(chunk.path, paint);
      } else if (chunk.startIndex < cur) {
        // the chunk the car is inside right now: only the part that has already happened
        const partial = partialPath(f, chunk.startIndex, cur);
        if (partial) {
          canvas.drawPath(partial, paint);
          partial.dispose();
        }
      }
    }
  }

  // in overview the whole route is implied by the road; drift peaks get a bloom so the eye lands
  // on the big moments rather than on an even orange noodle
  if (f.overview) {
    const tr = f.replay.trail;
    for (const sg of g.segments) {
      const seg = sg.seg;
      if (seg.peakT > f.t || !inView(f, tr.x[seg.peakIndex], tr.y[seg.peakIndex])) continue;
      const w = severityWeight(seg.severity);
      if (w < 0.45) continue;
      canvas.drawCircle(tr.x[seg.peakIndex], tr.y[seg.peakIndex], mOrPx(f, 7, 9), fillPaint(f, driftHeat(f, seg.peakAngle), 0.1 + 0.12 * w));
    }
  }
}


/** The straight line across a gap, up to the played index (the dashed "we do not know" line). */
function gapPath(f: Frame, from: number, to: number): SkPath | null {
  if (to <= from) return null;
  const tr = f.replay.trail;
  const b = Skia.PathBuilder.Make();
  b.moveTo(tr.x[from], tr.y[from]);
  for (let i = from + 1; i <= to; i++) b.lineTo(tr.x[i], tr.y[i]);
  return b.detach();
}

function drawSmoke(canvas: SkCanvas, f: Frame): void {
  const live = liveSmoke(f.replay.smoke, f.t);
  for (const p of live) {
    const st = smokeAt(p, f.t);
    if (!st || !inView(f, st.x, st.y)) continue;
    // Two or three offset lobes per puff, each rotated, so a cloud reads as distinct volumes
    // rather than one soft blob. Everything is derived from the particle's `seed`, so this is the
    // same cloud the SVG renderer draws.
    const rx = st.radius * 1.15 * (1 + 0.35 * (st.seed - 0.5));
    const ry = st.radius * 1.15 * (0.72 + 0.3 * st.seed);
    const lobes = st.seed > 0.45 ? 3 : 2;
    canvas.save();
    canvas.translate(st.x, st.y);
    canvas.rotate((st.rotation * 180) / Math.PI, 0, 0);
    for (let i = 0; i < lobes; i++) {
      const a = st.seed * 6.283 + i * 2.4 + st.age * 1.1;
      const d = st.radius * (0.18 + 0.42 * st.age) * (i === 0 ? 0.25 : 1);
      const k = i === 0 ? 1 : 0.62 + 0.26 * ((st.seed * (i + 3)) % 1);
      shadeEllipse(canvas, f, f.res.smoke, Math.cos(a) * d, Math.sin(a) * d * 0.7, rx * k, ry * k, Math.min(1, st.opacity * 1.15));
    }
    // temperature gradient: fresh rubber burns white-hot at the contact patch, then cools
    if (st.heat > 0.04) {
      shadeEllipse(canvas, f, f.res.smokeHot, 0, 0, rx * 0.46, ry * 0.46, st.opacity * st.heat);
      const warm = mix('#B9C0CB', '#FFC9A2', st.heat);
      canvas.save();
      canvas.scale(rx * 0.8, ry * 0.8);
      canvas.drawCircle(0, 0, 1, fillPaint(f, warm, st.opacity * st.heat * 0.22));
      canvas.restore();
    }
    canvas.restore();
  }
}

/** Markers on the lap being watched; older laps leave an unlabelled breadcrumb. */
function visibleMarkers(f: Frame): ReplayMarker[] {
  const lap = lapAt(f.replay, f.t);
  const li = lap ? lap.index : -1;
  return f.replay.markers.filter((m) => m.t <= f.t && (m.lapIndex === li || li < 0));
}

function drawMarkers(canvas: SkCanvas, f: Frame): void {
  const r = f.replay;
  const pw = mOrPx(f, 0.3, 1);
  const lap = lapAt(r, f.t);
  const li = lap ? lap.index : -1;
  // previous laps: a 3 px breadcrumb, no ring, no label. The peak breadcrumb is a RAMP colour —
  // the same dot the current lap draws, one lap older — so it goes through the gate; the
  // transition's magenta is a beat rather than a severity and never did.
  for (const m of r.markers) {
    if (m.t > f.t || (m.lapIndex === li && li >= 0) || !inView(f, m.x, m.y)) continue;
    if (m.kind === 'transition' || m.kind === 'drift-peak') {
      canvas.drawCircle(m.x, m.y, mOrPx(f, 0.5, 1.5), fillPaint(f, m.kind === 'transition' ? colors.magenta : driftHeat(f, SEVERITY_EDGES.hold), 0.28));
    }
  }
  for (const m of visibleMarkers(f)) {
    if (!inView(f, m.x, m.y)) continue;
    const age = f.t - m.t;
    switch (m.kind) {
      case 'transition': {
        // a small chip (a 100 pt ring behind the car stole the eye from the car itself)
        const pulse = age < 0.7 ? 1 + 0.9 * (1 - age / 0.7) : 1;
        const rr = mOrPx(f, 1.6, 4) * pulse;
        canvas.save();
        canvas.translate(m.x, m.y);
        canvas.drawCircle(0, 0, rr * 1.9, fillPaint(f, colors.magenta, 0.1 * (age < 1 ? 1 : 0.4)));
        canvas.save();
        canvas.scale(rr, rr);
        canvas.drawPath(f.geo.diamond, fillPaint(f, colors.magenta));
        canvas.scale(0.45, 0.45);
        canvas.drawPath(f.geo.diamond, fillPaint(f, WHITE, 0.9));
        canvas.restore();
        canvas.restore();
        break;
      }
      case 'drift-peak': {
        const col = driftHeat(f, m.peakAngle ?? 0);
        canvas.drawCircle(m.x, m.y, mOrPx(f, 2, 2.6), strokePaint(f, col, pw, 0.5));
        canvas.drawCircle(m.x, m.y, mOrPx(f, 0.7, 1.2), fillPaint(f, col));
        break;
      }
      // The two ends of a slide. `SEVERITY_EDGES.hold` is the bottom of the ramp, which is
      // ember: these ticks mark that a slide STARTED and ENDED here, not how big it got — the
      // peak is drawn where it happened, and a start tick in the colour of a peak the car has
      // not reached yet gives the slide away before it arrives.
      //
      // They were raw `colors.ember`, outside the gate. On `fixture-handheld` at t=60 — a
      // recording stamped NOT SCORED, with every ribbon, halo, chunk, label and minimap around
      // them correctly grey — the two of them plus the breadcrumb above drew 818 ember pixels in
      // one cluster two inches under the words, which is the gate leaking at the one moment it
      // exists for.
      case 'drift-end':
        canvas.drawCircle(m.x, m.y, mOrPx(f, 0.6, 1), fillPaint(f, driftHeat(f, SEVERITY_EDGES.hold), 0.75));
        break;
      case 'drift-start': {
        const nx = -Math.sin(m.course);
        const ny = Math.cos(m.course);
        canvas.drawLine(m.x - nx * 2, m.y - ny * 2, m.x + nx * 2, m.y + ny * 2, strokePaint(f, driftHeat(f, SEVERITY_EDGES.hold), pw, 0.6));
        break;
      }
      default:
        break;
    }
  }
}

function drawGhost(canvas: SkCanvas, f: Frame): void {
  const g = f.ghost;
  if (!g) return;
  const gs = toS(f, g.x, g.y);
  const st = f.action;
  const onScreen = gs.x > 0 && gs.x < f.layout.w && gs.y > st.y && gs.y < st.y + st.h;
  if (!onScreen) return;
  const lap = lapAt(f.replay, f.t);
  const tail: Array<{ x: number; y: number }> = [];
  for (let k = 0; k <= 18; k++) {
    const tk = f.t - k * 0.1;
    if (tk < 0 || lapAt(f.replay, tk) !== lap) break;
    const gp = ghostPoseAt(f.replay, tk);
    if (!gp) break;
    tail.push({ x: gp.x, y: gp.y });
  }
  if (tail.length > 1) {
    const b = Skia.PathBuilder.Make();
    b.moveTo(tail[0].x, tail[0].y);
    for (let i = 1; i < tail.length; i++) b.lineTo(tail[i].x, tail[i].y);
    const path = b.detach();
    const d = mOrPx(f, 1.1, 3);
    canvas.drawPath(path, dashPaint(f, colors.green, mOrPx(f, 0.45, 1.4), d, d, 0.5));
    path.dispose();
  }
  // Distance-syncing puts the ghost beside the car, and for part of the lap underneath it. Fade
  // it out below ~2.6 m of separation rather than popping in and out from under the white car;
  // the badge carries the number regardless.
  const sepM = Math.hypot(g.x - f.pose.x, g.y - f.pose.y);
  const bodyFade = clamp((sepM - 1.2) / 1.4, 0, 1);
  if (bodyFade <= 0.03) return;
  const cs = carScale(f) * 0.92;
  canvas.save();
  canvas.translate(g.x, g.y);
  canvas.rotate(deg(g.heading), 0, 0);
  canvas.scale(cs, cs);
  canvas.drawPath(f.geo.car.body, fillPaint(f, BG, 0.45 * bodyFade));
  const dash = 0.9 / cs;
  canvas.drawPath(f.geo.car.body, dashPaint(f, colors.green, mOrPx(f, 0.22, 0.9) / cs, dash, dash * 0.5, 0.8 * bodyFade));
  canvas.save();
  canvas.scale(0.55, 0.55);
  canvas.drawPath(f.geo.car.chevron, fillPaint(f, colors.green, 0.6 * bodyFade));
  canvas.restore();
  canvas.restore();
}

function drawCar(canvas: SkCanvas, f: Frame): void {
  const p = f.pose;
  const cs = carScale(f);
  const col = heat(f, p.beta);
  const slip = Math.abs(p.beta);

  // THE REVEAL OWNS THE FRAME, and that includes the car. The world labels and the callout are
  // already taken off as the grade lands; the sprite was not, so on the last frame the grey body
  // sat inside the "23050" and through the word POINTS. It fades on the same ramp as everything
  // else the letter takes the frame from, rather than popping. The layer is only paid for while
  // the reveal is running — an offscreen on every frame of the run would cost the whole replay
  // for a second and a bit of it.
  const fading = f.reveal > 0;
  if (fading) {
    if (f.reveal >= 0.99) return;
    canvas.saveLayer(f.res.layerAlpha(1 - f.reveal));
  }
  canvas.save();
  canvas.translate(p.x, p.y);

  // under-glow while sliding, coloured by severity
  if (p.intensity > 0.02 || p.phase === 'drifting') {
    const gi = 0.22 + 0.65 * p.intensity;
    canvas.save();
    canvas.rotate(deg(p.heading), 0, 0);
    canvas.save();
    canvas.scale(3.1 * cs, 1.9 * cs);
    canvas.drawCircle(0, 0, 1, fillPaint(f, col, gi * 0.3));
    canvas.restore();
    canvas.save();
    canvas.scale(2.3 * cs, 1.35 * cs);
    canvas.drawCircle(0, 0, 1, fillPaint(f, col, gi * 0.3));
    canvas.restore();
    canvas.restore();
  }

  // velocity vector: only when there is actually slip to explain, opacity by |β|
  if (slip > SEVERITY_EDGES.hold * 0.9 && p.speed > 2) {
    const k = clamp((slip - SEVERITY_EDGES.hold * 0.9) / (SEVERITY_EDGES.big - SEVERITY_EDGES.hold * 0.9), 0, 1);
    const op = 0.35 + 0.55 * k;
    const L = clamp(0.5 * p.speed, 3, 18) * (f.overview ? cs * 0.5 : 1);
    canvas.drawLine(0, 0, Math.cos(p.course) * L, Math.sin(p.course) * L, strokePaint(f, colors.cyan, mOrPx(f, 0.35, 1.1), op));
    const ah = mOrPx(f, 1.2, 3.4);
    canvas.save();
    canvas.rotate(deg(p.course), 0, 0);
    canvas.translate(L, 0);
    canvas.scale(ah, ah);
    canvas.drawPath(f.geo.arrowHead, fillPaint(f, colors.cyan, op));
    canvas.restore();
  }

  // heading line + slip arc, scaled with the marker so they stay legible
  if (!f.overview && slip > 0.035) {
    const hl = 6.5 * cs;
    const dashLen = 0.6 * cs;
    canvas.drawLine(0, 0, Math.cos(p.heading) * hl, Math.sin(p.heading) * hl, dashPaint(f, WHITE, mOrPx(f, 0.16, 0.7), dashLen, dashLen * 0.83, 0.5));
    const R = 5.2 * cs;
    const sweep = wrapAngle(p.course - p.heading);
    const arc = Skia.PathBuilder.Make().addArc({ x: -R, y: -R, width: 2 * R, height: 2 * R }, deg(p.heading), deg(sweep)).detach();
    canvas.drawPath(arc, strokePaint(f, col, mOrPx(f, 0.35 + 0.5 * p.intensity, 1.1)));
    arc.dispose();
  }

  // body
  canvas.save();
  canvas.rotate(deg(p.heading), 0, 0);
  canvas.scale(cs, cs);
  canvas.drawPath(f.geo.car.body, strokePaint(f, BG, mOrPx(f, 0.5, 1.5) / cs, 0.9));
  for (const w of f.geo.car.wheels) canvas.drawRect({ x: w.x - 0.38, y: w.y - 0.2, width: 0.76, height: 0.4 }, fillPaint(f, '#242A33'));
  canvas.drawPath(f.geo.car.body, fillPaint(f, WHITE));
  canvas.drawPath(f.geo.car.glassFront, fillPaint(f, '#6E7784'));
  canvas.drawPath(f.geo.car.glassRear, fillPaint(f, '#8F98A4'));
  canvas.drawPath(f.geo.car.chevron, fillPaint(f, BG));
  // a severity rim so the car itself carries the drama at a glance
  if (p.intensity > 0.25) canvas.drawPath(f.geo.car.body, strokePaint(f, col, 0.18 + 0.22 * p.intensity, 0.5 + 0.5 * p.intensity));
  canvas.restore();
  canvas.restore();
  if (fading) canvas.restore();
}

// ---------------------------------------------------------------- screen space
interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Rejects labels that would collide with one already placed (priority order). */
class LabelCollider {
  private boxes: Box[] = [];
  constructor(private bounds: Box) {}
  reserve(b: Box): void {
    this.boxes.push(b);
  }
  private boxFor(x: number, y: number, w: number, h: number, anchor: Anchor): Box {
    const x0 = anchor === 'start' ? x : anchor === 'end' ? x - w : x - w / 2;
    return { x0: x0 - 2, y0: y - h, x1: x0 + w + 2, y1: y + 3 };
  }
  place(x: number, y: number, w: number, h: number, anchor: Anchor = 'start'): boolean {
    const box = this.boxFor(x, y, w, h, anchor);
    if (box.x0 < this.bounds.x0 || box.x1 > this.bounds.x1 || box.y0 < this.bounds.y0 || box.y1 > this.bounds.y1) return false;
    for (const b of this.boxes) if (box.x0 < b.x1 && box.x1 > b.x0 && box.y0 < b.y1 && box.y1 > b.y0) return false;
    this.boxes.push(box);
    return true;
  }
  /**
   * How much of this label would land on something already placed, plus how far it would hang
   * outside the frame. A label that MUST be drawn (the ghost's gap is load-bearing) takes the
   * least-bad position instead of the last one in the list, which is how it used to end up
   * squarely on the mini-map.
   */
  cost(x: number, y: number, w: number, h: number, anchor: Anchor = 'start'): number {
    const box = this.boxFor(x, y, w, h, anchor);
    let c = 0;
    for (const b of this.boxes) {
      const ox = Math.min(box.x1, b.x1) - Math.max(box.x0, b.x0);
      const oy = Math.min(box.y1, b.y1) - Math.max(box.y0, b.y0);
      if (ox > 0 && oy > 0) c += ox * oy;
    }
    const out =
      Math.max(0, this.bounds.x0 - box.x0) + Math.max(0, box.x1 - this.bounds.x1) + Math.max(0, this.bounds.y0 - box.y0) + Math.max(0, box.y1 - this.bounds.y1);
    return c + out * 40;
  }
}

/** Motion streaks along the travel direction at the frame edges — speed you can see. */
function drawStreaks(canvas: SkCanvas, f: Frame): void {
  if (f.overview || f.ui.reduceMotion) return;
  const k = clamp((f.pose.speed - 11) / 19, 0, 1);
  if (k <= 0.02) return;
  const st = f.action;
  const paint = strokePaint(f, WHITE, 0.7 + 0.8 * k, 0.05 + 0.13 * k);
  let h = 987654321;
  for (let i = 0; i < 14; i++) {
    h = (Math.imul(h, 1664525) + 1013904223) >>> 0;
    const side = i % 2 === 0 ? 1 : -1;
    const edge = ((h >>> 9) % 1000) / 1000;
    const x = side > 0 ? f.layout.w * (0.02 + 0.2 * edge) : f.layout.w * (0.78 + 0.2 * edge);
    h = (Math.imul(h, 1664525) + 1013904223) >>> 0;
    const y = st.y + (((h >>> 9) % 1000) / 1000) * st.h;
    const len = (22 + 70 * k) * (0.6 + 0.8 * (((h >>> 3) % 100) / 100));
    canvas.drawLine(x, y, x, y + len, paint);
  }
}

/**
 * Two-line ghost readout placed wherever it fits. The gap is load-bearing, so if no candidate is
 * free it is drawn at the last one anyway rather than leaving a mute chevron.
 */
function drawGhostLabel(canvas: SkCanvas, f: Frame, col: LabelCollider, x: number, y: number, value: string, positive: boolean, r: number, away: { x: number; y: number } | null): void {
  const font = f.fonts.label;
  if (!font) return;
  const w = Math.max(58, measure(f, font, value, 0.4) + 6);
  const d = away ? Math.hypot(away.x, away.y) : 0;
  const ux = d > 1e-3 ? away!.x / d : 1;
  const uy = d > 1e-3 ? away!.y / d : 0;
  const push = r + 26;
  const cands: Array<[number, number, Anchor]> = [
    [ux * push, uy * push + 6, ux < 0 ? 'end' : 'start'],
    [r + 12, 6, 'start'],
    [-(r + 12), 6, 'end'],
    [0, -(r + 16), 'middle'],
    [0, r + 38, 'middle'],
    [r + 12, -(r + 16), 'start'],
    [-(r + 12), r + 38, 'end'],
  ];
  let pick: [number, number, Anchor] | null = null;
  for (const c of cands) {
    if (col.place(x + c[0], y + c[1], w, 28, c[2])) {
      pick = c;
      break;
    }
  }
  if (!pick) {
    // nothing is free: take the position that covers the least of what is already there
    let bestCost = Infinity;
    for (const c of cands) {
      const cost = col.cost(x + c[0], y + c[1], w, 28, c[2]);
      if (cost < bestCost) {
        bestCost = cost;
        pick = c;
      }
    }
  }
  const [dx, dy, anchor] = pick ?? cands[0];
  drawStr(canvas, f, font, 'BEST LAP', x + dx, y + dy - 14, { color: colors.green, tracking: 1.2, anchor, outline: BG, outlineW: 3.5 });
  drawStr(canvas, f, font, value, x + dx, y + dy, { color: positive ? colors.green : MUTED, anchor, outline: BG, outlineW: 3.5 });
}

function drawWorldLabels(canvas: SkCanvas, f: Frame): void {
  const st = f.action;
  const col = new LabelCollider({ x0: f.layout.insets.left + 14, y0: st.y + 10, x1: f.layout.w - f.layout.insets.right - 14, y1: st.y + st.h - 14 });
  const carS = toS(f, f.pose.x, f.pose.y);
  col.reserve({ x0: carS.x - 46, y0: carS.y - 52, x1: carS.x + 46, y1: carS.y + 40 });
  // in landscape the hero angle and the speed/points block float over the world, so they own
  // their corners the same way the car owns its own space
  if (!f.layout.hero.inBar) {
    const h = f.layout.hero;
    col.reserve({ x0: h.x - 8, y0: h.baseline - TYPE.hero, x1: h.x + 170, y1: h.baseline + 22 });
    const r = f.layout.readout;
    col.reserve({ x0: r.x - 170, y0: r.baseline - 46, x1: r.x + 8, y1: r.baseline + 34 });
  }
  // the mini-map is drawn after the labels and would sit on top of any that land under it
  {
    const m = minimapRect(f);
    if (!f.overview) col.reserve({ x0: m.x - 6, y0: m.y - 6, x1: m.x + m.size + 6, y1: m.y + m.size + 6 });
  }

  // the slip readout, beside the arc
  const p = f.pose;
  if (Math.abs(p.beta) > 0.05 && !f.overview) {
    const mid = p.heading + 0.5 * wrapAngle(p.course - p.heading);
    const R = 6.4 * carScale(f);
    const lp = toS(f, p.x + Math.cos(mid) * R, p.y + Math.sin(mid) * R);
    drawStr(canvas, f, f.fonts.mid, `${Math.round(Math.abs(deg(p.beta)))}°`, lp.x, lp.y + 5, { color: heat(f, p.beta), anchor: 'middle', outline: BG, outlineW: 3.5 });
  }

  // markers, highest priority first, de-conflicted in screen space
  const ms = [...visibleMarkers(f)].sort((a, b) => b.priority - a.priority || b.t - a.t);
  // whatever the hero callout is saying right now, the world does not say it again in 13 pt
  const live = new Set(f.events.filter((e) => e.label !== '').map((e) => e.label));
  for (const m of ms) {
    if (!inView(f, m.x, m.y)) continue;
    if (live.has(m.label)) continue;
    const sp = toS(f, m.x, m.y);
    let label = '';
    let fill: string = WHITE;
    let font = f.fonts.label;
    let size: number = TYPE.label;
    if (m.kind === 'transition' && !f.overview) {
      label = m.label;
      fill = colors.magenta;
    } else if (m.kind === 'drift-peak') {
      const sev = severityWeight(m.severity ?? 'none');
      if (f.overview && sev < 0.45) continue;
      label = m.label;
      fill = driftHeat(f, m.peakAngle ?? 0);
      if (sev >= 0.75) {
        font = f.fonts.peak;
        size = 16;
      }
    } else if (m.kind === 'drift-end' && !f.overview) {
      // a points award is a claim: an untrusted recording does not get to make it
      if (f.noScore) continue;
      label = m.label;
      fill = MUTED;
    } else if (m.kind === 'lap') {
      label = m.label;
      fill = MUTED;
    } else continue;
    if (!font || !label) continue;
    const tracking = m.kind === 'transition' ? 1.2 : 0;
    const w = measure(f, font, label, tracking);
    for (const [dx, dy, anchor] of [
      [11, 4, 'start'],
      [-11, 4, 'end'],
      [0, -12, 'middle'],
      [0, 18, 'middle'],
    ] as Array<[number, number, Anchor]>) {
      if (col.place(sp.x + dx, sp.y + dy, w, size, anchor)) {
        drawStr(canvas, f, font, label, sp.x + dx, sp.y + dy, { color: fill, anchor, tracking, outline: BG, outlineW: 3 });
        break;
      }
    }
  }

  // ghost: a label on screen, or a racing-game edge indicator when it is off screen
  const g = f.ghost;
  if (g && !f.overview) {
    const gp = toS(f, g.x, g.y);
    const onScreen = gp.x > 8 && gp.x < f.layout.w - 8 && gp.y > st.y && gp.y < st.y + st.h;
    // Points are the natural gap to show, but an untrusted run has no points to compare: the
    // TIME gap is still a measurement, so that is what it gets.
    const value = f.noScore
      ? `${g.gapS >= 0 ? '+' : '−'}${Math.abs(g.gapS).toFixed(1)} S`
      : `${g.gapPoints >= 0 ? '+' : '−'}${pts(Math.abs(g.gapPoints))} PTS`;
    const positive = f.noScore ? g.gapS >= 0 : g.gapPoints >= 0;
    if (onScreen) {
      drawGhostLabel(canvas, f, col, gp.x, gp.y, value, positive, 12, { x: gp.x - carS.x, y: gp.y - carS.y });
    } else {
      const dx = gp.x - carS.x;
      const dy = gp.y - carS.y;
      const inset = 30;
      let k = Infinity;
      if (dx > 0) k = Math.min(k, (f.layout.w - inset - carS.x) / dx);
      if (dx < 0) k = Math.min(k, (inset - carS.x) / dx);
      if (dy > 0) k = Math.min(k, (st.y + st.h - inset - carS.y) / dy);
      if (dy < 0) k = Math.min(k, (st.y + inset - carS.y) / dy);
      if (Number.isFinite(k) && k > 0) {
        const ex = carS.x + dx * k;
        const ey = carS.y + dy * k;
        canvas.save();
        canvas.translate(ex, ey);
        canvas.drawCircle(0, 0, 13, fillPaint(f, BG, 0.8));
        canvas.drawCircle(0, 0, 13, strokePaint(f, colors.green, 1.2, 0.85));
        canvas.rotate((Math.atan2(dy, dx) * 180) / Math.PI, 0, 0);
        canvas.save();
        canvas.translate(7, 0);
        canvas.scale(6, 6);
        canvas.drawPath(f.geo.arrowHead, fillPaint(f, colors.green));
        canvas.restore();
        canvas.restore();
        drawGhostLabel(canvas, f, col, ex, ey, value, positive, 18, { x: ex - carS.x, y: ey - carS.y });
      }
    }
  }
}

function minimapRect(f: Frame): { x: number; y: number; size: number } {
  const size = f.layout.landscape ? 58 : 66;
  const x = f.layout.w - f.layout.insets.right - 16 - size;
  const y = f.action.y + (f.layout.landscape ? 10 : 14);
  return { x, y, size };
}

function drawMinimap(canvas: SkCanvas, f: Frame): void {
  if (f.overview) return;
  const r = f.replay;
  const { x: x0, y: y0, size } = minimapRect(f);
  const b = r.content;
  const sc = (size - 10) / Math.max(1, Math.max(b.maxX - b.minX, b.maxY - b.minY));
  const mx = (x: number) => x0 + size / 2 + (x - (b.minX + b.maxX) / 2) * sc;
  const my = (y: number) => y0 + size / 2 - (y - (b.minY + b.maxY) / 2) * sc;
  const route: Array<{ x: number; y: number }> = [];
  if (r.track) for (let i = 0; i < r.track.path.length; i += 2) route.push({ x: mx(r.track.path[i].x), y: my(r.track.path[i].y) });
  else for (let i = 0; i < r.trail.n; i += 8) route.push({ x: mx(r.trail.x[i]), y: my(r.trail.y[i]) });
  if (route.length > 1) {
    const paint = strokePaint(f, '#39465A', 2, 0.92, StrokeCap.Round);
    canvas.drawPoints(PointMode.Polygon, r.track?.closed ? [...route, route[0]] : route, paint);
  }
  for (const sg of f.geo.segments) {
    const seg = sg.seg;
    if (seg.startIndex > f.cur) continue;
    const end = Math.min(seg.endIndex, f.cur);
    const sp: Array<{ x: number; y: number }> = [];
    for (let i = seg.startIndex; i <= end; i += 3) sp.push({ x: mx(r.trail.x[i]), y: my(r.trail.y[i]) });
    if (sp.length > 1) {
      const col = driftHeat(f, sg.peakTo[Math.max(0, end - seg.startIndex)]);
      canvas.drawPoints(PointMode.Polygon, sp, strokePaint(f, col, 1.7, 0.95, StrokeCap.Round));
    }
  }
  if (f.ghost) canvas.drawCircle(mx(f.ghost.x), my(f.ghost.y), 2, strokePaint(f, colors.green, 1));
  canvas.drawCircle(mx(f.pose.x), my(f.pose.y), 3, fillPaint(f, WHITE));
  canvas.drawCircle(mx(f.pose.x), my(f.pose.y), 3, strokePaint(f, BG, 1));
}

/** Event-driven callout: the slam comes from `activeEvents`, identical in Skia and SVG. */
function drawCallout(canvas: SkCanvas, f: Frame): void {
  const e = f.events.find((ev) => ev.label !== '');
  if (!e || !f.fonts.callout) return;
  // A points award is a claim; the beat still plays, without the number. The test is for a
  // SIGNED number anywhere in the label, because the beats that carry points are no longer
  // bare numbers: "+1250", "CHAIN LOST \u22128981" and "AT RISK +1380" are all claims about a
  // score, while "LOST IT 118\u00b0" is a measurement of the recording and stays.
  const label = f.noScore && isPointsClaim(e.label) ? '' : e.label;
  if (!label) return;
  const color = eventColor(e.kind);
  const y = Math.round(f.action.y + f.action.h * 0.3);
  const cx = f.layout.w / 2;
  const scale = f.ui.reduceMotion ? 1 : e.scale;
  canvas.save();
  canvas.translate(cx, y);
  canvas.scale(scale, scale);
  canvas.translate(-cx, -y);
  drawGlowStr(canvas, f, f.fonts.callout, label, cx, y, WHITE, color, 0.95 * e.opacity, 'middle', TYPE.callout);
  canvas.restore();
  // a leader line anchors overview callouts to the place they happened
  if (f.overview && e.driftId !== undefined) {
    const seg = f.replay.segments.find((g) => g.driftId === e.driftId);
    if (seg) {
      const sp = toS(f, f.replay.trail.x[seg.peakIndex], f.replay.trail.y[seg.peakIndex]);
      if (sp.y > y + 18) {
        canvas.drawLine(cx, y + 10, sp.x, sp.y - 8, dashPaint(f, color, 1, 3, 3, 0.35 * e.opacity));
        canvas.drawCircle(sp.x, sp.y - 8, 2.5, fillPaint(f, color, 0.6 * e.opacity));
      }
    }
  }
}

function drawTopHud(canvas: SkCanvas, f: Frame): void {
  const lay = f.layout;
  const r = f.replay;
  const p = f.pose;
  const solid = lay.topBar - 22;
  canvas.drawRect({ x: 0, y: 0, width: lay.w, height: solid }, fillPaint(f, '#000000'));
  shadeRect(canvas, f, f.res.topFade, 0, solid, lay.w, 22);

  // the leftmost 34 pt of the chrome row belong to the close control, which is a real button
  const tally = lay.chrome.left + 34;
  canvas.drawCircle(tally + 2, lay.chrome.y - 4, 3.4, fillPaint(f, colors.red));
  drawStr(canvas, f, f.fonts.label, 'REPLAY', tally + 11, lay.chrome.y, { tracking: 2.6 });
  drawStr(canvas, f, f.fonts.clock, `${fmtTime(f.t)} / ${fmtTime(r.durationS)}`, lay.w / 2, lay.chrome.y, { color: MUTED, anchor: 'middle' });
  const modeLabel = f.mode === 'overview' ? 'TRACK CAM' : f.mode === 'chase' ? 'CHASE CAM' : 'CINEMATIC';
  drawStr(canvas, f, f.fonts.label, modeLabel, lay.chrome.right, lay.chrome.y, { color: MUTED, anchor: 'end', tracking: 2 });
  if (f.ui.rate !== 1) {
    drawStr(canvas, f, f.fonts.label, `${f.ui.rate}×`, lay.w / 2 + 62, lay.chrome.y, { color: colors.cyan, tracking: 1 });
  }

  // in landscape the readouts float over the world, so give them a lower-third scrim
  if (!lay.hero.inBar) shadeRect(canvas, f, f.res.bottomFade, 0, lay.scrub.y - 118, lay.w, 118, 0.8);

  // tier 1: the angle is the biggest thing on screen (DESIGN.md), coloured by severity — until
  // the run is over, when the verdict takes the frame and a stopped car's 0° is worth nothing
  const angle = Math.round(Math.abs(deg(p.beta)));
  const side = Math.abs(p.beta) > 0.05 ? (p.beta > 0 ? 'R' : 'L') : '';
  const col = heat(f, p.beta);
  // an untrusted run's angle is still shown — it is what the recording contains — but it does
  // not get to glow about it
  const hot = p.severity !== 'none' && !f.noScore;
  const baseline = lay.hero.baseline;
  const text = `${angle}°`;
  if (f.reveal < 1) {
    const fade = 1 - f.reveal;
    let heroW = 0;
    if (hot) heroW = drawGlowStr(canvas, f, f.fonts.hero, text, lay.hero.x, baseline, WHITE, col, (0.4 + 0.6 * p.intensity) * fade, 'start', TYPE.hero);
    else heroW = drawStr(canvas, f, f.fonts.hero, text, lay.hero.x, baseline, { color: MUTED, alpha: fade });
    if (side) drawStr(canvas, f, f.fonts.label, side, lay.hero.x + heroW + 6, baseline - TYPE.hero * 0.58, { color: col, alpha: fade });
    drawStr(canvas, f, f.fonts.label, 'SLIP ANGLE', lay.hero.x, baseline + 14, { color: MUTED, tracking: 2, alpha: fade });
  }

  // tier 2: speed and points, italic (things that move)
  const rx = lay.readout.x;
  const rb = lay.readout.baseline;
  drawStr(canvas, f, f.fonts.value, `${kmh(p.speed)}`, rx, rb - 26, { anchor: 'end' });
  drawStr(canvas, f, f.fonts.label, 'KM/H', rx, rb - 12, { color: MUTED, anchor: 'end', tracking: 2 });
  // An untrusted run says so ONCE, on the plate at the top of the stage. It used to say it here
  // as well, and again in the footer, and hedge the slip-angle label, and print two lines of
  // uppercase body copy — seven pieces of bad news in the top fifth of the frame.
  // …and it hands the total over to the reveal rather than printing it twice on the last frame.
  // WHICH number this is, and whether there is one at all, is `headlinePoints` — a pure rule in
  // palette.ts that a test can run, rather than a ternary buried in a Skia call that only a
  // screenshot could catch getting it wrong (and did not, for a whole round).
  const headline = headlinePoints({ trusted: !f.noScore, reveal: f.reveal, totalPoints: r.info.totalPoints, posePoints: p.points });
  if (headline !== null) {
    const fade = 1 - f.reveal;
    const ptsCol = p.phase === 'drifting' ? colors.ember : WHITE;
    const w = drawStr(canvas, f, f.fonts.value, headline, rx, rb + 12, { color: ptsCol, anchor: 'end', alpha: fade });
    drawStr(canvas, f, f.fonts.label, 'POINTS', rx, rb + 26, { color: MUTED, anchor: 'end', tracking: 2, alpha: fade });
    if (p.multiplier > 1.05) {
      const cw = 34;
      const cx = rx - w - cw - 8;
      canvas.drawRect({ x: cx, y: rb - 12, width: cw, height: 17 }, fillPaint(f, colors.ember, fade));
      drawStr(canvas, f, f.fonts.label, `×${p.multiplier.toFixed(1)}`, cx + cw / 2, rb + 1, { color: '#000000', anchor: 'middle', alpha: fade });
    }
  }
}

function scrubGeometry(f: Frame): { x0: number; x1: number; yTop: number; yBot: number; xAt: (t: number) => number; yA: (a: number) => number } {
  const lay = f.layout;
  const x0 = lay.insets.left + 18;
  const x1 = lay.w - lay.insets.right - 18;
  const yTop = lay.scrub.y + 4;
  const yBot = lay.scrub.y + lay.scrub.h - 8;
  const dur = Math.max(1e-6, f.replay.durationS);
  const scale = ribbonScale(f.replay);
  return {
    x0,
    x1,
    yTop,
    yBot,
    xAt: (t: number) => x0 + (clamp(t, 0, dur) / dur) * (x1 - x0),
    yA: (a: number) => yBot - clamp(a / scale, 0, 1) * (yBot - yTop),
  };
}

function drawBottomHud(canvas: SkCanvas, f: Frame): void {
  const lay = f.layout;
  const r = f.replay;
  const s = scrubGeometry(f);
  shadeRect(canvas, f, f.res.bottomFade, 0, lay.scrub.y - 18, lay.w, 18);
  canvas.drawRect({ x: 0, y: lay.scrub.y, width: lay.w, height: lay.h - lay.scrub.y }, fillPaint(f, '#000000'));

  canvas.drawLine(s.x0, s.yBot, s.x1, s.yBot, strokePaint(f, '#1C2430', 1, 1, StrokeCap.Butt));

  // The whole |β| trace is drawn, not just the part already played: a scrubber you drag with
  // your thumb has to be a MAP of the run, or dragging forward is blind. What is still to come
  // is drawn flat and grey — the shape of it, never the heat — so the escalation is still
  // something the replay reveals rather than something the timeline gives away.
  const playX = s.xAt(f.t);
  const ribbonPaint = f.res.shaded;
  canvas.save();
  canvas.translate(s.x0, s.yTop);
  canvas.scale(Math.max(1e-4, s.x1 - s.x0), Math.max(1e-4, s.yBot - s.yTop));
  canvas.drawPath(f.geo.ribbon, fillPaint(f, MUTED, 0.22));
  canvas.restore();
  canvas.save();
  canvas.clipRect({ x: s.x0, y: s.yTop - 2, width: Math.max(0, playX - s.x0), height: s.yBot - s.yTop + 2 }, ClipOp.Intersect, false);
  // THE SAME GATE AS THE WORLD. This gradient IS the heat ramp, drawn in band space — red at the
  // top, gold, then ember — so on a recording the engine does not believe it makes exactly the
  // claim the trail was just stopped from making. It goes grey with everything else; the played
  // part stays brighter than the unplayed one so the strip is still a map of the run.
  if (f.noScore) {
    canvas.save();
    canvas.translate(s.x0, s.yTop);
    canvas.scale(Math.max(1e-4, s.x1 - s.x0), Math.max(1e-4, s.yBot - s.yTop));
    canvas.drawPath(f.geo.ribbon, fillPaint(f, MUTED, 0.62));
    canvas.restore();
  } else {
    ribbonPaint.setStyle(PaintStyle.Fill);
    ribbonPaint.setShader(f.res.ribbon);
    ribbonPaint.setColor(f.res.color('#FFFFFF'));
    ribbonPaint.setAlphaf(0.95);
    canvas.save();
    canvas.translate(s.x0, s.yTop);
    canvas.scale(Math.max(1e-4, s.x1 - s.x0), Math.max(1e-4, s.yBot - s.yTop));
    canvas.drawPath(f.geo.ribbon, ribbonPaint);
    canvas.restore();
  }
  canvas.restore();

  // drift windows as ticks under the baseline: grey ahead of the playhead, heat behind it
  for (const seg of r.segments) {
    const a = s.xAt(seg.startT);
    const b = s.xAt(seg.endT);
    canvas.drawRect({ x: a, y: s.yBot + 2, width: Math.max(1, b - a), height: 2.5 }, fillPaint(f, MUTED, 0.45));
    if (seg.startT > f.t) continue;
    const played = s.xAt(Math.min(seg.endT, f.t));
    canvas.drawRect({ x: a, y: s.yBot + 2, width: Math.max(1, played - a), height: 2.5 }, fillPaint(f, driftHeat(f, seg.peakAngle), 0.85));
  }
  // a stretch with no GPS behind it, marked on the timeline as well as in the world
  for (const g of f.view.gaps) {
    const a = s.xAt(g.startT);
    const b = s.xAt(g.endT);
    if (b <= a) continue;
    canvas.drawRect({ x: a, y: s.yBot + 2, width: Math.max(1, b - a), height: 2.5 }, fillPaint(f, MUTED, 0.75));
  }
  for (const lap of r.laps) {
    if (lap.index === 0) continue;
    canvas.drawLine(s.xAt(lap.startT), s.yTop - 2, s.xAt(lap.startT), s.yBot, dashPaint(f, MUTED, 0.8, 2, 2, lap.startT > f.t ? 0.3 : 0.6));
  }
  for (const m of r.markers) {
    if (m.kind !== 'transition') continue;
    const x = s.xAt(m.t);
    canvas.save();
    canvas.translate(x, s.yTop);
    canvas.scale(2.6, 4);
    canvas.drawPath(f.geo.diamond, m.t > f.t ? fillPaint(f, MUTED, 0.5) : fillPaint(f, colors.magenta, 0.85));
    canvas.restore();
  }
  // the highlights the transport jumps between, as gold pips above the band
  for (let i = 0; i < Math.min(r.highlights.length, 8); i++) {
    const h = r.highlights[i];
    canvas.drawCircle(s.xAt(h.t), s.yTop - 7, 1.8, fillPaint(f, colors.gold, 0.8));
  }
  // remaining time as a hairline, so the length of the run is still legible
  canvas.drawLine(playX, s.yBot, s.x1, s.yBot, strokePaint(f, '#2A3340', 1.5, 1, StrokeCap.Butt));
  const grabbed = f.ui.scrubbing;
  canvas.drawLine(playX, s.yTop - 6, playX, s.yBot + 6, strokePaint(f, WHITE, grabbed ? 2.5 : 1.5, 1, StrokeCap.Butt));
  canvas.drawCircle(playX, s.yA(Math.abs(f.pose.beta)), grabbed ? 4 : 2.6, fillPaint(f, heat(f, f.pose.beta)));
  canvas.drawCircle(playX, s.yA(Math.abs(f.pose.beta)), grabbed ? 4 : 2.6, strokePaint(f, BG, 1));
  if (grabbed) {
    // A video scrubber tells you where you are landing. It sits ABOVE the band while there is
    // room above it, and below when the floating transport is up — a bubble that lands on the
    // PLAY button is a bubble in the way of the thing it is reporting on.
    const label = fmtTime(f.t);
    const w = measure(f, f.fonts.clock ?? f.fonts.label!, label) + 16;
    const bx = clamp(playX - w / 2, s.x0, s.x1 - w);
    const below = f.ui.controlsVisible && !lay.landscape;
    const by = below ? s.yBot + 8 : s.yTop - 26;
    canvas.drawRect({ x: bx, y: by, width: w, height: 18 }, fillPaint(f, colors.ember));
    drawStr(canvas, f, f.fonts.clock, label, bx + w / 2, by + 13, { color: '#000000', anchor: 'middle' });
  }

  drawInfoLine(canvas, f);
}

/**
 * The one line of words on the frame: which lap, which track, and what the run is worth so far.
 * Portrait stacks it in the bottom bar (as the reference frame does); landscape runs it as a
 * second row of the top bar, because there the bottom bar belongs to the transport.
 */
function drawInfoLine(canvas: SkCanvas, f: Frame): void {
  const r = f.replay;
  const lay = f.layout;
  const ly = lay.info.y;
  const compact = lay.landscape;
  const lap = lapAt(r, f.t);
  const last = r.laps[r.laps.length - 1];
  const lapStr = r.laps.length === 0 ? 'STAGE' : lap ? `LAP ${lap.index + 1}/${r.laps.length}` : last && f.t > last.endT ? 'FINISH' : `LAP 1/${r.laps.length}`;
  let x = lay.info.x + drawStr(canvas, f, f.fonts.label, lapStr, lay.info.x, ly, { tracking: 1.6 }) + 14;
  // the run's name gets whatever room the total leaves it, and an ellipsis when that is not enough
  // the room the drift count + the running best need on the same row (landscape) — the name
  // gives way to them, not the other way round
  const titleRoom = lay.info.right - x - (compact ? 205 : 84);
  const title = f.fonts.label ? fitTitle(f, f.fonts.label, f.view.title, titleRoom, 1.4) : '';
  x += drawStr(canvas, f, f.fonts.label, title, x, ly, { color: MUTED, tracking: 1.4 }) + 14;

  let best = 0;
  let done = 0;
  for (const seg of r.segments) {
    if (seg.startT > f.t) continue;
    done++;
    if (seg.peakT <= f.t && seg.peakAngle > best) best = seg.peakAngle;
  }
  const driftStr = `${done} DRIFT${done === 1 ? '' : 'S'}`;
  // `seg.peakAngle` is the DETECTOR's peak, the same number the results screen prints under
  // PEAK ANGLE; the trail's own maximum (a degree or four higher on a loose mount) colours it.
  //
  // SO FAR, because it is a RUNNING best over the slides whose peak the playhead has passed,
  // while the numeral at the top of the frame is this instant's |\u03B2|. Unlabelled, the two read as
  // a contradiction in one frame: `replay-touge` showed 52\u00B0 at the top and BEST 48\u00B0 at the
  // bottom, which is a screen arguing with itself unless the footer says which moment it means.
  const bestStr = best > 0 ? `BEST SO FAR ${Math.round(deg(best))}\u00B0` : '';

  // The total is NOT repeated here. It is already set at 34 pt in the top-right readout, and the
  // same number twice at the same size on every frame is one of them saying nothing.
  if (compact) {
    x += drawStr(canvas, f, f.fonts.label, driftStr, x, ly, { color: MUTED, tracking: 1.4 }) + 12;
    if (bestStr) drawStr(canvas, f, f.fonts.label, bestStr, x, ly, { color: driftHeat(f, best), tracking: 1.4 });
    return;
  }
  const dw = drawStr(canvas, f, f.fonts.label, driftStr, lay.info.x, ly + 22, { color: MUTED, tracking: 1.4 });
  if (bestStr) drawStr(canvas, f, f.fonts.label, bestStr, lay.info.x + dw + 14, ly + 22, { color: driftHeat(f, best), tracking: 1.4 });
}

/**
 * THE VERDICT, on the frame the run ends on.
 *
 * It used to be a 30 × 22 pt chip in the bottom bar labelled FINAL GRADE — smaller than the
 * points beside it and far smaller than the grey 0° of a stopped car that still owned the top
 * left. DESIGN.md asks for the opposite: "the letter slams in with a shockwave ring and ember
 * particles". So the slip-angle hero retires, and the letter lands centre stage at 132 pt with
 * the ring and the embers, over the world it was earned on.
 *
 * The phase comes from the playhead (`Frame.reveal`), so it plays in a recording, freezes
 * correctly in a screenshot, and is taken back off the screen by scrubbing away from the end.
 */
function drawGradeReveal(canvas: SkCanvas, f: Frame): void {
  const grade = f.replay.info.grade;
  if (f.reveal <= 0 || !grade || f.noScore) return;
  const k = f.ui.reduceMotion ? 1 : f.reveal;
  const st = f.action;
  const cx = f.layout.w / 2;
  // The stack is the letter plus two lines under it, and in landscape the stage is 221 pt tall —
  // at full size the points fell through the scrubber. `fit` shrinks the whole block to the band
  // it has, rather than letting one orientation overflow.
  const fit = clamp(Math.min(1, (st.h * 0.62) / (TYPE.slam * 1.35)), 0.45, 1);
  const cy = st.y + st.h * 0.44;
  const col = (gradeColors as Record<string, string>)[grade] ?? colors.ember;
  // the world dims so the letter is the only lit thing on the frame
  canvas.drawRect({ x: 0, y: 0, width: f.layout.w, height: f.layout.h }, fillPaint(f, '#000000', 0.42 * k));

  // shockwave: a ring that expands past the letter and thins as it goes
  if (!f.ui.reduceMotion && k < 1) {
    const rw = 40 + 260 * k;
    canvas.drawCircle(cx, cy, rw, strokePaint(f, col, Math.max(1, 9 * (1 - k)), 0.55 * (1 - k)));
    canvas.drawCircle(cx, cy, rw * 0.72, strokePaint(f, WHITE, Math.max(1, 4 * (1 - k)), 0.3 * (1 - k)));
  }
  // ember particles, thrown out on the slam and falling back (deterministic, seeded by index)
  if (!f.ui.reduceMotion) {
    const spread = 0.35 + 0.65 * k;
    for (let i = 0; i < 26; i++) {
      const a = (i / 26) * Math.PI * 2 + i * 0.37;
      const rr = (70 + ((i * 53) % 190)) * spread;
      const px = cx + Math.cos(a) * rr;
      const py = cy + Math.sin(a) * rr * 0.72 + 90 * k * k;
      const size = 1.2 + ((i * 7) % 5) * 0.55;
      canvas.drawCircle(px, py, size * (1.2 - 0.6 * k), fillPaint(f, i % 3 === 0 ? colors.gold : colors.ember, 0.75 * (1 - k * 0.7)));
    }
  }
  // the letter: slams 2.2 → 1.0 with the same overshoot the callouts use
  const eased = 1 - Math.pow(1 - k, 3);
  const slam = f.ui.reduceMotion ? 1 : 2.2 - 1.2 * eased - (k < 1 ? Math.sin(k * Math.PI) * 0.08 : 0);
  const baseline = cy + TYPE.slam * fit * 0.36;
  canvas.save();
  canvas.translate(cx, baseline);
  canvas.scale(slam * fit, slam * fit);
  canvas.translate(-cx, -baseline);
  drawGlowStr(canvas, f, f.fonts.slam, grade, cx, baseline, WHITE, col, 0.9, 'middle', TYPE.slam);
  canvas.restore();
  drawStr(canvas, f, f.fonts.label, 'FINAL GRADE', cx, baseline + 34 * fit, { color: col, anchor: 'middle', tracking: 4, alpha: k });
  const total = f.replay.info.totalPoints;
  if (total !== null) {
    drawStr(canvas, f, f.fonts.value, pts(total), cx, baseline + 76 * fit, { color: WHITE, anchor: 'middle', alpha: k });
    drawStr(canvas, f, f.fonts.label, 'POINTS', cx, baseline + 96 * fit, { color: MUTED, anchor: 'middle', tracking: 3, alpha: k });
  }
}

/**
 * Fit a run's name to the room it has. A name is "HARBOR LOOP · UNSTEADY MOUNT · POOR GPS": drop
 * whole trailing clauses first, which leaves a name that still reads, and only cut letters if
 * even the first clause is too long.
 */
function fitTitle(f: Frame, font: SkFont, title: string, maxW: number, tracking: number): string {
  const parts = title.split(' \u00B7 ');
  for (let n = parts.length; n > 0; n--) {
    const candidate = parts.slice(0, n).join(' \u00B7 ');
    if (measure(f, font, candidate, tracking) <= maxW) return candidate;
  }
  return ellipsize(f, font, parts[0], maxW, tracking);
}

/** Cut a label to fit, with an ellipsis, rather than letting it run under the next thing. */
function ellipsize(f: Frame, font: SkFont, text: string, maxW: number, tracking = 0): string {
  if (maxW <= 0) return '';
  if (measure(f, font, text, tracking) <= maxW) return text;
  let out = text;
  while (out.length > 1 && measure(f, font, `${out}\u2026`, tracking) > maxW) out = out.slice(0, -1);
  return `${out.trimEnd()}\u2026`;
}

/**
 * The monitor writes for a screen that shouts ("100% OF THIS RUN'S SLIDING COULD NOT BE TRUSTED
 * — PHONE LOOKS HAND-HELD — CLIP IT INTO A RIGID MOUNT TO SCORE DRIFTS"). On this screen it is
 * one sentence: the first clause, capitalised, full stop. The rest belongs to the results
 * screen, which has the room to explain and the job of explaining.
 */
function sentence(text: string): string {
  const first = text.split(/\s+[—–-]\s+/)[0].trim().replace(/[.\s]+$/, '');
  if (!first) return '';
  return `${first.charAt(0).toUpperCase()}${first.slice(1)}.`;
}

/** Break a sentence into lines that fit `maxW`, the long way, because Skia has no text layout. */
function wrapText(f: Frame, font: SkFont, text: string, maxW: number, maxLines = 3): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (measure(f, font, next) <= maxW || !line) line = next;
    else {
      lines.push(line);
      line = word;
      if (lines.length === maxLines) break;
    }
  }
  if (lines.length < maxLines && line) lines.push(line);
  return lines;
}

/**
 * The stack of notices at the top of the stage, in the order they matter: what is wrong with the
 * data, whether the run may be scored at all, and which moment the transport just jumped to.
 * They are stacked rather than placed so two of them can never land on top of each other.
 */
function drawStageNotices(canvas: SkCanvas, f: Frame): void {
  const lay = f.layout;
  const label = f.fonts.label;
  if (!label) return;
  const left = lay.insets.left + 18;
  let y = f.action.y + 18;
  // the React plate is opaque and owns this corner while it is open
  if (f.ui.warningsOpen) return;

  // ONE red chip. A refusal outranks a data warning — it is the stronger statement about the
  // same recording, and the warnings are one tap away on the plate — so they never stack.
  if (f.noScore) {
    // the refusal: the recording is valid, the judgement is not — and why, in the monitor's
    // own words, as a SENTENCE in Barlow. It used to be two full-width lines of uppercase
    // Barlow Condensed, 100 characters of shouting, on top of two more NOT SCORED chips.
    const maxW = Math.min(320, lay.w - lay.insets.left - lay.insets.right - 36);
    const plate = measure(f, label, 'NOT SCORED', 1.6) + 14;
    canvas.drawRect({ x: left, y: y - 12, width: plate, height: 18 }, fillPaint(f, colors.red));
    drawStr(canvas, f, label, 'NOT SCORED', left + 7, y + 1, { color: '#000000', tracking: 1.6 });
    y += 24;
    const body = f.fonts.body ?? label;
    for (const line of wrapText(f, body, sentence(f.view.untrustedBody), maxW, 2)) {
      drawStr(canvas, f, body, line, left, y, { color: WHITE, alpha: 0.82, outline: BG, outlineW: 3 });
      y += 17;
    }
    y += 10;
  } else if (f.view.warnings.length > 0) {
    // the bad-data plate: what is wrong, in one word, impossible to miss
    const msg = f.view.warnings.some((w) => /SIGNAL LOST/i.test(w))
      ? 'SIGNAL LOST'
      : f.view.warnings.some((w) => /no usable position|dead reckoning|GPS/i.test(w))
        ? 'DATA GAPS'
        : 'DATA WARNING';
    const w = measure(f, label, msg, 1.4) + 14;
    canvas.drawRect({ x: left, y: y - 12, width: w, height: 18 }, fillPaint(f, colors.red, 0.85));
    drawStr(canvas, f, label, msg, left + 7, y + 1, { color: '#000000', tracking: 1.4 });
    drawStr(canvas, f, label, `${f.view.warnings.length}`, left + w + 8, y + 1, { color: colors.red, tracking: 1 });
    y += 28;
  }

  // the chip that names the moment the transport just jumped to
  const h = f.ui.highlight;
  if (h && h.alpha > 0.02 && f.fonts.peak) {
    const kicker = h.index > 0 ? `HIGHLIGHT ${h.index}/${h.total}` : 'THIS DRIFT';
    // "54° · 1250 PTS" is half measurement, half claim: an untrusted run keeps the angle and
    // loses the points, like everything else on this screen that would put a score on the run.
    const hl = f.noScore ? h.label.split(' \u00b7 ').filter((part) => !/PTS$/.test(part)).join(' \u00b7 ') : h.label;
    const wk = measure(f, label, kicker, 1.6);
    const wl = measure(f, f.fonts.peak, hl, 0.6);
    const w = Math.max(wk, wl) + 24;
    const x = lay.w / 2 - w / 2;
    const top = Math.max(y - 12, f.action.y + 18);
    canvas.drawRect({ x, y: top, width: w, height: 46 }, fillPaint(f, BG, 0.82 * h.alpha));
    canvas.drawRect({ x, y: top, width: w, height: 46 }, strokePaint(f, colors.gold, 1, 0.55 * h.alpha, StrokeCap.Butt));
    drawStr(canvas, f, label, kicker, lay.w / 2, top + 17, { color: colors.gold, anchor: 'middle', tracking: 1.6, alpha: h.alpha });
    drawStr(canvas, f, f.fonts.peak, hl, lay.w / 2, top + 37, { color: WHITE, anchor: 'middle', tracking: 0.6, alpha: h.alpha });
  }
}

/** Where the positions were dead-reckoned, said on the world itself. */
function drawGapNotice(canvas: SkCanvas, f: Frame): void {
  if (!f.fonts.label) return;
  for (const g of f.view.gaps) {
    if (g.startT > f.t) continue;
    const i = Math.min(f.replay.trail.n - 1, Math.round(((g.startT + Math.min(g.endT, f.t)) / 2) * f.replay.trail.hz));
    const x = f.replay.trail.x[i];
    const y = f.replay.trail.y[i];
    if (!inView(f, x, y)) continue;
    const sp = toS(f, x, y);
    // the label belongs to a stretch of road that may sit half off the frame; it is kept on
    // screen rather than sliced by the edge ("O FIX 7.1S")
    const label = `NO FIX ${g.durationS.toFixed(1)}S`;
    const half = measure(f, f.fonts.label, label, 1.2) / 2 + 6;
    const lx = clamp(sp.x, f.layout.insets.left + half, f.layout.w - f.layout.insets.right - half);
    drawStr(canvas, f, f.fonts.label, label, lx, sp.y - 10, { color: MUTED, anchor: 'middle', tracking: 1.2, outline: BG, outlineW: 3 });
  }
}

// ---------------------------------------------------------------- the frame
export function drawReplayFrame(canvas: SkCanvas, input: SceneInput): void {
  const lay = input.layout;
  const cam = input.cam;
  const trail = input.replay.trail;
  const corners = [
    { x: 0, y: 0 },
    { x: lay.w, y: 0 },
    { x: 0, y: lay.h },
    { x: lay.w, y: lay.h },
  ].map((c) => screenToWorld(cam, c.x, c.y));
  const margin = 30;
  const f: Frame = {
    ...input,
    vis: {
      minX: Math.min(...corners.map((c) => c.x)) - margin,
      maxX: Math.max(...corners.map((c) => c.x)) + margin,
      minY: Math.min(...corners.map((c) => c.y)) - margin,
      maxY: Math.max(...corners.map((c) => c.y)) + margin,
    },
    action: input.mode === 'overview' ? lay.stage : lay.action,
    cur: Math.max(0, Math.min(trail.n - 1, Math.floor(input.t * trail.hz))),
    overview: input.mode === 'overview',
    noScore: !input.view.trusted,
    reveal: input.view.trusted && input.replay.info.grade ? clamp((input.t - (input.replay.durationS - REVEAL_S)) / REVEAL_S, 0, 1) : 0,
  };

  canvas.drawRect({ x: 0, y: 0, width: lay.w, height: lay.h }, fillPaint(f, BG));

  // shake: driven by replay.events, so Skia and SVG shake identically
  const sh = f.ui.reduceMotion ? 0 : f.shake;
  const shx = sh * 2.4 * Math.sin(f.t * 97);
  const shy = sh * 2.4 * Math.cos(f.t * 113);
  const c = Math.cos(cam.rotation);
  const s = Math.sin(cam.rotation);
  const z = cam.zoom;
  canvas.save();
  // cam.w / cam.h are the ACTION rectangle expressed so that (w/2, h/2) is its centre on screen
  // (see ReplayCanvas): the world is centred on what the viewer can actually see.
  canvas.concat([
    z * c,
    -z * s,
    cam.w / 2 + shx - z * c * cam.cx + z * s * cam.cy,
    -z * s,
    -z * c,
    cam.h / 2 + shy + z * s * cam.cx + z * c * cam.cy,
    0,
    0,
    1,
  ]);
  drawGround(canvas, f);
  drawRoad(canvas, f);
  drawTrail(canvas, f);
  drawMarkers(canvas, f);
  drawSmoke(canvas, f);
  drawGhost(canvas, f); // under the car: distance-synced, they sit side by side
  drawCar(canvas, f);
  canvas.restore();

  drawStreaks(canvas, f);
  const vr = Math.hypot(lay.w / 2, lay.h / 2) * 0.95;
  shadeEllipse(canvas, f, f.res.vignette, lay.w / 2, lay.h / 2, vr, vr, 1);
  if (!f.ui.reduceMotion) {
    const grain = f.res.shaded;
    grain.setStyle(PaintStyle.Fill);
    grain.setShader(f.res.grain);
    grain.setColor(f.res.color('#FFFFFF'));
    grain.setAlphaf(0.022);
    canvas.drawRect({ x: 0, y: 0, width: lay.w, height: lay.h }, grain);
  }
  // The transport floats over the bottom of the stage in portrait, and a label on a chip has to
  // stay legible over whatever the scene puts behind it — including the bright trail ribbon.
  if (f.ui.controlsVisible && !lay.landscape) {
    const band = lay.controls;
    shadeRect(canvas, f, f.res.bottomFade, 0, band.y - 26, lay.w, band.h + 26 + 10, 0.72);
  }
  drawGapNotice(canvas, f);
  // Once the grade starts landing, the frame belongs to it: no world labels and no callout
  // shouting FINISH over the letter (FINISH used to be on this frame three times).
  const revealOwnsFrame = f.reveal > 0;
  if (!revealOwnsFrame) {
    drawWorldLabels(canvas, f);
    drawCallout(canvas, f);
  }
  drawMinimap(canvas, f);
  drawTopHud(canvas, f);
  drawBottomHud(canvas, f);
  drawStageNotices(canvas, f);
  drawGradeReveal(canvas, f);
  // a cut cross-fades from black for 120 ms (film language for a camera change)
  if (f.cutFade > 0.001) canvas.drawRect({ x: 0, y: 0, width: lay.w, height: lay.h }, fillPaint(f, '#000000', f.cutFade * 0.55));
}
