/**
 * Pure 2-D polyline geometry for the track model. Everything is in local ENU metres.
 * No state, no side effects; used by the builder, the corner finder and the tests.
 */
import { wrapAngle } from '../types';

export interface Pt {
  x: number;
  y: number;
}

export interface RefPoint {
  x: number;
  y: number;
  /** Arc length from the start of the path, metres. */
  s: number;
}

/** Sum of segment lengths; adds the closing segment when `closed`. */
export function polylineLength(pts: readonly Pt[], closed: boolean): number {
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  if (closed && pts.length > 1) {
    const a = pts[pts.length - 1];
    len += Math.hypot(pts[0].x - a.x, pts[0].y - a.y);
  }
  return len;
}

/**
 * Loop closure: the recorded first lap starts at the start point and ends at the gate crossing,
 * which is laterally offset by the estimator's drift plus the driver's line. Spread that closure
 * error linearly along the arc length so the last point lands exactly on the first one, then drop
 * the (now duplicate) last point. The per-metre distortion is `error / lapLength` — negligible.
 */
export function closeLoop(pts: readonly Pt[]): Pt[] {
  const n = pts.length;
  if (n < 3) return pts.map((p) => ({ x: p.x, y: p.y }));
  const dx = pts[n - 1].x - pts[0].x;
  const dy = pts[n - 1].y - pts[0].y;
  const cum = new Float64Array(n);
  for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  const total = cum[n - 1] > 1e-9 ? cum[n - 1] : 1;
  const out: Pt[] = new Array(n - 1);
  for (let i = 0; i < n - 1; i++) {
    const f = cum[i] / total;
    out[i] = { x: pts[i].x - dx * f, y: pts[i].y - dy * f };
  }
  return out;
}

/**
 * Resample a polyline at (almost exactly) `stepM` spacing: the path is divided into
 * N = round(L / stepM) equal segments so a closed ring closes perfectly and an open path
 * ends exactly on its last point. Returns N points for a closed path, N + 1 for an open one.
 */
export function resamplePolyline(pts: readonly Pt[], stepM: number, closed: boolean): RefPoint[] {
  const n = pts.length;
  if (n === 0) return [];
  if (n === 1) return [{ x: pts[0].x, y: pts[0].y, s: 0 }];
  const total = polylineLength(pts, closed);
  if (total < 1e-6) return [{ x: pts[0].x, y: pts[0].y, s: 0 }];
  const nSeg = Math.max(closed ? 3 : 1, Math.round(total / stepM));
  const h = total / nSeg;
  const nOut = closed ? nSeg : nSeg + 1;
  const segCount = closed ? n : n - 1;
  const segLen = (k: number): number => {
    const a = pts[k];
    const b = pts[(k + 1) % n];
    return Math.hypot(b.x - a.x, b.y - a.y);
  };
  const out: RefPoint[] = new Array(nOut);
  let seg = 0;
  let segStart = 0;
  let curLen = segLen(0);
  for (let i = 0; i < nOut; i++) {
    const s = Math.min(i * h, total);
    while (seg < segCount - 1 && segStart + curLen < s) {
      segStart += curLen;
      seg++;
      curLen = segLen(seg);
    }
    const a = pts[seg];
    const b = pts[(seg + 1) % n];
    let f = curLen > 1e-9 ? (s - segStart) / curLen : 0;
    if (f < 0) f = 0;
    else if (f > 1) f = 1;
    out[i] = { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, s };
  }
  return out;
}

/**
 * Signed curvature κ (1/m, + = left / CCW) along a uniformly resampled path.
 * Tangent angles come from central differences, are smoothed by unit-vector averaging over
 * ±windowM/2, differentiated, and the curvature is box-smoothed over ±windowM/2 again
 * (the same two-stage scheme the simulator uses for its ground truth).
 */
export function curvatureProfile(ref: readonly RefPoint[], closed: boolean, windowM: number): Float64Array {
  const n = ref.length;
  const kappa = new Float64Array(n);
  if (n < 3) return kappa;
  const h = closed ? ref[1].s - ref[0].s : (ref[n - 1].s - ref[0].s) / (n - 1);
  if (!(h > 0)) return kappa;
  const idx = closed ? (i: number): number => ((i % n) + n) % n : (i: number): number => (i < 0 ? 0 : i >= n ? n - 1 : i);
  const half = Math.max(1, Math.round(windowM / (2 * h) + 1e-6));

  const chiRaw = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = ref[idx(i - 1)];
    const b = ref[idx(i + 1)];
    chiRaw[i] = Math.atan2(b.y - a.y, b.x - a.x);
  }
  const chi = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let cx = 0;
    let cy = 0;
    for (let k = -half; k <= half; k++) {
      const j = i + k;
      if (!closed && (j < 0 || j >= n)) continue;
      const jj = idx(j);
      cx += Math.cos(chiRaw[jj]);
      cy += Math.sin(chiRaw[jj]);
    }
    chi[i] = Math.atan2(cy, cx);
  }
  const kRaw = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const ia = idx(i - 1);
    const ib = idx(i + 1);
    const span = closed ? 2 * h : (ib - ia) * h;
    kRaw[i] = span > 0 ? wrapAngle(chi[ib] - chi[ia]) / span : 0;
  }
  for (let i = 0; i < n; i++) {
    let acc = 0;
    let cnt = 0;
    for (let k = -half; k <= half; k++) {
      const j = i + k;
      if (!closed && (j < 0 || j >= n)) continue;
      acc += kRaw[idx(j)];
      cnt++;
    }
    kappa[i] = cnt > 0 ? acc / cnt : 0;
  }
  return kappa;
}

/**
 * Proper intersection of segment p→q with segment a→b.
 * Returns the parameter t along p→q (0..1) of the crossing, or -1 when they do not intersect.
 */
export function segmentIntersection(
  px: number,
  py: number,
  qx: number,
  qy: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const rx = qx - px;
  const ry = qy - py;
  const sx = bx - ax;
  const sy = by - ay;
  const denom = rx * sy - ry * sx;
  if (Math.abs(denom) < 1e-12) return -1;
  const wx = ax - px;
  const wy = ay - py;
  const t = (wx * sy - wy * sx) / denom;
  const u = (wx * ry - wy * rx) / denom;
  if (t < 0 || t > 1 || u < 0 || u > 1) return -1;
  return t;
}

/** Smallest absolute difference between two angles, radians, 0..π. */
export function angleDiff(a: number, b: number): number {
  return Math.abs(wrapAngle(a - b));
}

/** Map a difference of arc lengths on a ring of length L into (-L/2, L/2]. */
export function wrapS(ds: number, lengthM: number): number {
  if (!(lengthM > 0)) return ds;
  let r = ds % lengthM;
  if (r > lengthM / 2) r -= lengthM;
  else if (r <= -lengthM / 2) r += lengthM;
  return r;
}

/** Normalise an arc length onto [0, L). */
export function modS(s: number, lengthM: number): number {
  if (!(lengthM > 0)) return s;
  const r = s % lengthM;
  return r < 0 ? r + lengthM : r;
}

/**
 * Gaussian smoothing of a polyline's vertex positions (σ in metres, kernel truncated at ±3σ),
 * assuming roughly uniform spacing. On an open path the kernel is renormalised at the ends.
 * Used before curvature estimation: it rejects the short-wavelength wobble the estimator noise
 * leaves behind while keeping features of a corner's length (≥ 12 m) intact.
 */
export function smoothPolyline(pts: readonly RefPoint[], sigmaM: number, closed: boolean): RefPoint[] {
  const n = pts.length;
  if (n < 3 || !(sigmaM > 0)) return pts.map((p) => ({ x: p.x, y: p.y, s: p.s }));
  const h = closed ? pts[1].s - pts[0].s : (pts[n - 1].s - pts[0].s) / (n - 1);
  if (!(h > 0)) return pts.map((p) => ({ x: p.x, y: p.y, s: p.s }));
  const half = Math.min(Math.ceil((3 * sigmaM) / h), closed ? Math.floor((n - 1) / 2) : n - 1);
  const w = new Float64Array(2 * half + 1);
  for (let k = -half; k <= half; k++) w[k + half] = Math.exp(-((k * h) * (k * h)) / (2 * sigmaM * sigmaM));
  const out: RefPoint[] = new Array(n);
  for (let i = 0; i < n; i++) {
    let sx = 0;
    let sy = 0;
    let sw = 0;
    for (let k = -half; k <= half; k++) {
      let j = i + k;
      if (closed) j = ((j % n) + n) % n;
      else if (j < 0 || j >= n) continue;
      const wk = w[k + half];
      sx += pts[j].x * wk;
      sy += pts[j].y * wk;
      sw += wk;
    }
    out[i] = { x: sx / sw, y: sy / sw, s: pts[i].s };
  }
  return out;
}
