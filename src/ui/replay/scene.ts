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
import { ribbonScale, ROAD_W } from './geometry';
import type { ReplayLayout } from './layout';
import { ASPHALT_HI, ASPHALT_LO, CENTRE_LINE, EDGE_LINE, GRID_LINE, GROUND, HOT, KERB_PALE, RUNOFF, TYPE, VERGE, deg, eventColor, fmtTime, heatColor, kmh, mix, severityWeight } from './palette';
import type { SceneResources } from './resources';
import type { ReplayView } from './source';

export interface SceneFonts {
  /** Barlow Condensed 800, upright — angles and callouts. */
  hero: SkFont | null;
  heroDeg: SkFont | null;
  callout: SkFont | null;
  mid: SkFont | null;
  peak: SkFont | null;
  grade: SkFont | null;
  /** Barlow Condensed 800 italic — things that move: speed, points, totals. */
  value: SkFont | null;
  /** Barlow Condensed 700 — every uppercase label. */
  label: SkFont | null;
  chip: SkFont | null;
  /** Orbitron 700 — the clock, so a time never reads as a score. */
  clock: SkFont | null;
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
  /** Trail index reached at `t`. */
  cur: number;
  overview: boolean;
  /** Suppress every points/grade claim (untrusted recording). */
  noScore: boolean;
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
  let w = 0;
  for (const ch of s) w += f.res.width(font, key, ch) + tracking;
  return Math.max(0, w - tracking);
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
    let cx = left;
    const key = fontKey(f.fonts, font);
    for (const ch of s) {
      canvas.drawText(ch, cx, y, paint, font);
      cx += f.res.width(font, key, ch) + tracking;
    }
  };
  const alpha = o.alpha ?? 1;
  if (o.outline) draw(o.outline, alpha, PaintStyle.Stroke, o.outlineW ?? 3);
  draw(o.color ?? WHITE, alpha, PaintStyle.Fill);
  return w;
}

/** A big glowing number: a blurred copy under the fill (Skia can blur; the SVG had to fake it). */
function drawGlowStr(canvas: SkCanvas, f: Frame, font: SkFont | null, s: string, x: number, y: number, fillCol: string, glowCol: string, glowOpacity: number, anchor: Anchor = 'start', size = 40): number {
  if (!font || !s) return 0;
  const w = measure(f, font, s);
  const left = anchor === 'middle' ? x - w / 2 : anchor === 'end' ? x - w : x;
  if (glowOpacity > 0.02 && !f.ui.reduceMotion) {
    f.res.setGlowBlur(Math.max(3, size * 0.22));
    const g = f.res.glow;
    g.setStyle(PaintStyle.Fill);
    g.setShader(null);
    g.setColor(f.res.color(glowCol));
    g.setAlphaf(clamp(glowOpacity * 0.85, 0, 1));
    canvas.drawText(s, left, y, g, font);
  }
  const p = f.res.text;
  p.setStyle(PaintStyle.Stroke);
  p.setShader(null);
  p.setStrokeJoin(StrokeJoin.Round);
  p.setStrokeWidth(Math.max(2, size * 0.09));
  p.setColor(f.res.color(glowCol));
  p.setAlphaf(clamp(0.55 + 0.45 * glowOpacity, 0, 1));
  canvas.drawText(s, left, y, p, font);
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
  const spacing = f.cam.zoom > 3 ? 20 : 50;
  const grid = strokePaint(f, GRID_LINE, 1 / f.cam.zoom, 0.85, StrokeCap.Butt);
  for (let x = Math.floor(minX / spacing) * spacing; x <= maxX; x += spacing) canvas.drawLine(x, minY, x, maxY, grid);
  for (let y = Math.floor(minY / spacing) * spacing; y <= maxY; y += spacing) canvas.drawLine(minX, y, maxX, y, grid);
}

function drawRoad(canvas: SkCanvas, f: Frame): void {
  const g = f.geo;
  if (!g.road) return;
  const verge = ROAD_W + 7;
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
  const kw = mOrPx(f, 1.1, 2.4);
  const kerbDash = mOrPx(f, 2, 4);
  for (const k of g.kerbs) {
    if (!overlaps(f, k.bounds)) continue;
    canvas.drawPath(k.path, strokePaint(f, KERB_PALE, kw, 0.35));
    canvas.drawPath(k.path, dashPaint(f, colors.red, kw, kerbDash, kerbDash, 0.3));
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

/** Build the part of a polyline that has been played, in world metres. */
function partialPath(f: Frame, from: number, to: number): SkPath | null {
  if (to <= from) return null;
  const tr = f.replay.trail;
  const b = Skia.PathBuilder.Make();
  for (let i = from; i <= to; i++) {
    if (i === from) b.moveTo(tr.x[i], tr.y[i]);
    else b.lineTo(tr.x[i], tr.y[i]);
  }
  return b.detach();
}

function drawTrail(canvas: SkCanvas, f: Frame): void {
  const g = f.geo;
  const cur = f.cur;
  const boost = f.overview ? 1.6 : 1;

  // the driven line where the car was NOT drifting (the future is never drawn: it spoils the route)
  const lineW = mOrPx(f, 0.35, 1);
  for (const run of g.runs) {
    if (run.startIndex > cur || !overlaps(f, run.bounds)) continue;
    if (run.dead) {
      // a stretch with no GPS behind it is a guess: dash it, never glow it
      const path = run.endIndex <= cur ? run.path : partialPath(f, run.startIndex, cur);
      if (!path) continue;
      canvas.drawPath(path, dashPaint(f, MUTED, mOrPx(f, 0.3, 1.1), mOrPx(f, 1.6, 4), mOrPx(f, 1.6, 4), 0.5));
      if (run.endIndex > cur) path.dispose();
      continue;
    }
    if (run.endIndex <= cur) {
      canvas.drawPath(run.path, strokePaint(f, colors.ember, lineW, 0.18));
    } else {
      const path = partialPath(f, run.startIndex, cur);
      if (path) {
        canvas.drawPath(path, strokePaint(f, colors.ember, lineW, 0.18));
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
    canvas.drawPath(path, strokePaint(f, sg.color, haloW * (0.7 + 0.6 * w), (0.07 + 0.11 * w) * boost));
    canvas.drawPath(path, strokePaint(f, sg.color, glowW * (0.8 + 0.5 * w), (0.18 + 0.22 * w) * boost));
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
      const paint = strokePaint(f, chunk.color, width, chunk.hot ? 0.92 : 1);
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
      canvas.drawCircle(tr.x[seg.peakIndex], tr.y[seg.peakIndex], mOrPx(f, 7, 9), fillPaint(f, heatColor(seg.peakAngle), 0.1 + 0.12 * w));
    }
  }
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
  // previous laps: a 3 px breadcrumb, no ring, no label
  for (const m of r.markers) {
    if (m.t > f.t || (m.lapIndex === li && li >= 0) || !inView(f, m.x, m.y)) continue;
    if (m.kind === 'transition' || m.kind === 'drift-peak') {
      canvas.drawCircle(m.x, m.y, mOrPx(f, 0.5, 1.5), fillPaint(f, m.kind === 'transition' ? colors.magenta : colors.ember, 0.28));
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
        const col = heatColor(m.peakAngle ?? 0);
        canvas.drawCircle(m.x, m.y, mOrPx(f, 2, 2.6), strokePaint(f, col, pw, 0.5));
        canvas.drawCircle(m.x, m.y, mOrPx(f, 0.7, 1.2), fillPaint(f, col));
        break;
      }
      case 'drift-end':
        canvas.drawCircle(m.x, m.y, mOrPx(f, 0.6, 1), fillPaint(f, colors.ember, 0.75));
        break;
      case 'drift-start': {
        const nx = -Math.sin(m.course);
        const ny = Math.cos(m.course);
        canvas.drawLine(m.x - nx * 2, m.y - ny * 2, m.x + nx * 2, m.y + ny * 2, strokePaint(f, colors.ember, pw, 0.6));
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
  const st = f.layout.stage;
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
  const col = heatColor(p.beta);
  const slip = Math.abs(p.beta);

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
}
