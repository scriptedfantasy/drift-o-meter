/**
 * Render one frame of a simulated session's replay as SVG (the harness/critic renderer).
 * Draws exactly the scene data from src/engine/replay — the Skia renderer in the app draws the
 * same data, including the callout slam/shake, which comes from `replay.events`.
 *
 * usage: npx tsx tools/analysis/render-replay.ts <harbor|touge> <seed> <t|keyword> <overview|chase|cinematic> out.svg
 *          [--laps=N] [--consistency=0..1] [--aggression=0..1] [--beta=DEG] [--cut]
 *   t: replay-relative seconds, or a keyword:
 *      mid | start | end | peak | transition[N] | lap2 | lap2-peak | ghost | straight | slow | spin
 *   --beta=DEG  force a synthetic slide of DEG degrees (to check escalation past the sim's ceiling)
 * Convert with tools/analysis/render_replay.py (SVG → PNG at 1170×2532).
 */
import { writeFileSync } from 'node:fs';
import { simulateRun, type TrackId } from '../../src/sim';
import { sessionFromSimulation } from '../../src/engine/replay/fixtures';
import {
  activeEvents,
  buildReplay,
  formatPoints,
  ghostPoseAt,
  lapAt,
  liveSmoke,
  poseAt,
  ReplayCamera,
  screenToWorld,
  SEVERITY_EDGES,
  shakeAt,
  smokeAt,
  worldToScreen,
  type ActiveEvent,
  type CameraMode,
  type CameraState,
  type DriftSeverity,
  type GhostPose,
  type Replay,
  type ReplayMarker,
  type ReplayPose,
} from '../../src/engine/replay';
import { colors, gradeColors } from '../../src/ui/theme';
import { clamp, wrapAngle } from '../../src/engine/types';

// ---------------------------------------------------------------- palette (src/ui/theme.ts)
const BG = colors.bg0;
const EMBER = colors.ember;
const GOLD = colors.gold;
const RED = colors.red;
const CYAN = colors.cyan;
const MAGENTA = colors.magenta;
const GREEN = colors.green;
const WHITE = colors.text;
const MUTED = colors.muted;
const HOT = '#FFE9D6';
/** Ground plane: night asphalt with a blue bias — deliberately NOT the letterbox black. */
const GROUND = '#0E141D';
const ASPHALT_HI = '#2B3644';
const ASPHALT_LO = '#1B232E';
const FONT = 'Barlow Condensed, Impact, sans-serif';
const MONO = 'Orbitron, Barlow Condensed, sans-serif';

const W = 390;
const H = 844;
/** Letterbox bars: the world is FULL-BLEED behind them (they are bars, not panels). */
const TOP_BAR = 104;
const BOTTOM_BAR = 96;
const SCRUB_H = 34;
const FPS = 60;

/** Three type tiers, nothing in between (a 9-size scale reads as a chart, not a HUD). */
const T_HERO = 56;
const T_VALUE = 34;
const T_LABEL = 13;

// ---------------------------------------------------------------- helpers
const f2 = (v: number) => (Math.abs(v) < 1e-9 ? '0' : (Number.isFinite(v) ? v : 0).toFixed(2).replace(/\.?0+$/, ''));
const f3 = (v: number) => (Number.isFinite(v) ? v : 0).toFixed(3).replace(/\.?0+$/, '');
const deg = (r: number) => (r * 180) / Math.PI;
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const kmh = (v: number) => Math.round(v * 3.6);
const fmtTime = (s: number) => {
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${String(m).padStart(2, '0')}:${r < 10 ? '0' : ''}${r.toFixed(1)}`;
};

/** Score text; the engine owns the rule so both renderers agree. */
const pts = formatPoints;

function mix(a: string, b: string, f: number): string {
  const t = clamp(f, 0, 1);
  const p = (h: string, i: number) => parseInt(h.slice(1 + i * 2, 3 + i * 2), 16);
  const c = [0, 1, 2].map((i) => Math.round(p(a, i) + (p(b, i) - p(a, i)) * t));
  return `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * The escalation ramp: ember up to 40°, ember → gold to 65°, gold → red beyond.
 * The same |β| always produces the same colour, in every session and both renderers.
 */
function heatColor(beta: number): string {
  const a = Math.abs(beta);
  if (a <= SEVERITY_EDGES.extreme) return EMBER;
  if (a <= SEVERITY_EDGES.spin) return mix(EMBER, GOLD, (a - SEVERITY_EDGES.extreme) / (SEVERITY_EDGES.spin - SEVERITY_EDGES.extreme));
  return mix(GOLD, RED, clamp((a - SEVERITY_EDGES.spin) / ((Math.PI / 2) * 1.0 - SEVERITY_EDGES.spin), 0, 1));
}

function severityWeight(s: DriftSeverity): number {
  return s === 'spin' ? 1 : s === 'extreme' ? 0.75 : s === 'big' ? 0.5 : s === 'hold' ? 0.28 : 0;
}

function pointsAttr(pts: Array<[number, number]>): string {
  let s = '';
  for (const [x, y] of pts) if (Number.isFinite(x) && Number.isFinite(y)) s += `${f2(x)},${f2(y)} `;
  return s.trim();
}

interface TextOpts {
  size: number;
  fill?: string;
  weight?: number;
  anchor?: 'start' | 'middle' | 'end';
  family?: string;
  spacing?: number;
  opacity?: number;
  stroke?: string;
  strokeW?: number;
  italic?: boolean;
}

function text(x: number, y: number, s: string, o: TextOpts): string {
  const attrs = [
    `x="${f2(x)}"`,
    `y="${f2(y)}"`,
    `font-family="${o.family ?? FONT}"`,
    `font-size="${o.size}"`,
    `font-weight="${o.weight ?? 700}"`,
    `fill="${o.fill ?? WHITE}"`,
    `text-anchor="${o.anchor ?? 'start'}"`,
  ];
  if (o.spacing) attrs.push(`letter-spacing="${o.spacing}"`);
  if (o.opacity !== undefined) attrs.push(`opacity="${f3(o.opacity)}"`);
  if (o.italic) attrs.push('font-style="italic"');
  const body = esc(s);
  const el = `<text ${attrs.join(' ')}>${body}</text>`;
  if (!o.stroke) return el;
  // cairosvg ignores paint-order, so the outline is a separate stroke-only copy underneath
  const under = attrs.map((a) => (a.startsWith('fill=') ? 'fill="none"' : a));
  return `<text ${under.join(' ')} stroke="${o.stroke}" stroke-width="${o.strokeW ?? 2}" stroke-linejoin="round">${body}</text>` + el;
}

/** Big glowing number: translucent thick-stroked copies under the fill. */
function glowText(x: number, y: number, s: string, size: number, fill: string, glow: string, glowOpacity: number, anchor: 'start' | 'middle' | 'end' = 'middle', weight = 800, italic = false): string {
  const base = { size, anchor, weight, italic };
  return (
    text(x, y, s, { ...base, fill: glow, stroke: glow, strokeW: size * 0.2, opacity: glowOpacity * 0.45 }) +
    text(x, y, s, { ...base, fill: glow, stroke: glow, strokeW: size * 0.08, opacity: glowOpacity }) +
    text(x, y, s, { ...base, fill })
  );
}

function offsetPolyline(pts: Array<[number, number]>, d: number, closed: boolean): Array<[number, number]> {
  const n = pts.length;
  const out: Array<[number, number]> = [];
  for (let i = 0; i < n; i++) {
    const a = pts[closed ? (i - 1 + n) % n : Math.max(0, i - 1)];
    const b = pts[closed ? (i + 1) % n : Math.min(n - 1, i + 1)];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy) || 1;
    out.push([pts[i][0] - (dy / len) * d, pts[i][1] + (dx / len) * d]);
  }
  return out;
}

interface Frame {
  replay: Replay;
  t: number;
  mode: CameraMode;
  cam: CameraState;
  pose: ReplayPose;
  ghost: GhostPose | null;
  events: ActiveEvent[];
  shake: number;
  vis: { minX: number; maxX: number; minY: number; maxY: number };
  track: TrackId;
  seed: number;
}

const inView = (f: Frame, x: number, y: number) => x >= f.vis.minX && x <= f.vis.maxX && y >= f.vis.minY && y <= f.vis.maxY;
/** Width in metres that is at least `px` logical points on screen. */
const mOrPx = (f: Frame, m: number, px: number) => Math.max(m, px / f.cam.zoom);
const toS = (f: Frame, x: number, y: number) => worldToScreen(f.cam, x, y);

/** The car marker never shrinks below this on-screen length (34 pt ≈ 100 device px). */
const CAR_MIN_PT = 34;
function carScale(f: Frame): number {
  return Math.max(1, CAR_MIN_PT / (f.replay.options.carLengthM * f.cam.zoom));
}

// ---------------------------------------------------------------- world layers (metres, y up)
function drawGround(f: Frame): string {
  // a ground plane with its own value, so the world is never the same black as the letterbox
  const { minX, maxX, minY, maxY } = f.vis;
  let s = `<rect x="${f2(minX)}" y="${f2(minY)}" width="${f2(maxX - minX)}" height="${f2(maxY - minY)}" fill="${GROUND}"/>`;
  // sodium-light pool centred on the action: the ground is lit, not void
  const b = f.replay.bounds;
  const cx = f.mode === 'overview' ? 0.5 * (b.minX + b.maxX) : f.pose.x;
  const cy = f.mode === 'overview' ? 0.5 * (b.minY + b.maxY) : f.pose.y;
  const rr = f.mode === 'overview' ? 0.62 * Math.max(b.maxX - b.minX, b.maxY - b.minY) : 0.55 * (maxX - minX);
  s += `<circle cx="${f2(cx)}" cy="${f2(cy)}" r="${f2(rr)}" fill="url(#pool)"/>`;
  const spacing = f.cam.zoom > 3 ? 20 : 50;
  const w = 1 / f.cam.zoom;
  s += `<g stroke="#18202B" stroke-width="${f3(w)}" opacity="0.85">`;
  for (let x = Math.floor(minX / spacing) * spacing; x <= maxX; x += spacing) s += `<line x1="${f2(x)}" y1="${f2(minY)}" x2="${f2(x)}" y2="${f2(maxY)}"/>`;
  for (let y = Math.floor(minY / spacing) * spacing; y <= maxY; y += spacing) s += `<line x1="${f2(minX)}" y1="${f2(y)}" x2="${f2(maxX)}" y2="${f2(y)}"/>`;
  return s + '</g>';
}

function drawRoad(f: Frame): string {
  const r = f.replay;
  let pts: Array<[number, number]>;
  let closed = false;
  if (r.track) {
    pts = r.track.path.map((p) => [p.x, p.y] as [number, number]);
    closed = r.track.closed;
  } else {
    pts = [];
    for (let i = 0; i < r.trail.n; i += 4) pts.push([r.trail.x[i], r.trail.y[i]]);
  }
  if (pts.length < 2) return '';
  const tag = closed ? 'polygon' : 'polyline';
  const attr = pointsAttr(pts);
  const roadW = 9.5;
  const verge = roadW + 7;
  let s = '<g fill="none" stroke-linejoin="round" stroke-linecap="round">';
  // gravel run-off / verge, then the asphalt itself: the off-road area now has material
  s += `<${tag} points="${attr}" stroke="#0C1118" stroke-width="${f2(verge + 6)}"/>`;
  s += `<${tag} points="${attr}" stroke="#11171F" stroke-width="${f2(verge)}"/>`;
  s += `<${tag} points="${attr}" stroke="${ASPHALT_HI}" stroke-width="${f2(roadW + 1.4)}"/>`;
  s += `<${tag} points="${attr}" stroke="${ASPHALT_LO}" stroke-width="${f2(roadW)}"/>`;
  // edge lines
  const ew = mOrPx(f, 0.28, 0.9);
  for (const d of [roadW / 2 - 0.4, -(roadW / 2 - 0.4)]) {
    s += `<${tag} points="${pointsAttr(offsetPolyline(pts, d, closed))}" stroke="#56677D" stroke-width="${f3(ew)}" opacity="0.95"/>`;
  }
  s += `<${tag} points="${attr}" stroke="#222B36" stroke-width="${f3(mOrPx(f, 0.18, 0.6))}" stroke-dasharray="2.5 3.5"/>`;
  s += '</g>';
  // kerbs + apex chips at the corners (red/white, the classic circuit cue)
  if (f.mode === 'overview' && r.track?.corners?.length) {
    let ci = 0;
    for (const c of r.track.corners) {
      ci++;
      if (!inView(f, c.x, c.y)) continue;
      const rr2 = mOrPx(f, 6, 9);
      s += `<circle cx="${f2(c.x)}" cy="${f2(c.y)}" r="${f3(rr2)}" fill="none" stroke="${MUTED}" stroke-width="${f3(mOrPx(f, 0.6, 0.8))}" opacity="0.3"/>`;
    }
  }
  if (r.track?.corners?.length) {
    const path = r.track.path;
    const n = path.length;
    for (const c of r.track.corners) {
      if (!inView(f, c.x, c.y)) continue;
      // walk the ref path near the apex and lay a kerb on the inside
      let ai = 0;
      let bestD = Infinity;
      for (let i = 0; i < n; i++) {
        const d = (path[i].x - c.x) ** 2 + (path[i].y - c.y) ** 2;
        if (d < bestD) {
          bestD = d;
          ai = i;
        }
      }
      const span = Math.max(6, Math.round(Math.min(40, c.radiusM * 0.9)));
      const seg: Array<[number, number]> = [];
      for (let k = -span; k <= span; k += 2) {
        const i = closed ? (ai + k + n) % n : clamp(ai + k, 0, n - 1);
        seg.push([path[i].x, path[i].y]);
      }
      if (seg.length < 3) continue;
      const inside = offsetPolyline(seg, c.direction * (roadW / 2 + 0.55), false);
      const kw = mOrPx(f, 1.1, 2.4);
      s += `<polyline points="${pointsAttr(inside)}" fill="none" stroke="#8E9AA8" stroke-width="${f3(kw)}" opacity="0.35"/>`;
      s += `<polyline points="${pointsAttr(inside)}" fill="none" stroke="${RED}" stroke-width="${f3(kw)}" stroke-dasharray="${f2(mOrPx(f, 2, 4))} ${f2(mOrPx(f, 2, 4))}" opacity="0.3"/>`;
      // apex chip
      if (f.cam.zoom > 2) {
        const ax = c.x - Math.sin(0) * 0;
        s += `<circle cx="${f2(ax)}" cy="${f2(c.y)}" r="${f2(mOrPx(f, 0.55, 1.6))}" fill="none" stroke="${MUTED}" stroke-width="${f3(mOrPx(f, 0.2, 0.7))}" opacity="0.45"/>`;
      }
    }
  }
  if (r.track?.gate) {
    const g = r.track.gate;
    const dx = g.bx - g.ax;
    const dy = g.by - g.ay;
    const len = Math.hypot(dx, dy) || 1;
    const nx = (-dy / len) * 0.8;
    const ny = (dx / len) * 0.8;
    s += '<g stroke-width="1.5" fill="none">';
    s += `<line x1="${f2(g.ax - nx)}" y1="${f2(g.ay - ny)}" x2="${f2(g.bx - nx)}" y2="${f2(g.by - ny)}" stroke="#E8ECF1" stroke-dasharray="1.4 1.4" opacity="0.85"/>`;
    s += `<line x1="${f2(g.ax + nx)}" y1="${f2(g.ay + ny)}" x2="${f2(g.bx + nx)}" y2="${f2(g.by + ny)}" stroke="#E8ECF1" stroke-dasharray="1.4 1.4" stroke-dashoffset="1.4" opacity="0.85"/>`;
    s += '</g>';
  }
  return s;
}

function drawTrail(f: Frame): string {
  const r = f.replay;
  const tr = r.trail;
  const cur = Math.min(tr.n - 1, Math.floor(f.t * tr.hz));
  const overview = f.mode === 'overview';
  let s = '<g fill="none" stroke-linejoin="round" stroke-linecap="round">';
  // the driven line where the car was NOT drifting (the future is never drawn: it spoils the route)
  {
    let run: Array<[number, number]> = [];
    const flush = () => {
      if (run.length > 1) s += `<polyline points="${pointsAttr(run)}" stroke="${EMBER}" stroke-width="${f3(mOrPx(f, 0.35, 1))}" opacity="0.18"/>`;
      run = [];
    };
    for (let i = 0; i <= cur; i++) {
      if (tr.segmentOf[i] >= 0) {
        flush();
        continue;
      }
      if (inView(f, tr.x[i], tr.y[i]) || run.length > 0) run.push([tr.x[i], tr.y[i]]);
      else flush();
    }
    flush();
  }
  // drift ribbons: halo + glow per segment (one polyline each — overlapping translucent chunks
  // make a lattice), then opaque core/hot layers chunked so width AND colour follow |β|
  const haloW = mOrPx(f, 4.6, 6);
  const glowW = mOrPx(f, 2.2, 3);
  for (const seg of r.segments) {
    if (seg.startIndex > cur) continue;
    const end = Math.min(seg.endIndex, cur);
    const pts: Array<[number, number]> = [];
    let visible = false;
    let peak = 0;
    for (let i = seg.startIndex; i <= end; i++) {
      pts.push([tr.x[i], tr.y[i]]);
      if (inView(f, tr.x[i], tr.y[i])) visible = true;
      if (Math.abs(tr.beta[i]) > peak) peak = Math.abs(tr.beta[i]);
    }
    if (!visible || pts.length < 2) continue;
    const attr = pointsAttr(pts);
    const col = heatColor(peak);
    const w = severityWeight(seg.severity);
    const boost = overview ? 1.6 : 1;
    s += `<polyline points="${attr}" stroke="${col}" stroke-width="${f3(haloW * (0.7 + 0.6 * w))}" opacity="${f3((0.07 + 0.11 * w) * boost)}"/>`;
    s += `<polyline points="${attr}" stroke="${col}" stroke-width="${f3(glowW * (0.8 + 0.5 * w))}" opacity="${f3((0.18 + 0.22 * w) * boost)}"/>`;
  }
  const chunked = [
    { hot: false, width: (i: number) => mOrPx(f, 0.3 + 0.75 * i, 1.2), opacity: 1 },
    { hot: true, width: (i: number) => mOrPx(f, 0.05 + 0.3 * i, 0.4), opacity: 0.92 },
  ];
  for (const layer of chunked) {
    s += `<g opacity="${layer.opacity}">`;
    for (const seg of r.segments) {
      if (seg.startIndex > cur) continue;
      const end = Math.min(seg.endIndex, cur);
      const step = 3;
      for (let a = seg.startIndex; a < end; a += step) {
        const b = Math.min(end, a + step);
        let inten = 0;
        let mag = 0;
        let visible = false;
        const pts: Array<[number, number]> = [];
        for (let i = a; i <= b; i++) {
          inten += tr.intensity[i];
          mag = Math.max(mag, Math.abs(tr.beta[i]));
          pts.push([tr.x[i], tr.y[i]]);
          if (inView(f, tr.x[i], tr.y[i])) visible = true;
        }
        if (!visible) continue;
        inten /= b - a + 1;
        if (layer.hot && inten < 0.1) continue;
        const col = layer.hot ? mix(HOT, heatColor(mag), 0.35) : heatColor(mag);
        s += `<polyline points="${pointsAttr(pts)}" stroke="${col}" stroke-width="${f3(layer.width(inten))}"/>`;
      }
    }
    s += '</g>';
  }
  s += '</g>';
  // in overview the whole route is implied by the road; drift peaks get a bloom so the eye
  // lands on the big moments rather than on an even orange noodle
  if (overview) {
    for (const seg of r.segments) {
      if (seg.peakT > f.t || !inView(f, tr.x[seg.peakIndex], tr.y[seg.peakIndex])) continue;
      const w = severityWeight(seg.severity);
      if (w < 0.45) continue;
      s += `<circle cx="${f2(tr.x[seg.peakIndex])}" cy="${f2(tr.y[seg.peakIndex])}" r="${f2(mOrPx(f, 7, 9))}" fill="${heatColor(seg.peakAngle)}" opacity="${f3(0.1 + 0.12 * w)}"/>`;
    }
  }
  return s;
}

function drawSmoke(f: Frame): string {
  const live = liveSmoke(f.replay.smoke, f.t);
  if (live.length === 0) return '';
  let s = '<g>';
  for (const p of live) {
    const st = smokeAt(p, f.t);
    if (!st || !inView(f, st.x, st.y)) continue;
    // a squashed, rotated puff reads as smoke; a circle reads as a dot
    const rx = st.radius * 1.5 * (1 + 0.35 * (st.seed - 0.5));
    const ry = st.radius * 1.5 * (0.72 + 0.3 * st.seed);
    const rot = (st.rotation * 180) / Math.PI;
    s += `<g transform="translate(${f2(st.x)} ${f2(st.y)}) rotate(${f2(rot)})">`;
    s += `<ellipse rx="${f2(rx)}" ry="${f2(ry)}" fill="url(#smoke)" opacity="${f3(Math.min(1, st.opacity * 1.55))}"/>`;
    if (st.heat > 0.05) s += `<ellipse rx="${f2(rx * 0.5)}" ry="${f2(ry * 0.5)}" fill="url(#smokeHot)" opacity="${f3(st.opacity * st.heat)}"/>`;
    s += '</g>';
  }
  return s + '</g>';
}

/** Markers on the lap being watched; older laps leave an unlabelled breadcrumb. */
function visibleMarkers(f: Frame): ReplayMarker[] {
  const lap = lapAt(f.replay, f.t);
  const li = lap ? lap.index : -1;
  return f.replay.markers.filter((m) => m.t <= f.t && (m.lapIndex === li || li < 0));
}

function drawMarkers(f: Frame): string {
  const r = f.replay;
  let s = '<g>';
  const pw = mOrPx(f, 0.3, 1);
  const lap = lapAt(r, f.t);
  const li = lap ? lap.index : -1;
  // previous laps: a 3 px breadcrumb, no ring, no label
  for (const m of r.markers) {
    if (m.t > f.t || (m.lapIndex === li && li >= 0) || !inView(f, m.x, m.y)) continue;
    if (m.kind === 'transition' || m.kind === 'drift-peak') {
      s += `<circle cx="${f2(m.x)}" cy="${f2(m.y)}" r="${f2(mOrPx(f, 0.5, 1.5))}" fill="${m.kind === 'transition' ? MAGENTA : EMBER}" opacity="0.28"/>`;
    }
  }
  for (const m of visibleMarkers(f)) {
    if (!inView(f, m.x, m.y)) continue;
    const age = f.t - m.t;
    switch (m.kind) {
      case 'transition': {
        // small chip (a 100 pt ring behind the car stole the eye from the car)
        const pulse = age < 0.7 ? 1 + 0.9 * (1 - age / 0.7) : 1;
        const rr = mOrPx(f, 1.6, 4) * pulse;
        s += `<g transform="translate(${f2(m.x)} ${f2(m.y)})">`;
        s += `<circle r="${f2(rr * 1.9)}" fill="${MAGENTA}" opacity="${f3(0.1 * (age < 1 ? 1 : 0.4))}"/>`;
        s += `<polygon points="0,${f2(rr)} ${f2(rr * 0.72)},0 0,${f2(-rr)} ${f2(-rr * 0.72)},0" fill="${MAGENTA}"/>`;
        s += `<polygon points="0,${f2(rr * 0.45)} ${f2(rr * 0.33)},0 0,${f2(-rr * 0.45)} ${f2(-rr * 0.33)},0" fill="${WHITE}" opacity="0.9"/>`;
        s += '</g>';
        break;
      }
      case 'drift-peak': {
        const col = heatColor(m.peakAngle ?? 0);
        s += `<g transform="translate(${f2(m.x)} ${f2(m.y)})"><circle r="${f2(mOrPx(f, 2, 2.6))}" fill="none" stroke="${col}" stroke-width="${f3(pw)}" opacity="0.5"/><circle r="${f2(mOrPx(f, 0.7, 1.2))}" fill="${col}"/></g>`;
        break;
      }
      case 'drift-end':
        s += `<circle cx="${f2(m.x)}" cy="${f2(m.y)}" r="${f2(mOrPx(f, 0.6, 1))}" fill="${EMBER}" opacity="0.75"/>`;
        break;
      case 'drift-start': {
        const nx = -Math.sin(m.course);
        const ny = Math.cos(m.course);
        s += `<line x1="${f2(m.x - nx * 2)}" y1="${f2(m.y - ny * 2)}" x2="${f2(m.x + nx * 2)}" y2="${f2(m.y + ny * 2)}" stroke="${EMBER}" stroke-width="${f3(pw)}" opacity="0.6"/>`;
        break;
      }
      default:
        break;
    }
  }
  return s + '</g>';
}

function carPath(): string {
  return 'M -2.2,-0.9 L 1.15,-0.9 Q 2.2,-0.75 2.2,-0.3 L 2.2,0.3 Q 2.2,0.75 1.15,0.9 L -2.2,0.9 Q -2.3,0 -2.2,-0.9 Z';
}

function drawGhost(f: Frame): string {
  const g = f.ghost;
  if (!g) return '';
  let s = '<g>';
  const lap = lapAt(f.replay, f.t);
  const tail: Array<[number, number]> = [];
  const gs = toS(f, g.x, g.y);
  const ghostOnScreen = gs.x > 0 && gs.x < W && gs.y > TOP_BAR && gs.y < H - BOTTOM_BAR;
  for (let k = 0; ghostOnScreen && k <= 18; k++) {
    const tk = f.t - k * 0.1;
    if (tk < 0 || lapAt(f.replay, tk) !== lap) break;
    const gp = ghostPoseAt(f.replay, tk);
    if (!gp) break;
    tail.push([gp.x, gp.y]);
  }
  if (tail.length > 1) {
    s += `<polyline points="${pointsAttr(tail)}" fill="none" stroke="${GREEN}" stroke-width="${f3(mOrPx(f, 0.5, 1.1))}" stroke-linecap="round" opacity="0.4" stroke-dasharray="1.1 1.1"/>`;
  }
  const tooClose = Math.hypot(gs.x - toS(f, f.pose.x, f.pose.y).x, gs.y - toS(f, f.pose.x, f.pose.y).y) < 26;
  if (ghostOnScreen && !tooClose) {
    const cs = carScale(f) * 0.9;
    s += `<g transform="translate(${f2(g.x)} ${f2(g.y)}) rotate(${f2(deg(g.heading))}) scale(${f3(cs)})" opacity="0.85">`;
    s += `<path d="${carPath()}" fill="${GREEN}" fill-opacity="0.1" stroke="${GREEN}" stroke-width="${f3(mOrPx(f, 0.25, 0.9) / cs)}" stroke-linejoin="round"/>`;
    s += `<polygon points="-0.6,-0.5 0.5,0 -0.6,0.5 -0.3,0" fill="${GREEN}" opacity="0.75"/>`;
    s += '</g>';
  }
  return s + '</g>';
}

function drawCar(f: Frame): string {
  const p = f.pose;
  const cs = carScale(f);
  const col = heatColor(p.beta);
  let s = `<g transform="translate(${f2(p.x)} ${f2(p.y)})">`;
  // under-glow while sliding, coloured by severity
  if (p.intensity > 0.02 || p.phase === 'drifting') {
    const gi = 0.22 + 0.65 * p.intensity;
    s += `<g transform="rotate(${f2(deg(p.heading))}) scale(${f3(cs)})"><ellipse rx="3.1" ry="1.9" fill="${col}" opacity="${f3(gi * 0.3)}"/><ellipse rx="2.3" ry="1.35" fill="${col}" opacity="${f3(gi * 0.3)}"/></g>`;
  }
  // velocity vector: only when there is actually slip to explain, opacity by |β|
  const slip = Math.abs(p.beta);
  if (slip > SEVERITY_EDGES.hold * 0.9 && p.speed > 2) {
    const k = clamp((slip - SEVERITY_EDGES.hold * 0.9) / (SEVERITY_EDGES.big - SEVERITY_EDGES.hold * 0.9), 0, 1);
    const op = 0.35 + 0.55 * k;
    const L = clamp(0.5 * p.speed, 3, 18) * (f.mode === 'overview' ? cs * 0.5 : 1);
    const cx = Math.cos(p.course) * L;
    const cy = Math.sin(p.course) * L;
    s += `<g stroke="${CYAN}" stroke-linecap="round" fill="none" opacity="${f3(op)}">`;
    s += `<line x1="0" y1="0" x2="${f2(cx)}" y2="${f2(cy)}" stroke-width="${f3(mOrPx(f, 0.35, 1.1))}"/>`;
    s += '</g>';
    const ah = mOrPx(f, 1.2, 3.4);
    s += `<g transform="rotate(${f2(deg(p.course))})" opacity="${f3(op)}"><polygon points="${f2(L + ah * 0.9)},0 ${f2(L - ah)},${f2(ah * 0.6)} ${f2(L - ah)},${f2(-ah * 0.6)}" fill="${CYAN}"/></g>`;
  }
  // heading line + slip arc, scaled with the marker so they stay legible
  if (f.mode !== 'overview' && slip > 0.035) {
    const hl = 6.5 * cs;
    s += `<line x1="0" y1="0" x2="${f2(Math.cos(p.heading) * hl)}" y2="${f2(Math.sin(p.heading) * hl)}" stroke="${WHITE}" stroke-width="${f3(mOrPx(f, 0.16, 0.7))}" stroke-dasharray="${f2(0.6 * cs)} ${f2(0.5 * cs)}" opacity="0.5"/>`;
    const R = 5.2 * cs;
    const a0 = p.heading;
    const a1 = p.heading + wrapAngle(p.course - p.heading);
    const sweep = a1 > a0 ? 1 : 0;
    const large = Math.abs(a1 - a0) > Math.PI ? 1 : 0;
    const aw = mOrPx(f, 0.35 + 0.5 * p.intensity, 1.1);
    s += `<path d="M ${f2(Math.cos(a0) * R)},${f2(Math.sin(a0) * R)} A ${f2(R)},${f2(R)} 0 ${large} ${sweep} ${f2(Math.cos(a1) * R)},${f2(Math.sin(a1) * R)}" fill="none" stroke="${col}" stroke-width="${f3(aw)}" stroke-linecap="round"/>`;
  }
  // body
  s += `<g transform="rotate(${f2(deg(p.heading))}) scale(${f3(cs)})">`;
  s += `<path d="${carPath()}" fill="none" stroke="${BG}" stroke-width="${f3(mOrPx(f, 0.5, 1.5) / cs)}" stroke-linejoin="round" opacity="0.9"/>`;
  for (const [x, y] of [
    [1.35, 1.0],
    [1.35, -1.0],
    [-1.45, 1.0],
    [-1.45, -1.0],
  ]) {
    s += `<rect x="${f2(x - 0.38)}" y="${f2(y - 0.2)}" width="0.76" height="0.4" rx="0.08" fill="#242A33"/>`;
  }
  s += `<path d="${carPath()}" fill="${WHITE}"/>`;
  s += `<path d="M 0.15,-0.78 L 0.95,-0.62 L 0.95,0.62 L 0.15,0.78 Z" fill="#6E7784"/>`;
  s += `<path d="M -1.95,-0.75 L -1.45,-0.62 L -1.45,0.62 L -1.95,0.75 Z" fill="#8F98A4"/>`;
  s += `<polygon points="-0.85,-0.5 0.05,0 -0.85,0.5 -0.55,0" fill="${BG}"/>`;
  // a severity rim so the car itself carries the drama at a glance
  if (p.intensity > 0.25) s += `<path d="${carPath()}" fill="none" stroke="${col}" stroke-width="${f3(0.18 + 0.22 * p.intensity)}" opacity="${f3(0.5 + 0.5 * p.intensity)}"/>`;
  s += '</g></g>';
  return s;
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
  /** Reserve a region (e.g. the car) so nothing is ever drawn on top of it. */
  reserve(b: Box): void {
    this.boxes.push(b);
  }
  place(x: number, y: number, w: number, h: number, anchor: 'start' | 'middle' | 'end' = 'start'): boolean {
    const x0 = anchor === 'start' ? x : anchor === 'end' ? x - w : x - w / 2;
    const box = { x0: x0 - 2, y0: y - h, x1: x0 + w + 2, y1: y + 3 };
    if (box.x0 < this.bounds.x0 || box.x1 > this.bounds.x1 || box.y0 < this.bounds.y0 || box.y1 > this.bounds.y1) return false;
    for (const b of this.boxes) {
      if (box.x0 < b.x1 && box.x1 > b.x0 && box.y0 < b.y1 && box.y1 > b.y0) return false;
    }
    this.boxes.push(box);
    return true;
  }
}

/** Motion streaks along the travel direction at the frame edges — speed you can see. */
function speedStreaks(f: Frame): string {
  if (f.mode === 'overview') return '';
  const k = clamp((f.pose.speed - 11) / 19, 0, 1);
  if (k <= 0.02) return '';
  const n = 14;
  let s = `<g stroke="${WHITE}" stroke-linecap="round" opacity="${f3(0.05 + 0.13 * k)}">`;
  let h = 987654321;
  for (let i = 0; i < n; i++) {
    h = (Math.imul(h, 1664525) + 1013904223) >>> 0;
    const side = i % 2 === 0 ? 1 : -1;
    const edge = ((h >>> 9) % 1000) / 1000;
    const x = side > 0 ? W * (0.02 + 0.2 * edge) : W * (0.78 + 0.2 * edge);
    h = (Math.imul(h, 1664525) + 1013904223) >>> 0;
    const y = TOP_BAR + ((h >>> 9) % 1000) / 1000 * (H - TOP_BAR - BOTTOM_BAR);
    const len = (22 + 70 * k) * (0.6 + 0.8 * (((h >>> 3) % 100) / 100));
    s += `<line x1="${f2(x)}" y1="${f2(y)}" x2="${f2(x)}" y2="${f2(y + len)}" stroke-width="${f3(0.7 + 0.8 * k)}"/>`;
  }
  return s + '</g>';
}

/**
 * Two-line ghost readout placed wherever it fits. The gap indicator is load-bearing, so if no
 * candidate is free it is drawn at the last one anyway rather than leaving a mute chevron.
 */
function ghostLabel(col: LabelCollider, x: number, y: number, w: number, gapText: string, gapPoints: number, r = 12): string {
  const cands: Array<[number, number, 'start' | 'end' | 'middle']> = [
    [r + 4, 6, 'start'],
    [-(r + 4), 6, 'end'],
    [0, -(r + 8), 'middle'],
    [0, r + 30, 'middle'],
    [r + 4, -(r + 8), 'start'],
    [-(r + 4), r + 30, 'end'],
  ];
  let pick = cands[cands.length - 1];
  for (const c of cands) {
    if (col.place(x + c[0], y + c[1], w, 28, c[2])) {
      pick = c;
      break;
    }
  }
  const [dx, dy, anchor] = pick;
  return (
    text(x + dx, y + dy - 14, 'BEST LAP', { size: T_LABEL, fill: GREEN, spacing: 1.2, anchor, stroke: BG, strokeW: 3.5 }) +
    text(x + dx, y + dy, gapText, { size: T_LABEL, fill: gapPoints >= 0 ? GREEN : MUTED, weight: 800, anchor, stroke: BG, strokeW: 3.5 })
  );
}

function worldLabels(f: Frame): string {
  const overview = f.mode === 'overview';
  let s = '<g>';
  const col = new LabelCollider({ x0: 14, y0: TOP_BAR + 10, x1: W - 14, y1: H - BOTTOM_BAR - SCRUB_H - 14 });
  const carS = toS(f, f.pose.x, f.pose.y);
  // the car and its own readouts own their space
  col.reserve({ x0: carS.x - 46, y0: carS.y - 52, x1: carS.x + 46, y1: carS.y + 40 });
  // slip readout beside the arc
  const p = f.pose;
  if (Math.abs(p.beta) > 0.05 && !overview) {
    const mid = p.heading + 0.5 * wrapAngle(p.course - p.heading);
    const R = 6.4 * carScale(f);
    const lp = toS(f, p.x + Math.cos(mid) * R, p.y + Math.sin(mid) * R);
    s += text(lp.x, lp.y + 5, `${Math.round(Math.abs(deg(p.beta)))}°`, { size: 17, fill: heatColor(p.beta), weight: 800, anchor: 'middle', stroke: BG, strokeW: 3.5 });
  }
  // markers, highest priority first, de-conflicted in screen space
  const ms = [...visibleMarkers(f)].sort((a, b) => b.priority - a.priority || b.t - a.t);
  for (const m of ms) {
    if (!inView(f, m.x, m.y)) continue;
    const sp = toS(f, m.x, m.y);
    let label = '';
    let fill: string = WHITE;
    let size = T_LABEL;
    if (m.kind === 'transition' && !overview) {
      label = m.label;
      fill = MAGENTA;
    } else if (m.kind === 'drift-peak') {
      const sev = severityWeight(m.severity ?? 'none');
      if (overview && sev < 0.45) continue;
      label = m.label;
      fill = heatColor(m.peakAngle ?? 0);
      size = sev >= 0.75 ? 16 : T_LABEL;
    } else if (m.kind === 'drift-end' && !overview) {
      label = m.label;
      fill = MUTED;
    } else if (m.kind === 'lap') {
      label = m.label;
      fill = MUTED;
    } else continue;
    const w = label.length * size * 0.42;
    for (const [dx, dy, anchor] of [
      [11, 4, 'start'],
      [-11, 4, 'end'],
      [0, -12, 'middle'],
      [0, 18, 'middle'],
    ] as Array<[number, number, 'start' | 'end' | 'middle']>) {
      if (col.place(sp.x + dx, sp.y + dy, w, size, anchor)) {
        s += text(sp.x + dx, sp.y + dy, label, { size, fill, weight: 800, anchor, stroke: BG, strokeW: 3, spacing: m.kind === 'transition' ? 1.2 : 0 });
        break;
      }
    }
  }
  // ghost: label on screen, or a racing-game edge indicator when it is off screen
  if (f.ghost && !overview) {
    const g = f.ghost;
    const gp = toS(f, g.x, g.y);
    const onScreen = gp.x > 8 && gp.x < W - 8 && gp.y > TOP_BAR && gp.y < H - BOTTOM_BAR - SCRUB_H;
    const gapPts = `${g.gapPoints >= 0 ? '+' : '−'}${pts(Math.abs(g.gapPoints))} PTS`;
    if (onScreen) {
      const gw = Math.max(58, gapPts.length * T_LABEL * 0.46);
      s += ghostLabel(col, gp.x, gp.y, gw, gapPts, g.gapPoints);
    } else {
      const dx = gp.x - carS.x;
      const dy = gp.y - carS.y;
      const inset = 30;
      let k = Infinity;
      if (dx > 0) k = Math.min(k, (W - inset - carS.x) / dx);
      if (dx < 0) k = Math.min(k, (inset - carS.x) / dx);
      if (dy > 0) k = Math.min(k, (H - BOTTOM_BAR - SCRUB_H - inset - carS.y) / dy);
      if (dy < 0) k = Math.min(k, (TOP_BAR + inset - carS.y) / dy);
      if (Number.isFinite(k) && k > 0) {
        const ex = carS.x + dx * k;
        const ey = carS.y + dy * k;
        const ang = (Math.atan2(dy, dx) * 180) / Math.PI;
        s += `<g transform="translate(${f2(ex)} ${f2(ey)})">`;
        s += `<circle r="13" fill="${BG}" fill-opacity="0.8" stroke="${GREEN}" stroke-width="1.2" opacity="0.85"/>`;
        s += `<g transform="rotate(${f2(ang)})"><polygon points="4,-6 11,0 4,6 6,0" fill="${GREEN}"/><path d="M -5,-4 L -1,0 L -5,4" fill="none" stroke="${GREEN}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" opacity="0.55"/></g>`;
        s += '</g>';
        const gw = Math.max(58, gapPts.length * T_LABEL * 0.46);
        s += ghostLabel(col, ex, ey, gw, gapPts, g.gapPoints, 18);
      }
    }
  }
  return s + '</g>';
}

/** Event-driven callout: the slam comes from `activeEvents`, identical in Skia and SVG. */
function callout(f: Frame): string {
  const e = f.events.find((ev) => ev.label !== '');
  if (!e) return '';
  const color = e.kind === 'transition' ? MAGENTA : e.kind === 'spin' ? RED : e.kind === 'peak' ? GOLD : e.kind === 'exit' ? EMBER : CYAN;
  const size = 34;
  const y = Math.round(H * 0.33);
  let s = `<g opacity="${f3(e.opacity)}" transform="translate(${W / 2} ${y}) scale(${f3(e.scale)}) translate(${-W / 2} ${-y})">`;
  s += glowText(W / 2, y, e.label, size, WHITE, color, 0.95, 'middle', 800);
  // a leader line anchors overview callouts to the place they happened
  if (f.mode === 'overview' && e.driftId !== undefined) {
    const seg = f.replay.segments.find((g) => g.driftId === e.driftId);
    if (seg) {
      const sp = toS(f, f.replay.trail.x[seg.peakIndex], f.replay.trail.y[seg.peakIndex]);
      if (sp.y > y + 18) {
        s += `<line x1="${f2(W / 2)}" y1="${f2(y + 10)}" x2="${f2(sp.x)}" y2="${f2(sp.y - 8)}" stroke="${color}" stroke-width="1" opacity="0.35" stroke-dasharray="3 3"/>`;
        s += `<circle cx="${f2(sp.x)}" cy="${f2(sp.y - 8)}" r="2.5" fill="${color}" opacity="0.6"/>`;
      }
    }
  }
  return s + '</g>';
}

function topHud(f: Frame): string {
  const r = f.replay;
  const p = f.pose;
  // letterbox: a real bar with a gradient foot, the world runs behind it
  let s = `<rect x="0" y="0" width="${W}" height="${TOP_BAR - 22}" fill="#000"/>`;
  s += `<rect x="0" y="${TOP_BAR - 22}" width="${W}" height="22" fill="url(#lbTop)"/>`;
  s += `<circle cx="20" cy="26" r="3.4" fill="${RED}"/>`;
  s += text(29, 30, 'REPLAY', { size: T_LABEL, spacing: 2.6, fill: WHITE, weight: 700 });
  s += text(W / 2, 30, `${fmtTime(f.t)} / ${fmtTime(r.durationS)}`, { size: 12, family: MONO, fill: MUTED, anchor: 'middle', weight: 700 });
  const modeLabel = f.mode === 'overview' ? 'TRACK CAM' : f.mode === 'chase' ? 'CHASE CAM' : 'CINEMATIC';
  s += text(W - 18, 30, modeLabel, { size: T_LABEL, spacing: 2, fill: MUTED, anchor: 'end', weight: 700 });
  // tier 1: the angle is the biggest thing on screen (DESIGN.md), coloured by severity
  const angle = Math.round(Math.abs(deg(p.beta)));
  const side = Math.abs(p.beta) > 0.05 ? (p.beta > 0 ? 'R' : 'L') : '';
  const col = heatColor(p.beta);
  const hot = p.severity !== 'none';
  const baseline = 86;
  if (hot) s += glowText(20, baseline, `${angle}°`, T_HERO, WHITE, col, 0.4 + 0.6 * p.intensity, 'start', 800);
  else s += text(20, baseline, `${angle}°`, { size: T_HERO, fill: MUTED, weight: 800 });
  if (side) s += text(20 + `${angle}°`.length * T_HERO * 0.42 + 6, baseline - T_HERO * 0.58, side, { size: T_LABEL, fill: col, weight: 800 });
  s += text(20, baseline + 14, 'SLIP ANGLE', { size: T_LABEL, spacing: 2, fill: MUTED, weight: 700 });
  // tier 2: speed and points, italic (things that move)
  s += text(W - 18, baseline - 26, `${kmh(p.speed)}`, { size: T_VALUE, fill: WHITE, anchor: 'end', weight: 800, italic: true });
  s += text(W - 18, baseline - 12, 'KM/H', { size: T_LABEL, spacing: 2, fill: MUTED, anchor: 'end', weight: 700 });
  const ptsCol = p.phase === 'drifting' ? EMBER : WHITE;
  s += text(W - 18, baseline + 12, pts(p.points), { size: T_VALUE, fill: ptsCol, anchor: 'end', weight: 800, italic: true });
  s += text(W - 18, baseline + 26, 'POINTS', { size: T_LABEL, spacing: 2, fill: MUTED, anchor: 'end', weight: 700 });
  if (p.multiplier > 1.05) {
    const cw = 34;
    const cx = W - 18 - pts(p.points).length * T_VALUE * 0.46 - cw - 8;
    s += `<rect x="${f2(cx)}" y="${f2(baseline - 12)}" width="${cw}" height="17" rx="3" fill="${EMBER}"/>`;
    s += text(cx + cw / 2, baseline + 1, `×${p.multiplier.toFixed(1)}`, { size: 12, fill: '#000', anchor: 'middle', weight: 800 });
  }
  return s;
}

function bottomHud(f: Frame): string {
  const r = f.replay;
  const tel = r.telemetry;
  const barTop = H - BOTTOM_BAR;
  const scrubTop = barTop - SCRUB_H;
  let s = `<rect x="0" y="${f2(scrubTop - 18)}" width="${W}" height="18" fill="url(#lbBot)"/>`;
  s += `<rect x="0" y="${f2(scrubTop)}" width="${W}" height="${f2(H - scrubTop)}" fill="#000"/>`;
  // --- scrubber: |β| as a filled ember ribbon, drift windows as ticks, no legend, no panel
  const px = 18;
  const pw = W - 36;
  const xAt = (t: number) => px + (clamp(t, 0, r.durationS) / r.durationS) * pw;
  const yTop = scrubTop + 4;
  const yBot = scrubTop + SCRUB_H - 8;
  const angleScale = Math.max(SEVERITY_EDGES.spin, tel.maxAngle * 1.05);
  const yA = (a: number) => yBot - (clamp(a / angleScale, 0, 1) * (yBot - yTop));
  s += `<line x1="${px}" y1="${f2(yBot)}" x2="${f2(W - px)}" y2="${f2(yBot)}" stroke="#1C2430" stroke-width="1"/>`;
  // the strip is MASKED to elapsed time: a replay must not open by showing its ending
  const cutIdx = Math.min(tel.n - 1, Math.max(1, Math.round(f.t * tel.hz)));
  let ribbon = `${f2(xAt(0))},${f2(yBot)} `;
  const step = Math.max(1, Math.floor(tel.n / (pw * 1.5)));
  for (let i = 0; i <= cutIdx; i += step) ribbon += `${f2(xAt(tel.t[i]))},${f2(yA(tel.angle[i]))} `;
  ribbon += `${f2(xAt(tel.t[cutIdx]))},${f2(yA(tel.angle[cutIdx]))} ${f2(xAt(tel.t[cutIdx]))},${f2(yBot)}`;
  s += `<polygon points="${ribbon}" fill="url(#ribbon)" opacity="0.95"/>`;
  // drift windows as ticks under the baseline (only those already played)
  for (const seg of r.segments) {
    if (seg.startT > f.t) continue;
    const a = xAt(seg.startT);
    const b = xAt(Math.min(seg.endT, f.t));
    s += `<rect x="${f2(a)}" y="${f2(yBot + 2)}" width="${f2(Math.max(1, b - a))}" height="2.5" rx="1.2" fill="${heatColor(seg.peakAngle)}" opacity="0.85"/>`;
  }
  // lap ticks, transitions
  for (const lap of r.laps) {
    if (lap.index === 0 || lap.startT > f.t) continue;
    s += `<line x1="${f2(xAt(lap.startT))}" y1="${f2(yTop - 2)}" x2="${f2(xAt(lap.startT))}" y2="${f2(yBot)}" stroke="${MUTED}" stroke-width="0.8" stroke-dasharray="2 2" opacity="0.6"/>`;
  }
  for (const m of r.markers) {
    if (m.kind !== 'transition' || m.t > f.t) continue;
    const x = xAt(m.t);
    s += `<polygon points="${f2(x)},${f2(yTop - 4)} ${f2(x + 2.6)},${f2(yTop)} ${f2(x)},${f2(yTop + 4)} ${f2(x - 2.6)},${f2(yTop)}" fill="${MAGENTA}" opacity="0.85"/>`;
  }
  // remaining time as a hairline, so the length of the run is still legible
  s += `<line x1="${f2(xAt(f.t))}" y1="${f2(yBot)}" x2="${f2(W - px)}" y2="${f2(yBot)}" stroke="#2A3340" stroke-width="1.5"/>`;
  const xp = xAt(f.t);
  s += `<line x1="${f2(xp)}" y1="${f2(yTop - 6)}" x2="${f2(xp)}" y2="${f2(yBot + 6)}" stroke="${WHITE}" stroke-width="1.5"/>`;
  s += `<circle cx="${f2(xp)}" cy="${f2(yA(Math.abs(f.pose.beta)))}" r="2.6" fill="${heatColor(f.pose.beta)}" stroke="${BG}" stroke-width="1"/>`;
  // --- one info line, colour-coded, no legend
  const ly = barTop + 26;
  const lap = lapAt(r, f.t);
  const lapStr = r.laps.length > 0 ? `LAP ${lap ? lap.index + 1 : r.laps.length}/${r.laps.length}` : 'STAGE';
  s += text(18, ly, lapStr, { size: T_LABEL, spacing: 1.6, fill: WHITE, weight: 800 });
  s += text(18 + lapStr.length * T_LABEL * 0.52 + 14, ly, r.info.name.toUpperCase().replace(' (SIM)', ''), { size: T_LABEL, spacing: 1.4, fill: MUTED, weight: 700 });
  // live totals only: TOTAL is the running score, the grade lands on the final frame
  s += text(W - 18, ly, 'TOTAL', { size: T_LABEL, spacing: 2, fill: MUTED, anchor: 'end', weight: 700 });
  s += text(W - 18, ly + 22, pts(f.pose.points), { size: T_VALUE, fill: WHITE, anchor: 'end', weight: 800, italic: true });
  const finished = f.t >= r.durationS - 0.05;
  if (finished) {
    const gcol = (gradeColors as Record<string, string>)[r.info.grade] ?? EMBER;
    s += `<rect x="18" y="${f2(ly + 6)}" width="30" height="22" rx="4" fill="${gcol}"/>`;
    s += text(33, ly + 23, r.info.grade, { size: 18, fill: '#000', anchor: 'middle', weight: 800 });
    s += text(54, ly + 22, 'FINAL GRADE', { size: T_LABEL, spacing: 1.6, fill: MUTED, weight: 700 });
  } else {
    const best = r.info.peakAngle;
    s += text(18, ly + 22, `${r.info.driftCount} DRIFTS`, { size: T_LABEL, spacing: 1.4, fill: MUTED, weight: 700 });
    s += text(96, ly + 22, `BEST ${Math.round(deg(best))}°`, { size: T_LABEL, spacing: 1.4, fill: heatColor(best), weight: 700 });
  }
  return s;
}

function minimap(f: Frame): string {
  if (f.mode === 'overview') return '';
  const r = f.replay;
  const size = 66;
  const x0 = W - 16 - size;
  const y0 = TOP_BAR + 14;
  const b = r.bounds;
  const sc = (size - 10) / Math.max(b.maxX - b.minX, b.maxY - b.minY);
  const mx = (x: number) => x0 + size / 2 + (x - (b.minX + b.maxX) / 2) * sc;
  const my = (y: number) => y0 + size / 2 - (y - (b.minY + b.maxY) / 2) * sc;
  let s = '<g opacity="0.92">';
  const pts: Array<[number, number]> = [];
  if (r.track) for (let i = 0; i < r.track.path.length; i += 2) pts.push([mx(r.track.path[i].x), my(r.track.path[i].y)]);
  else for (let i = 0; i < r.trail.n; i += 8) pts.push([mx(r.trail.x[i]), my(r.trail.y[i])]);
  const tag = r.track?.closed ? 'polygon' : 'polyline';
  s += `<${tag} points="${pointsAttr(pts)}" fill="none" stroke="#39465A" stroke-width="2" stroke-linejoin="round"/>`;
  const cur = Math.min(r.trail.n - 1, Math.floor(f.t * r.trail.hz));
  for (const seg of r.segments) {
    if (seg.startIndex > cur) continue;
    const end = Math.min(seg.endIndex, cur);
    const sp: Array<[number, number]> = [];
    for (let i = seg.startIndex; i <= end; i += 3) sp.push([mx(r.trail.x[i]), my(r.trail.y[i])]);
    if (sp.length > 1) s += `<polyline points="${pointsAttr(sp)}" fill="none" stroke="${heatColor(seg.peakAngle)}" stroke-width="1.7" stroke-linecap="round" opacity="0.95"/>`;
  }
  if (f.ghost) s += `<circle cx="${f2(mx(f.ghost.x))}" cy="${f2(my(f.ghost.y))}" r="2" fill="none" stroke="${GREEN}" stroke-width="1"/>`;
  s += `<circle cx="${f2(mx(f.pose.x))}" cy="${f2(my(f.pose.y))}" r="3" fill="${WHITE}" stroke="${BG}" stroke-width="1"/>`;
  return s + '</g>';
}

// ---------------------------------------------------------------- frame
function grainPattern(): string {
  // real (if static) noise: cairosvg has no feTurbulence, so scatter hashed dots at ~2 %
  let dots = '';
  let h = 12345;
  for (let i = 0; i < 260; i++) {
    h = (Math.imul(h, 1664525) + 1013904223) >>> 0;
    const x = ((h >>> 8) % 1000) / 10;
    h = (Math.imul(h, 1664525) + 1013904223) >>> 0;
    const y = ((h >>> 8) % 1000) / 10;
    h = (Math.imul(h, 1664525) + 1013904223) >>> 0;
    const o = 0.25 + ((h >>> 8) % 100) / 133;
    dots += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="1" height="1" fill="#fff" opacity="${o.toFixed(2)}"/>`;
  }
  return `<pattern id="grain" width="100" height="100" patternUnits="userSpaceOnUse">${dots}</pattern>`;
}

function renderFrame(f: Frame): string {
  const cam = f.cam;
  // shake: driven by replay.events, so Skia and SVG shake identically
  const sh = f.shake;
  const shx = sh * 2.4 * Math.sin(f.t * 97);
  const shy = sh * 2.4 * Math.cos(f.t * 113);
  const worldTransform = `translate(${f2(cam.w / 2 + shx)} ${f2(cam.h / 2 + shy)}) scale(${f3(cam.zoom)} ${f3(-cam.zoom)}) rotate(${f3(deg(cam.rotation))}) translate(${f2(-cam.cx)} ${f2(-cam.cy)})`;
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1170" height="2532" viewBox="0 0 ${W} ${H}">`;
  svg += '<defs>';
  svg += `<radialGradient id="smoke" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#C9D0DA" stop-opacity="0.8"/><stop offset="0.5" stop-color="#AEB6C2" stop-opacity="0.38"/><stop offset="1" stop-color="#8F98A6" stop-opacity="0"/></radialGradient>`;
  svg += `<radialGradient id="smokeHot" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#FFF6EE" stop-opacity="0.95"/><stop offset="1" stop-color="#FFD9BE" stop-opacity="0"/></radialGradient>`;
  svg += `<radialGradient id="vignette" gradientUnits="userSpaceOnUse" cx="${W / 2}" cy="${H / 2}" r="${Math.hypot(W / 2, H / 2) * 0.95}"><stop offset="0.45" stop-color="#000" stop-opacity="0"/><stop offset="0.8" stop-color="#000" stop-opacity="0.16"/><stop offset="1" stop-color="#000" stop-opacity="0.5"/></radialGradient>`;
  svg += `<linearGradient id="lbTop" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000" stop-opacity="1"/><stop offset="1" stop-color="#000" stop-opacity="0"/></linearGradient>`;
  svg += `<linearGradient id="lbBot" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="1"/></linearGradient>`;
  svg += `<linearGradient id="ribbon" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="${EMBER}" stop-opacity="0.25"/><stop offset="0.55" stop-color="${EMBER}" stop-opacity="0.8"/><stop offset="0.8" stop-color="${GOLD}" stop-opacity="0.9"/><stop offset="1" stop-color="${RED}" stop-opacity="0.95"/></linearGradient>`;
  svg += `<radialGradient id="pool" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#2C3A4C" stop-opacity="0.5"/><stop offset="0.55" stop-color="#1B2532" stop-opacity="0.28"/><stop offset="1" stop-color="#0D131B" stop-opacity="0"/></radialGradient>`;
  svg += grainPattern();
  svg += '</defs>';
  svg += `<rect width="${W}" height="${H}" fill="${BG}"/>`;
  svg += `<g transform="${worldTransform}">`;
  svg += drawGround(f);
  svg += drawRoad(f);
  svg += drawTrail(f);
  svg += drawMarkers(f);
  svg += drawSmoke(f);
  svg += drawCar(f);
  svg += drawGhost(f);
  svg += '</g>';
  svg += speedStreaks(f);
  svg += `<rect width="${W}" height="${H}" fill="url(#vignette)"/>`;
  svg += `<rect width="${W}" height="${H}" fill="url(#grain)" opacity="0.022"/>`;
  svg += worldLabels(f);
  svg += minimap(f);
  svg += callout(f);
  svg += topHud(f);
  svg += bottomHud(f);
  if (f.replay.warnings.length) {
    const msg = f.replay.warnings.some((w) => /SIGNAL LOST/.test(w)) ? 'SIGNAL LOST' : 'DATA GAPS';
    const wy = TOP_BAR + 18;
    svg += `<rect x="18" y="${f2(wy - 12)}" width="${f2(14 + msg.length * 7.2)}" height="18" rx="3" fill="${RED}" opacity="0.85"/>`;
    svg += text(25, wy + 1, msg, { size: T_LABEL, fill: '#000', weight: 800, spacing: 1.4 });
  }
  // a cut cross-fades from black for 120 ms (film language for a camera change)
  if (cam.cutFade > 0.001) svg += `<rect width="${W}" height="${H}" fill="#000" opacity="${f3(cam.cutFade * 0.55)}"/>`;
  svg += '</svg>';
  return svg;
}

// ---------------------------------------------------------------- CLI
function resolveTime(replay: Replay, spec: string): number {
  const num = Number(spec);
  if (Number.isFinite(num)) return clamp(num, 0, replay.durationS);
  const segs = [...replay.segments].sort((a, b) => b.peakAngle - a.peakAngle);
  const transitions = replay.markers.filter((m) => m.kind === 'transition');
  const m = /^transition(\d*)$/.exec(spec);
  if (m) {
    const k = m[1] ? Number(m[1]) - 1 : 0;
    const tr = transitions[Math.min(k, transitions.length - 1)];
    return tr ? tr.t + 0.12 : replay.durationS / 2;
  }
  if (spec === 'peak' || spec === 'spin') return segs[0]?.peakT ?? replay.durationS / 2;
  if (spec === 'mid') return replay.durationS / 2;
  if (spec === 'end') return replay.durationS;
  if (spec === 'start') return 0;
  if (spec === 'straight') {
    let best = replay.durationS / 2;
    let bestScore = Infinity;
    for (let t = 1; t < replay.durationS; t += 0.2) {
      const p = poseAt(replay, t);
      if (p.speed < 18) continue;
      const sc = Math.abs(p.beta);
      if (sc < bestScore) {
        bestScore = sc;
        best = t;
      }
    }
    return best;
  }
  if (spec === 'slow') {
    let best = 0;
    let bestV = Infinity;
    for (let t = 1; t < replay.durationS - 1; t += 0.2) {
      const v = poseAt(replay, t).speed;
      if (v > 0.5 && v < bestV) {
        bestV = v;
        best = t;
      }
    }
    return best;
  }
  if (spec === 'ghost') {
    let best: { t: number; score: number } | null = null;
    for (const lap of replay.laps) {
      for (let t = lap.startT + 1; t < lap.endT; t += 0.1) {
        const g = ghostPoseAt(replay, t);
        const p = poseAt(replay, t);
        if (!g || p.phase !== 'drifting') continue;
        const d = Math.hypot(g.x - p.x, g.y - p.y);
        if (d < 6 || d > 34) continue;
        const score = p.intensity + Math.min(d, 25) / 50;
        if (!best || score > best.score) best = { t, score };
      }
    }
    if (best) return best.t;
    let closest: { t: number; d: number } | null = null;
    for (const lap of replay.laps) {
      for (let t = lap.startT + 1; t < lap.endT; t += 0.1) {
        const g = ghostPoseAt(replay, t);
        const p = poseAt(replay, t);
        if (!g || p.intensity < 0.3) continue;
        const d = Math.hypot(g.x - p.x, g.y - p.y);
        if (!closest || d < closest.d) closest = { t, d };
      }
    }
    return closest ? closest.t : replay.durationS / 2;
  }
  if (spec === 'lap2' || spec === 'lap2-peak') {
    const lap = replay.laps[1];
    if (!lap) return replay.durationS / 2;
    const inLap = segs.filter((s) => s.peakT >= lap.startT && s.peakT <= lap.endT);
    if (spec === 'lap2-peak') return inLap[0]?.peakT ?? lap.startT + lap.durationS / 2;
    const longest = [...inLap].sort((a, b) => b.durationS - a.durationS)[0];
    return longest ? longest.startT + longest.durationS * 0.35 : lap.startT + lap.durationS / 2;
  }
  throw new Error(`unknown time spec "${spec}"`);
}

/** Force a synthetic slide of `betaDeg` around the biggest drift, to test escalation. */
function amplifyBeta(replay: Replay, betaDeg: number): number {
  const target = (betaDeg * Math.PI) / 180;
  const seg = [...replay.segments].sort((a, b) => b.peakAngle - a.peakAngle)[0];
  if (!seg) return replay.durationS / 2;
  const tr = replay.trail;
  const k = target / Math.max(1e-6, seg.peakAngle);
  for (let i = seg.startIndex; i <= seg.endIndex; i++) {
    const b = tr.beta[i] * k;
    tr.beta[i] = b;
    tr.intensity[i] = clamp((Math.abs(b) - replay.options.intensityLo) / (replay.options.intensityHi - replay.options.intensityLo), 0, 1);
  }
  seg.peakAngle = Math.abs(tr.beta[seg.peakIndex]);
  seg.severity = seg.peakAngle >= SEVERITY_EDGES.spin ? 'spin' : seg.peakAngle >= SEVERITY_EDGES.extreme ? 'extreme' : 'big';
  for (const m of replay.markers) if (m.kind === 'drift-peak' && m.driftId === seg.driftId) {
    m.peakAngle = seg.peakAngle;
    m.severity = seg.severity;
    m.label = `${Math.round(deg(seg.peakAngle))}°`;
  }
  for (const e of replay.events) if (e.driftId === seg.driftId && (e.kind === 'peak' || e.kind === 'spin')) {
    e.label = seg.severity === 'spin' ? 'ON THE EDGE' : `${Math.round(deg(seg.peakAngle))}° ANGLE`;
    e.kind = seg.severity === 'spin' ? 'spin' : 'peak';
    e.magnitude = 1;
  }
  replay.info.peakAngle = Math.max(replay.info.peakAngle, seg.peakAngle);
  return seg.peakT;
}

export function renderReplayFrame(
  track: TrackId,
  seed: number,
  timeSpec: string,
  mode: CameraMode,
  simOpts: { laps?: number; consistency?: number; aggression?: number; betaDeg?: number; cut?: boolean } = {},
): { svg: string; t: number; replay: Replay } {
  const run = simulateRun(track, { seed, laps: simOpts.laps ?? 2, consistency: simOpts.consistency, aggression: simOpts.aggression });
  const session = sessionFromSimulation(run);
  const replay = buildReplay(session);
  let t = resolveTime(replay, timeSpec);
  if (simOpts.betaDeg) t = amplifyBeta(replay, simOpts.betaDeg);
  const cam = new ReplayCamera(simOpts.cut ? 'overview' : mode, { w: W, h: H });
  const dt = 1 / FPS;
  let state = cam.update(replay, 0, dt);
  const cutAt = simOpts.cut ? Math.max(0, t - 0.07) : Infinity;
  let switched = false;
  for (let tt = dt; tt <= t + 1e-9; tt += dt) {
    if (!switched && tt >= cutAt) {
      cam.setMode(mode);
      switched = true;
    }
    state = cam.update(replay, tt, dt);
  }
  const corners = [screenToWorld(state, 0, 0), screenToWorld(state, W, 0), screenToWorld(state, 0, H), screenToWorld(state, W, H)];
  const margin = 30;
  const vis = {
    minX: Math.min(...corners.map((c) => c.x)) - margin,
    maxX: Math.max(...corners.map((c) => c.x)) + margin,
    minY: Math.min(...corners.map((c) => c.y)) - margin,
    maxY: Math.max(...corners.map((c) => c.y)) + margin,
  };
  const frame: Frame = {
    replay,
    t,
    mode,
    cam: state,
    pose: poseAt(replay, t),
    ghost: ghostPoseAt(replay, t),
    events: activeEvents(replay, t),
    shake: shakeAt(replay, t),
    vis,
    track,
    seed,
  };
  return { svg: renderFrame(frame), t, replay };
}

function main(): void {
  const args = process.argv.slice(2);
  const flags: Record<string, string> = {};
  const pos: string[] = [];
  for (const a of args) {
    const m = /^--([\w-]+)(?:=(.*))?$/.exec(a);
    if (m) flags[m[1]] = m[2] ?? '1';
    else pos.push(a);
  }
  const [track = 'harbor', seedS = '1', timeSpec = 'mid', modeS = 'chase', out = 'artifacts/replay.svg'] = pos;
  const mode = modeS as CameraMode;
  if (!['overview', 'chase', 'cinematic'].includes(mode)) throw new Error(`mode must be overview|chase|cinematic, got ${modeS}`);
  const { svg, t, replay } = renderReplayFrame(track as TrackId, Number(seedS), timeSpec, mode, {
    laps: flags.laps ? Number(flags.laps) : undefined,
    consistency: flags.consistency ? Number(flags.consistency) : undefined,
    aggression: flags.aggression ? Number(flags.aggression) : undefined,
    betaDeg: flags.beta ? Number(flags.beta) : undefined,
    cut: !!flags.cut,
  });
  writeFileSync(out, svg);
  const p = poseAt(replay, t);
  const g = ghostPoseAt(replay, t);
  process.stderr.write(
    `wrote ${out}  t=${t.toFixed(2)}s mode=${mode} ${p.phase} β=${deg(p.beta).toFixed(1)}° (${p.severity}) v=${kmh(p.speed)} km/h pts=${Math.round(p.points)} smoke=${liveSmoke(replay.smoke, t).length} ghost=${g ? `lap ${g.lapIndex + 1} ${g.gapPoints >= 0 ? '+' : ''}${Math.round(g.gapPoints)} pts / ${g.gapS.toFixed(1)} s` : 'none'}${replay.warnings.length ? ` warnings=${replay.warnings.length}` : ''}\n`,
  );
}

const isMain = process.argv[1] && /render-replay\.ts$/.test(process.argv[1]);
if (isMain) main();
