/**
 * Render one frame of a simulated session's replay as SVG (the harness/critic renderer).
 * Draws exactly the scene data from src/engine/replay — the Skia renderer in the app draws the same.
 *
 * usage: npx tsx tools/analysis/render-replay.ts <harbor|touge> <seed> <t|keyword> <overview|chase|cinematic> out.svg
 *          [--laps=N] [--consistency=0..1] [--aggression=0..1]
 *   t: replay-relative seconds, or a keyword:
 *      mid          middle of the run
 *      peak         the biggest drift at its peak angle
 *      transition   the first direction change (append a number for the n-th: transition2)
 *      lap2         mid-drift in lap 2
 *      lap2-peak    the biggest drift of lap 2 at its peak
 *      ghost        mid-drift on a non-best lap with the best-lap ghost on screen and clearly separated
 *      end          the last frame
 * Convert with tools/analysis/render_replay.py (SVG → PNG at 1170×2532).
 */
import { writeFileSync } from 'node:fs';
import { simulateRun, type TrackId } from '../../src/sim';
import {
  buildReplay,
  ghostPoseAt,
  lapAt,
  liveSmoke,
  poseAt,
  ReplayCamera,
  screenToWorld,
  sessionFromSimulation,
  smokeAt,
  worldToScreen,
  type CameraMode,
  type CameraState,
  type GhostPose,
  type Replay,
  type ReplayPose,
} from '../../src/engine/replay';
import { clamp, wrapAngle } from '../../src/engine/types';

// ---------------------------------------------------------------- palette & layout
const BG = '#07090D';
const EMBER = '#FF5A1F';
const EMBER_HOT = '#FFE3CF';
const CYAN = '#29E3FF';
const MAGENTA = '#FF2D95';
const WHITE = '#F4F6F8';
const GREY = '#8A93A0';
const PANEL = '#0B0F15';
const LINE = '#1C2430';
const FONT = 'Barlow Condensed, Impact, sans-serif';
const MONO = 'Orbitron, Barlow Condensed, sans-serif';

const W = 390;
const H = 844;
const TOP = 110; // top letterbox / HUD bar
const BOTTOM = 154; // bottom letterbox / telemetry bar
const WORLD_H = H - TOP - BOTTOM;
const FPS = 60;

// ---------------------------------------------------------------- helpers
const f2 = (v: number) => (Math.abs(v) < 1e-9 ? '0' : v.toFixed(2).replace(/\.?0+$/, ''));
const f3 = (v: number) => v.toFixed(3).replace(/\.?0+$/, '');
const deg = (r: number) => (r * 180) / Math.PI;
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fmtPts = (p: number) => Math.round(p).toLocaleString('en-US').replace(/,/g, ' ');
const fmtTime = (s: number) => {
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${String(m).padStart(2, '0')}:${r < 10 ? '0' : ''}${r.toFixed(1)}`;
};
const kmh = (v: number) => Math.round(v * 3.6);

function pointsAttr(pts: Array<[number, number]>): string {
  let s = '';
  for (const [x, y] of pts) s += `${f2(x)},${f2(y)} `;
  return s.trim();
}

/** Text in screen space. */
function text(x: number, y: number, s: string, o: { size: number; fill?: string; weight?: number; anchor?: 'start' | 'middle' | 'end'; family?: string; spacing?: number; opacity?: number; stroke?: string; strokeW?: number; italic?: boolean }): string {
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
  const body = `<text ${attrs.join(' ')}>${esc(s)}</text>`;
  if (!o.stroke) return body;
  // cairosvg ignores paint-order, so the outline is a separate stroke-only copy underneath
  const under = attrs.map((a) => (a.startsWith('fill=') ? `fill="none"` : a));
  return `<text ${under.join(' ')} stroke="${o.stroke}" stroke-width="${o.strokeW ?? 2}" stroke-linejoin="round">${esc(s)}</text>` + body;
}

/** Big glowing text: a translucent thick-stroked copy under the fill text. */
function glowText(x: number, y: number, s: string, size: number, fill: string, glow: string, glowOpacity: number, anchor: 'start' | 'middle' | 'end' = 'middle', weight = 800): string {
  return (
    text(x, y, s, { size, fill: glow, anchor, weight, stroke: glow, strokeW: size * 0.22, opacity: glowOpacity * 0.5 }) +
    text(x, y, s, { size, fill: glow, anchor, weight, stroke: glow, strokeW: size * 0.09, opacity: glowOpacity }) +
    text(x, y, s, { size, fill, anchor, weight })
  );
}

/** Offset a polyline sideways by d metres (left of travel for d > 0). */
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
  /** visible world bbox (metres) with margin */
  vis: { minX: number; maxX: number; minY: number; maxY: number };
  track: TrackId;
  seed: number;
}

function inView(f: Frame, x: number, y: number): boolean {
  return x >= f.vis.minX && x <= f.vis.maxX && y >= f.vis.minY && y <= f.vis.maxY;
}

/** Width in metres that is at least `px` pixels on screen. */
function mOrPx(f: Frame, m: number, px: number): number {
  return Math.max(m, px / f.cam.zoom);
}

// ---------------------------------------------------------------- world layers (drawn inside the world transform, units = metres, y up)
function drawGrid(f: Frame): string {
  const spacing = f.cam.zoom > 2.5 ? 20 : 50;
  const w = 1 / f.cam.zoom;
  let s = `<g stroke="#131A23" stroke-width="${f3(w)}" opacity="0.9">`;
  const x0 = Math.floor(f.vis.minX / spacing) * spacing;
  const y0 = Math.floor(f.vis.minY / spacing) * spacing;
  for (let x = x0; x <= f.vis.maxX; x += spacing) s += `<line x1="${f2(x)}" y1="${f2(f.vis.minY)}" x2="${f2(x)}" y2="${f2(f.vis.maxY)}"/>`;
  for (let y = y0; y <= f.vis.maxY; y += spacing) s += `<line x1="${f2(f.vis.minX)}" y1="${f2(y)}" x2="${f2(f.vis.maxX)}" y2="${f2(y)}"/>`;
  return s + '</g>';
}

function drawRoad(f: Frame): string {
  const r = f.replay;
  let pts: Array<[number, number]>;
  let closed = false;
  if (r.track) {
    pts = r.track.path.map((p) => [p.x, p.y]);
    closed = r.track.closed;
  } else {
    pts = [];
    for (let i = 0; i < r.trail.n; i += 4) pts.push([r.trail.x[i], r.trail.y[i]]);
  }
  const tag = closed ? 'polygon' : 'polyline';
  const attr = pointsAttr(pts);
  const roadW = 9;
  let s = '<g fill="none" stroke-linejoin="round" stroke-linecap="round">';
  // soft shoulder glow (the "lit track map" look)
  s += `<${tag} points="${attr}" stroke="${CYAN}" stroke-width="${f2(roadW + 4)}" opacity="0.06"/>`;
  s += `<${tag} points="${attr}" stroke="#222B37" stroke-width="${f2(roadW + 0.8)}"/>`;
  s += `<${tag} points="${attr}" stroke="#141A22" stroke-width="${f2(roadW)}"/>`;
  // edge markings
  const ew = mOrPx(f, 0.3, 0.8);
  for (const d of [roadW / 2 - 0.35, -(roadW / 2 - 0.35)]) {
    const e = offsetPolyline(pts, d, closed);
    s += `<${tag} points="${pointsAttr(e)}" stroke="#4A5A6E" stroke-width="${f3(ew)}" opacity="0.95"/>`;
  }
  // centre line
  s += `<${tag} points="${attr}" stroke="#1E2732" stroke-width="${f3(mOrPx(f, 0.2, 0.6))}" stroke-dasharray="2.5 3.5"/>`;
  s += '</g>';
  // start / finish gate: two rows of checks
  if (r.track?.gate) {
    const g = r.track.gate;
    const dx = g.bx - g.ax;
    const dy = g.by - g.ay;
    const len = Math.hypot(dx, dy) || 1;
    const nx = (-dy / len) * 0.7;
    const ny = (dx / len) * 0.7;
    s += `<g stroke-width="1.3" fill="none">`;
    s += `<line x1="${f2(g.ax - nx)}" y1="${f2(g.ay - ny)}" x2="${f2(g.bx - nx)}" y2="${f2(g.by - ny)}" stroke="#E8ECF1" stroke-dasharray="1.3 1.3" opacity="0.9"/>`;
    s += `<line x1="${f2(g.ax + nx)}" y1="${f2(g.ay + ny)}" x2="${f2(g.bx + nx)}" y2="${f2(g.by + ny)}" stroke="#E8ECF1" stroke-dasharray="1.3 1.3" stroke-dashoffset="1.3" opacity="0.9"/>`;
    s += '</g>';
  }
  return s;
}

function drawTrail(f: Frame): string {
  const r = f.replay;
  const tr = r.trail;
  const cur = Math.min(tr.n - 1, Math.floor(f.t * tr.hz));
  let s = '<g fill="none" stroke-linejoin="round" stroke-linecap="round">';
  // idle (non-drift) portions: driven = dim ember, future = fainter
  const idleW = mOrPx(f, 0.55, 1.2);
  let run: Array<[number, number]> = [];
  let runDrift = false;
  let runFuture = false;
  const flush = () => {
    if (run.length > 1) {
      if (!runDrift) {
        s += `<polyline points="${pointsAttr(run)}" stroke="${EMBER}" stroke-width="${f3(idleW)}" opacity="${runFuture ? (f.mode === 'overview' ? 0.09 : 0.04) : 0.3}"/>`;
      } else if (runFuture) {
        s += `<polyline points="${pointsAttr(run)}" stroke="${EMBER}" stroke-width="${f3(mOrPx(f, 1.0, 1.5))}" opacity="${f.mode === 'overview' ? 0.16 : 0.06}"/>`;
      }
    }
    run = [];
  };
  for (let i = 0; i < tr.n; i++) {
    const drift = tr.segmentOf[i] >= 0;
    const future = i > cur;
    if (drift !== runDrift || future !== runFuture) {
      const last = run[run.length - 1];
      flush();
      if (last) run.push(last);
      runDrift = drift;
      runFuture = future;
    }
    if (inView(f, tr.x[i], tr.y[i]) || run.length > 0) run.push([tr.x[i], tr.y[i]]);
    if (run.length > 0 && !inView(f, tr.x[i], tr.y[i])) flush();
  }
  flush();
  // driven drift segments. Translucent halo/glow layers are ONE polyline per segment (overlapping
  // translucent chunks would show a lattice); the opaque core/hot layers are chunked with the
  // width driven by intensity, which is artifact-free and shows the angle modulation.
  const cur2 = cur;
  const haloW = mOrPx(f, 6.5, 7);
  const glowW = mOrPx(f, 3.0, 3.4);
  const segPts = (seg: (typeof r.segments)[number]) => {
    const end = Math.min(seg.endIndex, cur2);
    const pts: Array<[number, number]> = [];
    let visible = false;
    let peak = 0;
    for (let i = seg.startIndex; i <= end; i++) {
      pts.push([tr.x[i], tr.y[i]]);
      if (inView(f, tr.x[i], tr.y[i])) visible = true;
      if (tr.intensity[i] > peak) peak = tr.intensity[i];
    }
    return { pts, visible, peak };
  };
  for (const seg of r.segments) {
    if (seg.startIndex > cur2) continue;
    const { pts, visible, peak } = segPts(seg);
    if (!visible || pts.length < 2) continue;
    const attr = pointsAttr(pts);
    s += `<polyline points="${attr}" stroke="${EMBER}" stroke-width="${f3(haloW)}" opacity="${f3(0.09 + 0.1 * peak)}"/>`;
    s += `<polyline points="${attr}" stroke="${EMBER}" stroke-width="${f3(glowW)}" opacity="${f3(0.2 + 0.2 * peak)}"/>`;
  }
  const chunked: Array<{ color: string; width: (i: number) => number; opacity: number }> = [
    { color: EMBER, width: (i) => mOrPx(f, 0.5 + 1.3 * i, 1.4), opacity: 1 },
    { color: EMBER_HOT, width: (i) => mOrPx(f, 0.08 + 0.5 * i, 0.5), opacity: 0.9 },
  ];
  for (const layer of chunked) {
    s += `<g stroke="${layer.color}" opacity="${layer.opacity}">`;
    for (const seg of r.segments) {
      if (seg.startIndex > cur2) continue;
      const end = Math.min(seg.endIndex, cur2);
      const step = 3;
      for (let a = seg.startIndex; a < end; a += step) {
        const b = Math.min(end, a + step);
        let inten = 0;
        let visible = false;
        const pts: Array<[number, number]> = [];
        for (let i = a; i <= b; i++) {
          inten += tr.intensity[i];
          pts.push([tr.x[i], tr.y[i]]);
          if (inView(f, tr.x[i], tr.y[i])) visible = true;
        }
        if (!visible) continue;
        inten /= b - a + 1;
        if (layer.color === EMBER_HOT && inten < 0.12) continue;
        s += `<polyline points="${pointsAttr(pts)}" stroke-width="${f3(layer.width(inten))}"/>`;
      }
    }
    s += '</g>';
  }
  return s + '</g>';
}

function drawSmoke(f: Frame): string {
  const live = liveSmoke(f.replay.smoke, f.t);
  if (live.length === 0) return '';
  let s = '<g>';
  for (const p of live) {
    const st = smokeAt(p, f.t);
    if (!st || !inView(f, st.x, st.y)) continue;
    s += `<circle cx="${f2(st.x)}" cy="${f2(st.y)}" r="${f2(st.radius)}" fill="url(#smoke)" opacity="${f3(st.opacity)}"/>`;
    s += `<circle cx="${f2(st.x)}" cy="${f2(st.y)}" r="${f2(st.radius * 0.55)}" fill="url(#smokeCore)" opacity="${f3(st.opacity * 0.8)}"/>`;
  }
  return s + '</g>';
}

function drawMarkers(f: Frame): string {
  const r = f.replay;
  let s = '<g>';
  const pw = mOrPx(f, 0.3, 1);
  for (const m of r.markers) {
    if (m.t > f.t || !inView(f, m.x, m.y)) continue;
    const age = f.t - m.t;
    switch (m.kind) {
      case 'transition': {
        const pulse = age < 1.2 ? 1 + 1.5 * (1 - age / 1.2) : 1;
        s += `<g transform="translate(${f2(m.x)} ${f2(m.y)})" fill="none" stroke="${MAGENTA}">`;
        s += `<circle r="${f2(6 * pulse)}" stroke-width="${f3(pw)}" opacity="0.28"/>`;
        s += `<circle r="${f2(3.6 * pulse)}" stroke-width="${f3(pw * 1.6)}" opacity="0.6"/>`;
        s += `<polygon points="0,2.2 1.6,0 0,-2.2 -1.6,0" fill="${MAGENTA}" stroke="none"/>`;
        s += `<polygon points="0,1.1 0.8,0 0,-1.1 -0.8,0" fill="${WHITE}" stroke="none"/>`;
        s += '</g>';
        break;
      }
      case 'drift-peak':
        s += `<g transform="translate(${f2(m.x)} ${f2(m.y)})"><circle r="${f2(mOrPx(f, 2.2, 3))}" fill="none" stroke="${EMBER}" stroke-width="${f3(pw)}" opacity="0.55"/><circle r="${f2(mOrPx(f, 0.8, 1.4))}" fill="${EMBER_HOT}"/></g>`;
        break;
      case 'drift-end':
        s += `<circle cx="${f2(m.x)}" cy="${f2(m.y)}" r="${f2(mOrPx(f, 0.7, 1.2))}" fill="${EMBER}" opacity="0.8"/>`;
        break;
      case 'drift-start': {
        const nx = -Math.sin(m.course);
        const ny = Math.cos(m.course);
        s += `<line x1="${f2(m.x - nx * 2.2)}" y1="${f2(m.y - ny * 2.2)}" x2="${f2(m.x + nx * 2.2)}" y2="${f2(m.y + ny * 2.2)}" stroke="${EMBER}" stroke-width="${f3(pw)}" opacity="0.7"/>`;
        break;
      }
      default:
        break;
    }
  }
  return s + '</g>';
}

/** Scale factor so the car marker is never smaller than ~14 screen units long. */
function carScale(f: Frame): number {
  return Math.max(1, 14 / (4.4 * f.cam.zoom));
}

function carPath(): string {
  // car-local metres: x forward, y left. Tapered nose, boxy tail.
  return 'M -2.2,-0.9 L 1.15,-0.9 Q 2.2,-0.75 2.2,-0.3 L 2.2,0.3 Q 2.2,0.75 1.15,0.9 L -2.2,0.9 Q -2.3,0 -2.2,-0.9 Z';
}

function drawGhost(f: Frame): string {
  const g = f.ghost;
  if (!g) return '';
  let s = '<g>';
  // tail: last 3 s of the ghost's motion
  const tail: Array<[number, number]> = [];
  const lap = lapAt(f.replay, f.t);
  for (let k = 0; k <= 30; k++) {
    const tk = f.t - k * 0.1;
    if (tk < 0) break;
    if (lapAt(f.replay, tk) !== lap) break;
    const gp = ghostPoseAt(f.replay, tk);
    if (!gp) break;
    tail.push([gp.x, gp.y]);
  }
  if (tail.length > 1) {
    s += `<polyline points="${pointsAttr(tail)}" fill="none" stroke="${CYAN}" stroke-width="${f3(mOrPx(f, 0.6, 1.2))}" stroke-linecap="round" stroke-linejoin="round" opacity="0.55" stroke-dasharray="1 1"/>`;
  }
  if (inView(f, g.x, g.y)) {
    const near = Math.hypot(g.x - f.pose.x, g.y - f.pose.y) < 3;
    const op = near ? 0.75 : 0.9;
    s += `<g transform="translate(${f2(g.x)} ${f2(g.y)}) rotate(${f2(deg(g.heading))}) scale(${f3(carScale(f))})" opacity="${op}">`;
    s += `<path d="${carPath()}" fill="${CYAN}" fill-opacity="${near ? 0 : 0.12}" stroke="${CYAN}" stroke-width="${f3(mOrPx(f, 0.25, 0.9) / carScale(f))}" stroke-linejoin="round" stroke-dasharray="${near ? '0.5 0.3' : 'none'}"/>`;
    s += `<polygon points="-0.6,-0.5 0.45,0 -0.6,0.5 -0.3,0" fill="${CYAN}" opacity="0.8"/>`;
    s += '</g>';
  }
  return s + '</g>';
}

function drawCar(f: Frame): string {
  const p = f.pose;
  let s = `<g transform="translate(${f2(p.x)} ${f2(p.y)})">`;
  // under-glow while sliding
  if (p.intensity > 0.02 || p.phase === 'drifting') {
    const gi = 0.2 + 0.6 * p.intensity;
    s += `<g transform="rotate(${f2(deg(p.heading))})"><ellipse rx="4.2" ry="2.8" fill="url(#underglow)" opacity="${f3(gi)}"/></g>`;
  }
  // velocity vector along the course (cyan) with a glow layer
  const L = clamp(0.55 * p.speed, 2.5, 20) * (f.mode === 'overview' ? carScale(f) * 0.6 : 1);
  const cx = Math.cos(p.course) * L;
  const cy = Math.sin(p.course) * L;
  const ahW = 1.6;
  s += `<g stroke="${CYAN}" stroke-linecap="round" fill="none">`;
  s += `<line x1="0" y1="0" x2="${f2(cx)}" y2="${f2(cy)}" stroke-width="${f3(mOrPx(f, 1.4, 3))}" opacity="0.22"/>`;
  s += `<line x1="0" y1="0" x2="${f2(cx)}" y2="${f2(cy)}" stroke-width="${f3(mOrPx(f, 0.4, 1.2))}" opacity="0.95"/>`;
  s += '</g>';
  s += `<g transform="rotate(${f2(deg(p.course))})"><polygon points="${f2(L + 1.4)},0 ${f2(L - ahW)},${f2(ahW * 0.62)} ${f2(L - ahW * 0.55)},0 ${f2(L - ahW)},${f2(-ahW * 0.62)}" fill="${CYAN}"/></g>`;
  // heading line (thin white) and slip arc between heading and course
  const hl = 7 * carScale(f);
  s += `<line x1="0" y1="0" x2="${f2(Math.cos(p.heading) * hl)}" y2="${f2(Math.sin(p.heading) * hl)}" stroke="${WHITE}" stroke-width="${f3(mOrPx(f, 0.18, 0.7))}" stroke-dasharray="0.6 0.5" opacity="0.6"/>`;
  if (Math.abs(p.beta) > 0.035 && f.mode !== 'overview') {
    const R = 5.6;
    const a0 = p.heading;
    const a1 = p.heading + wrapAngle(p.course - p.heading);
    const sweep = a1 > a0 ? 1 : 0; // sweep=1 → increasing angle in local (y-up) space, i.e. CCW on screen
    s += `<path d="M ${f2(Math.cos(a0) * R)},${f2(Math.sin(a0) * R)} A ${R},${R} 0 0 ${sweep} ${f2(Math.cos(a1) * R)},${f2(Math.sin(a1) * R)}" fill="none" stroke="${EMBER}" stroke-width="${f3(mOrPx(f, 0.45, 1.2))}" stroke-linecap="round" opacity="0.95"/>`;
  }
  // body
  const cs = carScale(f);
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
  s += `<path d="M 0.15,-0.78 L 0.95,-0.62 L 0.95,0.62 L 0.15,0.78 Z" fill="#6E7784"/>`; // windscreen
  s += `<path d="M -1.95,-0.75 L -1.45,-0.62 L -1.45,0.62 L -1.95,0.75 Z" fill="#8F98A4"/>`; // rear glass
  s += `<polygon points="-0.85,-0.5 0.05,0 -0.85,0.5 -0.55,0" fill="${BG}"/>`; // roof chevron → nose
  s += '</g>';
  return s + '</g>';
}

// ---------------------------------------------------------------- screen layers
function worldLabels(f: Frame): string {
  const r = f.replay;
  const top = TOP;
  let s = '<g>';
  const toS = (x: number, y: number) => {
    const p = worldToScreen(f.cam, x, y);
    return { x: p.x, y: p.y + top };
  };
  const overview = f.mode === 'overview';
  const carS = toS(f.pose.x, f.pose.y);
  for (const m of r.markers) {
    if (m.t > f.t || !inView(f, m.x, m.y)) continue;
    const p = toS(m.x, m.y);
    if (p.y < top + 8 || p.y > H - BOTTOM - 8 || p.x < 24 || p.x > W - 24) continue;
    // keep labels off the car and its readout
    if (!overview && Math.hypot(p.x - carS.x, p.y - carS.y) < 62) continue;
    switch (m.kind) {
      case 'transition':
        if (!overview) s += text(p.x + 12, p.y - 8, m.label, { size: 10, fill: MAGENTA, spacing: 1.5, weight: 700, stroke: BG, strokeW: 2.5 });
        break;
      case 'drift-peak':
        if (!overview || (m.peakAngle ?? 0) > 0.4) s += text(p.x + (overview ? 6 : 10), p.y + 4, m.label, { size: overview ? 11 : 13, fill: EMBER, weight: 800, stroke: BG, strokeW: 2.5 });
        break;
      case 'drift-end':
        if (!overview) s += text(p.x + 8, p.y + 14, m.label, { size: 11, fill: WHITE, weight: 700, opacity: 0.85, stroke: BG, strokeW: 2.5 });
        break;
      case 'lap':
        s += text(p.x + 10, p.y - 6, m.label, { size: overview ? 9 : 10, fill: GREY, spacing: 1.5, weight: 700, stroke: BG, strokeW: 2.5 });
        break;
      default:
        break;
    }
  }
  // slip-angle readout next to the arc
  const p = f.pose;
  if (Math.abs(p.beta) > 0.035 && !overview) {
    const mid = p.heading + 0.5 * wrapAngle(p.course - p.heading);
    const lp = toS(p.x + Math.cos(mid) * 8.2, p.y + Math.sin(mid) * 8.2);
    s += text(lp.x, lp.y + 5, `${Math.round(Math.abs(deg(p.beta)))}°`, { size: 15, fill: EMBER, weight: 800, anchor: 'middle', stroke: BG, strokeW: 3 });
  }
  // ghost label, or an edge indicator when the ghost is off screen (racing-game style)
  if (f.ghost && !overview) {
    const gp = toS(f.ghost.x, f.ghost.y);
    const gap = f.ghost.gapM;
    const gapS = gap / Math.max(3, f.pose.speed);
    const onScreen = gp.x >= 0 && gp.x <= W && gp.y >= top && gp.y <= H - BOTTOM;
    if (onScreen && Math.hypot(f.ghost.x - f.pose.x, f.ghost.y - f.pose.y) > 3) {
      const label = Math.abs(gap) < 1.5 ? 'GHOST' : `GHOST ${gap > 0 ? '+' : '−'}${Math.abs(gapS).toFixed(1)} s`;
      s += text(gp.x + 12, gp.y + 16, label, { size: 9, fill: CYAN, spacing: 1.5, opacity: 0.9, stroke: BG, strokeW: 2.5 });
    } else if (!onScreen) {
      // clamp the car→ghost ray to the world window (inset), draw a chevron pointing out
      const cs = toS(f.pose.x, f.pose.y);
      const dx = gp.x - cs.x;
      const dy = gp.y - cs.y;
      const inset = 26;
      let k = Infinity;
      if (dx > 0) k = Math.min(k, (W - inset - cs.x) / dx);
      if (dx < 0) k = Math.min(k, (inset - cs.x) / dx);
      if (dy > 0) k = Math.min(k, (H - BOTTOM - inset - cs.y) / dy);
      if (dy < 0) k = Math.min(k, (top + inset - cs.y) / dy);
      if (Number.isFinite(k) && k > 0) {
        const ex = cs.x + dx * k;
        const ey = cs.y + dy * k;
        const ang = (Math.atan2(dy, dx) * 180) / Math.PI;
        s += `<g transform="translate(${f2(ex)} ${f2(ey)})">`;
        s += `<circle r="13" fill="${PANEL}" fill-opacity="0.85" stroke="${CYAN}" stroke-width="1.2" opacity="0.9"/>`;
        s += `<g transform="rotate(${f2(ang)})"><polygon points="4,-6 11,0 4,6 6,0" fill="${CYAN}"/><path d="M -5,-4 L -1,0 L -5,4" fill="none" stroke="${CYAN}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" opacity="0.6"/></g>`;
        s += '</g>';
        // label placed toward the window centre
        const lx = ex + (ex < W / 2 ? 20 : -20);
        const anchor = ex < W / 2 ? 'start' : 'end';
        const gapLabel = `${gap > 0 ? '+' : '−'}${Math.abs(gapS).toFixed(1)} s`;
        s += text(lx, ey - 2, 'GHOST', { size: 9, fill: CYAN, spacing: 1.5, anchor, stroke: BG, strokeW: 2.5 });
        s += text(lx, ey + 10, gapLabel, { size: 11, fill: WHITE, weight: 800, anchor, stroke: BG, strokeW: 2.5 });
      }
    }
  }
  return s + '</g>';
}

function callout(f: Frame): string {
  // NFS-style style flash: the most recent noteworthy marker within 1.6 s
  let best: { label: string; color: string; age: number } | null = null;
  for (const m of f.replay.markers) {
    const age = f.t - m.t;
    if (age < 0 || age > 1.6) continue;
    let label: string | null = null;
    let color = MAGENTA;
    if (m.kind === 'transition') label = m.label;
    else if (m.kind === 'drift-end') {
      label = m.label;
      color = EMBER;
    } else if (m.kind === 'drift-peak' && (m.peakAngle ?? 0) > 0.6) {
      label = `${m.label} PEAK`;
      color = EMBER;
    } else if (m.kind === 'lap' && m.label !== 'LAP 1') {
      label = m.label;
      color = CYAN;
    }
    if (label && (!best || age < best.age)) best = { label, color, age };
  }
  if (!best) return '';
  const k = best.age / 1.6;
  const op = k < 0.04 ? k / 0.04 : 1 - Math.pow((k - 0.04) / 0.96, 2);
  const size = 40 + 10 * Math.min(1, best.age / 0.25);
  const y = TOP + 120 - 12 * k;
  return `<g opacity="${f3(clamp(op, 0, 1))}">${glowText(W / 2, y, best.label, size, WHITE, best.color, 0.9, 'middle', 900)}</g>`;
}

function topHud(f: Frame): string {
  const r = f.replay;
  const p = f.pose;
  let s = `<rect x="0" y="0" width="${W}" height="${TOP}" fill="#000"/>`;
  s += `<rect x="0" y="${TOP - 1}" width="${W}" height="1" fill="${LINE}"/>`;
  // row 1
  s += `<circle cx="22" cy="21" r="3.2" fill="#FF3B30"/>`;
  s += text(30, 25, 'REPLAY', { size: 11, spacing: 2.5, fill: WHITE, weight: 700 });
  s += text(W / 2, 25, fmtTime(f.t) + '  /  ' + fmtTime(r.durationS), { size: 9.5, family: MONO, fill: GREY, anchor: 'middle', weight: 700, spacing: 0.5 });
  const modeLabel = f.mode === 'overview' ? 'TRACK CAM' : f.mode === 'chase' ? 'CHASE CAM' : 'CINEMATIC';
  s += text(W - 16, 25, modeLabel, { size: 9.5, spacing: 2, fill: CYAN, anchor: 'end', weight: 700 });
  // row 2: big numbers
  const drifting = p.phase === 'drifting';
  const angle = Math.round(Math.abs(deg(p.beta)));
  const side = Math.abs(p.beta) > 0.035 ? (p.beta > 0 ? 'R' : 'L') : '';
  const baseline = 86;
  // angle
  if (drifting || angle >= 5) s += glowText(74, baseline, `${angle}°`, 50, WHITE, EMBER, 0.35 + 0.65 * p.intensity, 'middle');
  else s += text(74, baseline, `${angle}°`, { size: 50, fill: GREY, anchor: 'middle', weight: 800 });
  if (side) s += text(74 + 40, baseline - 30, side, { size: 13, fill: EMBER, anchor: 'start', weight: 800 });
  s += text(74, 103, 'SLIP ANGLE', { size: 8.5, spacing: 2, fill: GREY, anchor: 'middle', weight: 700 });
  // speed
  s += text(195, baseline, `${kmh(p.speed)}`, { size: 50, fill: WHITE, anchor: 'middle', weight: 800 });
  s += text(195, 103, 'KM/H', { size: 8.5, spacing: 2, fill: GREY, anchor: 'middle', weight: 700 });
  // points
  s += glowText(316, baseline, fmtPts(p.points), 44, WHITE, drifting ? EMBER : '#3A4656', drifting ? 0.5 : 0.35, 'middle');
  s += text(316, 103, 'POINTS', { size: 8.5, spacing: 2, fill: GREY, anchor: 'middle', weight: 700 });
  // thin dividers
  s += `<g stroke="${LINE}" stroke-width="1"><line x1="136" y1="52" x2="136" y2="100"/><line x1="256" y1="52" x2="256" y2="100"/></g>`;
  return s;
}

function bottomHud(f: Frame): string {
  const r = f.replay;
  const tel = r.telemetry;
  const y0 = H - BOTTOM;
  let s = `<rect x="0" y="${y0}" width="${W}" height="${BOTTOM}" fill="#000"/>`;
  s += `<rect x="0" y="${y0}" width="${W}" height="1" fill="${LINE}"/>`;
  const px = 16;
  const py = y0 + 14;
  const pw = W - 32;
  const ph = 84;
  s += `<rect x="${px}" y="${py}" width="${pw}" height="${ph}" rx="5" fill="${PANEL}" stroke="${LINE}" stroke-width="1"/>`;
  const xAt = (t: number) => px + (t / r.durationS) * pw;
  // drift shading
  for (const seg of r.segments) {
    s += `<rect x="${f2(xAt(seg.startT))}" y="${py + 1}" width="${f2(Math.max(0.5, xAt(seg.endT) - xAt(seg.startT)))}" height="${ph - 2}" fill="${EMBER}" opacity="0.10"/>`;
  }
  // elapsed shade
  s += `<rect x="${px}" y="${py}" width="${f2(xAt(f.t) - px)}" height="${ph}" rx="5" fill="${WHITE}" opacity="0.035"/>`;
  // traces
  const angleScale = Math.max(50, deg(tel.maxAngle) * 1.05);
  const speedScale = Math.max(1, tel.maxSpeed * 1.08);
  const ptsScale = Math.max(1, tel.maxPoints);
  const yAngle = (a: number) => py + ph - 3 - (deg(a) / angleScale) * (ph - 8);
  const ySpeed = (v: number) => py + ph - 3 - (v / speedScale) * (ph - 8);
  const yPts = (p: number) => py + ph - 3 - (p / ptsScale) * (ph - 8);
  const step = Math.max(1, Math.floor(tel.n / (pw * 1.5)));
  let area = `${f2(xAt(0))},${f2(py + ph - 3)} `;
  let angleLine = '';
  let speedLine = '';
  let ptsLine = '';
  for (let i = 0; i < tel.n; i += step) {
    const x = xAt(tel.t[i]);
    area += `${f2(x)},${f2(yAngle(tel.angle[i]))} `;
    angleLine += `${f2(x)},${f2(yAngle(tel.angle[i]))} `;
    speedLine += `${f2(x)},${f2(ySpeed(tel.speed[i]))} `;
    ptsLine += `${f2(x)},${f2(yPts(tel.points[i]))} `;
  }
  area += `${f2(xAt(tel.t[tel.n - 1]))},${f2(py + ph - 3)}`;
  s += `<polygon points="${area}" fill="${EMBER}" opacity="0.28"/>`;
  s += `<polyline points="${angleLine.trim()}" fill="none" stroke="${EMBER}" stroke-width="1.1" stroke-linejoin="round"/>`;
  s += `<polyline points="${speedLine.trim()}" fill="none" stroke="${CYAN}" stroke-width="1" stroke-linejoin="round" opacity="0.9"/>`;
  s += `<polyline points="${ptsLine.trim()}" fill="none" stroke="${WHITE}" stroke-width="0.9" stroke-linejoin="round" opacity="0.4"/>`;
  // lap ticks
  for (const lap of r.laps) {
    if (lap.index === 0) continue;
    const x = xAt(lap.startT);
    s += `<line x1="${f2(x)}" y1="${py + 1}" x2="${f2(x)}" y2="${py + ph - 1}" stroke="${GREY}" stroke-width="0.8" stroke-dasharray="2 2" opacity="0.7"/>`;
    s += text(x + 3, py + 10, `L${lap.index + 1}`, { size: 8, fill: GREY, spacing: 1, weight: 700 });
  }
  // transitions
  for (const m of r.markers) {
    if (m.kind !== 'transition') continue;
    const x = xAt(m.t);
    s += `<polygon points="${f2(x)},${py + 3} ${f2(x + 3)},${py + 8} ${f2(x)},${py + 13} ${f2(x - 3)},${py + 8}" fill="${MAGENTA}" opacity="0.9"/>`;
  }
  // playhead
  const xp = xAt(f.t);
  s += `<line x1="${f2(xp)}" y1="${py - 4}" x2="${f2(xp)}" y2="${py + ph + 4}" stroke="${WHITE}" stroke-width="1.4"/>`;
  s += `<polygon points="${f2(xp - 4)},${py - 8} ${f2(xp + 4)},${py - 8} ${f2(xp)},${py - 2}" fill="${WHITE}"/>`;
  s += `<circle cx="${f2(xp)}" cy="${f2(yAngle(Math.abs(f.pose.beta)))}" r="2.6" fill="${EMBER}" stroke="${BG}" stroke-width="1"/>`;
  s += `<circle cx="${f2(xp)}" cy="${f2(ySpeed(f.pose.speed))}" r="2.2" fill="${CYAN}" stroke="${BG}" stroke-width="1"/>`;
  // legend row
  const ly = py + ph + 20;
  s += `<rect x="${px}" y="${ly - 7}" width="10" height="3" fill="${EMBER}"/>`;
  s += text(px + 14, ly, 'ANGLE', { size: 8.5, spacing: 1.5, fill: GREY });
  s += `<rect x="${px + 56}" y="${ly - 7}" width="10" height="3" fill="${CYAN}"/>`;
  s += text(px + 70, ly, 'SPEED', { size: 8.5, spacing: 1.5, fill: GREY });
  s += `<rect x="${px + 112}" y="${ly - 7}" width="10" height="3" fill="${WHITE}" opacity="0.5"/>`;
  s += text(px + 126, ly, 'POINTS', { size: 8.5, spacing: 1.5, fill: GREY });
  const lap = lapAt(r, f.t);
  const lapStr = r.laps.length > 0 ? `LAP ${lap ? lap.index + 1 : '–'}/${r.laps.length}` : 'POINT TO POINT';
  const peakStr = `BEST ${Math.round(deg(r.info.peakAngle))}°`;
  s += text(W - 16, ly, `${lapStr}   ·   ${r.info.driftCount} DRIFTS   ·   ${peakStr}`, { size: 8.5, spacing: 1.2, fill: GREY, anchor: 'end' });
  // total + grade badge
  const gy = ly + 20;
  s += text(px, gy, `TOTAL ${fmtPts(r.info.totalPoints)}`, { size: 11, spacing: 1.5, fill: WHITE, weight: 800 });
  s += `<rect x="${W - 16 - 26}" y="${gy - 13}" width="26" height="17" rx="3" fill="${EMBER}"/>`;
  s += text(W - 16 - 13, gy, r.info.grade, { size: 13, fill: '#000', anchor: 'middle', weight: 900 });
  s += text(W - 16 - 32, gy, 'GRADE', { size: 8.5, spacing: 2, fill: GREY, anchor: 'end' });
  return s;
}

function minimap(f: Frame): string {
  if (f.mode === 'overview') return '';
  const r = f.replay;
  const size = 74;
  const x0 = W - 16 - size;
  const y0 = TOP + 14;
  const b = r.bounds;
  const ex = b.maxX - b.minX;
  const ey = b.maxY - b.minY;
  const sc = (size - 12) / Math.max(ex, ey);
  const mx = (x: number) => x0 + size / 2 + (x - (b.minX + b.maxX) / 2) * sc;
  const my = (y: number) => y0 + size / 2 - (y - (b.minY + b.maxY) / 2) * sc;
  let s = `<g><rect x="${x0}" y="${y0}" width="${size}" height="${size}" rx="8" fill="${PANEL}" fill-opacity="0.85" stroke="${LINE}" stroke-width="1"/>`;
  const pts: Array<[number, number]> = [];
  if (r.track) for (let i = 0; i < r.track.path.length; i += 2) pts.push([mx(r.track.path[i].x), my(r.track.path[i].y)]);
  else for (let i = 0; i < r.trail.n; i += 8) pts.push([mx(r.trail.x[i]), my(r.trail.y[i])]);
  const tag = r.track?.closed ? 'polygon' : 'polyline';
  s += `<${tag} points="${pointsAttr(pts)}" fill="none" stroke="#3A4656" stroke-width="2.2" stroke-linejoin="round"/>`;
  // driven drift portions
  const cur = Math.min(r.trail.n - 1, Math.floor(f.t * r.trail.hz));
  for (const seg of r.segments) {
    if (seg.startIndex > cur) continue;
    const end = Math.min(seg.endIndex, cur);
    const sp: Array<[number, number]> = [];
    for (let i = seg.startIndex; i <= end; i += 3) sp.push([mx(r.trail.x[i]), my(r.trail.y[i])]);
    if (sp.length > 1) s += `<polyline points="${pointsAttr(sp)}" fill="none" stroke="${EMBER}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" opacity="0.9"/>`;
  }
  if (f.ghost) s += `<circle cx="${f2(mx(f.ghost.x))}" cy="${f2(my(f.ghost.y))}" r="2" fill="none" stroke="${CYAN}" stroke-width="1"/>`;
  s += `<circle cx="${f2(mx(f.pose.x))}" cy="${f2(my(f.pose.y))}" r="3" fill="${WHITE}" stroke="${BG}" stroke-width="1"/>`;
  s += `<circle cx="${f2(mx(f.pose.x))}" cy="${f2(my(f.pose.y))}" r="5.5" fill="none" stroke="${WHITE}" stroke-width="0.8" opacity="0.5"/>`;
  return s + '</g>';
}

// ---------------------------------------------------------------- frame assembly
function renderFrame(f: Frame): string {
  const cam = f.cam;
  const rotDeg = deg(cam.rotation);
  const worldTransform = `translate(${f2(cam.w / 2)} ${f2(TOP + cam.h / 2)}) scale(${f3(cam.zoom)} ${f3(-cam.zoom)}) rotate(${f3(rotDeg)}) translate(${f2(-cam.cx)} ${f2(-cam.cy)})`;
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1170" height="2532" viewBox="0 0 ${W} ${H}">`;
  svg += '<defs>';
  svg += `<radialGradient id="smoke" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#D5DAE2" stop-opacity="0.85"/><stop offset="0.45" stop-color="#B8BFC9" stop-opacity="0.45"/><stop offset="1" stop-color="#9AA2AE" stop-opacity="0"/></radialGradient>`;
  svg += `<radialGradient id="smokeCore" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#F1F3F6" stop-opacity="0.9"/><stop offset="1" stop-color="#D5DAE2" stop-opacity="0"/></radialGradient>`;
  svg += `<radialGradient id="underglow" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="${EMBER}" stop-opacity="0.9"/><stop offset="0.5" stop-color="${EMBER}" stop-opacity="0.35"/><stop offset="1" stop-color="${EMBER}" stop-opacity="0"/></radialGradient>`;
  svg += `<radialGradient id="vignette" gradientUnits="userSpaceOnUse" cx="${W / 2}" cy="${TOP + WORLD_H / 2}" r="${Math.hypot(W / 2, WORLD_H / 2) * 1.05}"><stop offset="0.35" stop-color="#000" stop-opacity="0"/><stop offset="0.75" stop-color="#000" stop-opacity="0.35"/><stop offset="1" stop-color="#000" stop-opacity="0.85"/></radialGradient>`;
  svg += `<pattern id="scan" width="3" height="3" patternUnits="userSpaceOnUse"><rect width="3" height="1" fill="#000"/></pattern>`;
  svg += `<filter id="blur" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="1.2"/></filter>`;
  svg += `<clipPath id="worldClip"><rect x="0" y="${TOP}" width="${W}" height="${WORLD_H}"/></clipPath>`;
  svg += '</defs>';
  svg += `<rect width="${W}" height="${H}" fill="${BG}"/>`;
  // world
  svg += `<g clip-path="url(#worldClip)">`;
  svg += `<g transform="${worldTransform}">`;
  svg += drawGrid(f);
  svg += drawRoad(f);
  svg += drawTrail(f);
  svg += drawMarkers(f);
  svg += drawSmoke(f);
  svg += drawCar(f);
  svg += drawGhost(f); // above the car: when the laps match, the ghost reads as a cyan outline over it
  svg += '</g>';
  // screen-space overlays inside the world window
  svg += worldLabels(f);
  svg += `<rect x="0" y="${TOP}" width="${W}" height="${WORLD_H}" fill="url(#vignette)"/>`;
  svg += `<rect x="0" y="${TOP}" width="${W}" height="${WORLD_H}" fill="url(#scan)" opacity="0.10"/>`;
  svg += minimap(f);
  svg += callout(f);
  svg += '</g>';
  svg += topHud(f);
  svg += bottomHud(f);
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
    return tr ? tr.t + 0.15 : replay.durationS / 2;
  }
  if (spec === 'peak') return segs[0]?.peakT ?? replay.durationS / 2;
  if (spec === 'mid') return replay.durationS / 2;
  if (spec === 'end') return replay.durationS;
  if (spec === 'start') return 0;
  if (spec === 'ghost') {
    // a drifting moment on a non-best lap where the ghost is 8..35 m away (on screen at chase zoom)
    let best: { t: number; score: number } | null = null;
    for (const lap of replay.laps) {
      if (lap.best) continue;
      for (let t = lap.startT + 1; t < lap.endT; t += 0.1) {
        const g = ghostPoseAt(replay, t);
        const p = poseAt(replay, t);
        if (!g || p.phase !== 'drifting') continue;
        const d = Math.hypot(g.x - p.x, g.y - p.y);
        if (d < 8 || d > 35) continue;
        const score = p.intensity + Math.min(d, 25) / 50;
        if (!best || score > best.score) best = { t, score };
      }
    }
    if (best) return best.t;
    // otherwise the drifting moment where the ghost is closest (it shows as an edge indicator)
    let closest: { t: number; d: number } | null = null;
    for (const lap of replay.laps) {
      if (lap.best) continue;
      for (let t = lap.startT + 1; t < lap.endT; t += 0.1) {
        const g = ghostPoseAt(replay, t);
        const p = poseAt(replay, t);
        if (!g || p.intensity < 0.3) continue;
        const d = Math.hypot(g.x - p.x, g.y - p.y);
        if (!closest || d < closest.d) closest = { t, d };
      }
    }
    return closest ? closest.t : resolveTime(replay, 'lap2');
  }
  if (spec === 'lap2' || spec === 'lap2-peak') {
    const lap = replay.laps[1];
    if (!lap) return replay.durationS / 2;
    const inLap = segs.filter((s) => s.peakT >= lap.startT && s.peakT <= lap.endT);
    if (spec === 'lap2-peak') return inLap[0]?.peakT ?? lap.startT + lap.durationS / 2;
    // the longest drift of lap 2, one third in (so the ghost has had time to separate)
    const longest = [...inLap].sort((a, b) => b.durationS - a.durationS)[0];
    return longest ? longest.startT + longest.durationS * 0.35 : lap.startT + lap.durationS / 2;
  }
  throw new Error(`unknown time spec "${spec}"`);
}

export function renderReplayFrame(track: TrackId, seed: number, timeSpec: string, mode: CameraMode, simOpts: { laps?: number; consistency?: number; aggression?: number } = {}): { svg: string; t: number; replay: Replay } {
  const run = simulateRun(track, { seed, laps: simOpts.laps ?? 2, consistency: simOpts.consistency, aggression: simOpts.aggression });
  const session = sessionFromSimulation(run);
  const replay = buildReplay(session);
  const t = resolveTime(replay, timeSpec);
  const cam = new ReplayCamera(mode, { w: W, h: WORLD_H });
  // the camera is stateful: run it from the start at 60 fps up to t
  const dt = 1 / FPS;
  let state = cam.update(replay, 0, dt);
  for (let tt = dt; tt <= t + 1e-9; tt += dt) state = cam.update(replay, tt, dt);
  if (t > 0) state = cam.update(replay, t, Math.max(1e-3, t - Math.floor(t * FPS) / FPS));
  const corners = [screenToWorld(state, 0, 0), screenToWorld(state, W, 0), screenToWorld(state, 0, WORLD_H), screenToWorld(state, W, WORLD_H)];
  const margin = 25;
  const vis = {
    minX: Math.min(...corners.map((c) => c.x)) - margin,
    maxX: Math.max(...corners.map((c) => c.x)) + margin,
    minY: Math.min(...corners.map((c) => c.y)) - margin,
    maxY: Math.max(...corners.map((c) => c.y)) + margin,
  };
  const frame: Frame = { replay, t, mode, cam: state, pose: poseAt(replay, t), ghost: ghostPoseAt(replay, t), vis, track, seed };
  return { svg: renderFrame(frame), t, replay };
}

function main(): void {
  const args = process.argv.slice(2);
  const flags: Record<string, string> = {};
  const pos: string[] = [];
  for (const a of args) {
    const m = /^--([\w-]+)=(.*)$/.exec(a);
    if (m) flags[m[1]] = m[2];
    else pos.push(a);
  }
  const [track = 'harbor', seedS = '1', timeSpec = 'mid', modeS = 'chase', out = 'artifacts/replay.svg'] = pos;
  const mode = modeS as CameraMode;
  if (!['overview', 'chase', 'cinematic'].includes(mode)) throw new Error(`mode must be overview|chase|cinematic, got ${modeS}`);
  const { svg, t, replay } = renderReplayFrame(track as TrackId, Number(seedS), timeSpec, mode, {
    laps: flags.laps ? Number(flags.laps) : undefined,
    consistency: flags.consistency ? Number(flags.consistency) : undefined,
    aggression: flags.aggression ? Number(flags.aggression) : undefined,
  });
  writeFileSync(out, svg);
  const p = poseAt(replay, t);
  process.stderr.write(`wrote ${out}  t=${t.toFixed(2)}s mode=${mode} phase=${p.phase} beta=${deg(p.beta).toFixed(1)}° speed=${kmh(p.speed)} km/h points=${Math.round(p.points)} smoke=${liveSmoke(replay.smoke, t).length} ghost=${replay.ghost ? 'lap ' + (replay.ghost.lapIndex + 1) : 'none'}\n`);
}

const isMain = process.argv[1] && /render-replay\.ts$/.test(process.argv[1]);
if (isMain) main();
