/**
 * Kerb contours: the red-and-white stripe on the inside of a corner.
 *
 * Pure geometry, deliberately kept out of `geometry.ts` so it can be tested on Linux without a
 * Skia canvas — see `replay-ui.test.ts`.
 *
 * WHY THIS IS NOT A ONE-LINE OFFSET. A kerb is the centre line pushed sideways by half the road,
 * and a naive vertex-by-vertex offset FOLDS wherever the offset distance approaches the local
 * radius of curvature: the outside of the fold overtakes the inside, the contour crosses itself,
 * and a stroked bow-tie renders as a translucent wedge lying diagonally across the asphalt. That
 * is exactly what shipped — a red triangle roughly a third of the screen wide, mid-frame, on the
 * screen whose entire job is to look like a film. Measured on the two fixtures that draw it:
 * 6 self-intersections across 4 corners of the `handheld` track and 7 across 3 of `rough`, with
 * offset steps of up to 8.5 m between centre-line points 2 m apart.
 *
 * So the offset is clamped per vertex to a fraction of the LOCAL radius of curvature (not the
 * corner's mean radius, which on an estimated path is far smoother than the path itself), and any
 * edge that still comes out reversed breaks the contour instead of folding it.
 */

export type Pt = [number, number];

export interface KerbCorner {
  x: number;
  y: number;
  /** +1 left-hander (kerb on the left of the direction of travel), −1 right-hander. */
  direction: 1 | -1;
  radiusM: number;
}

export interface KerbOptions {
  /** Lateral offset from the centre line, metres (positive; the direction supplies the sign). */
  offsetM: number;
  /** Half-length of a kerb along the road, metres: `clamp(radius × 0.9, minSpanM, maxSpanM)`. */
  minSpanM: number;
  maxSpanM: number;
  /** Spacing of the sampled centre-line points, metres. */
  stepM: number;
  /**
   * The offset may never exceed this fraction of the local radius of curvature when it points
   * at the centre of that curvature. At 1.0 the offset contour collapses to a point; 0.55 keeps
   * the kerb comfortably inside the arc it belongs to.
   */
  maxCurvatureFrac: number;
}

export const KERB_OPTIONS: KerbOptions = {
  offsetM: 5.3,
  minSpanM: 8,
  maxSpanM: 40,
  stepM: 2,
  maxCurvatureFrac: 0.55,
};

const len = (dx: number, dy: number): number => Math.hypot(dx, dy);

/**
 * A [1 2 1] pass, endpoints held. The centre line of a PIPELINE session is the estimator's
 * path, which wanders by tens of centimetres sample to sample; a normal taken off two adjacent
 * points of it swings by tens of degrees, and 5 m of offset turns that into metres of scatter.
 * A kerb is a painted stripe, not a measurement, so it is drawn off a smoothed line.
 */
export function smoothPolyline(pts: Pt[], passes = 2): Pt[] {
  let out = pts.map((p) => [p[0], p[1]] as Pt);
  for (let k = 0; k < passes; k++) {
    const next = out.map((p) => [p[0], p[1]] as Pt);
    for (let i = 1; i < out.length - 1; i++) {
      next[i] = [0.25 * out[i - 1][0] + 0.5 * out[i][0] + 0.25 * out[i + 1][0], 0.25 * out[i - 1][1] + 0.5 * out[i][1] + 0.25 * out[i + 1][1]];
    }
    out = next;
  }
  return out;
}

/** Signed radius of curvature at `b` from the triple a-b-c. +∞ on a straight. */
export function curvatureRadius(a: Pt, b: Pt, c: Pt): { radius: number; side: 1 | -1 | 0 } {
  const ux = b[0] - a[0];
  const uy = b[1] - a[1];
  const vx = c[0] - b[0];
  const vy = c[1] - b[1];
  const lu = len(ux, uy);
  const lv = len(vx, vy);
  if (lu < 1e-9 || lv < 1e-9) return { radius: Infinity, side: 0 };
  const cross = (ux * vy - uy * vx) / (lu * lv);
  const dot = (ux * vx + uy * vy) / (lu * lv);
  const turn = Math.atan2(cross, dot);
  if (Math.abs(turn) < 1e-9) return { radius: Infinity, side: 0 };
  // the arc through the triple: radius = chord length / turn angle
  const radius = (0.5 * (lu + lv)) / Math.abs(turn);
  return { radius, side: turn > 0 ? 1 : -1 };
}

/**
 * Offset a polyline by `d` (left of travel when positive), clamping the offset at every vertex so
 * it can never reach the centre of curvature, and BREAKING the contour wherever an edge still
 * comes out reversed. Returns the runs that survived, longest first is not guaranteed — order
 * follows the input.
 */
export function offsetRuns(raw: Pt[], d: number, maxCurvatureFrac = KERB_OPTIONS.maxCurvatureFrac): Pt[][] {
  const pts = smoothPolyline(raw);
  const n = pts.length;
  if (n < 3) return [];
  // the tangent (and the curvature) are taken over a ±2-sample baseline, which is ±4 m of road:
  // long enough that estimator noise cannot swing the normal, short enough to follow a hairpin
  const near = (i: number, k: number) => pts[Math.max(0, Math.min(n - 1, i + k))];
  // The first and last two vertices have no full baseline, so their curvature is taken from the
  // nearest vertex that has one. Left unclamped, the ENDS of a kerb are exactly where the offset
  // folds first — a hairpin's entry and exit are the tightest part of it.
  const clampIndex = (i: number) => Math.max(2, Math.min(n - 3, i));
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const a = near(i, -2);
    const b = near(i, 2);
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const l = len(dx, dy);
    if (l < 1e-9) {
      out.push([pts[i][0], pts[i][1]]);
      continue;
    }
    let di = d;
    const c = clampIndex(i);
    const { radius, side } = curvatureRadius(near(c, -2), pts[c], near(c, 2));
    // `side` +1 means the path turns left here, so its centre of curvature is to the LEFT,
    // which is where a positive offset points. Only that case can fold.
    if (side !== 0 && Math.sign(d) === side) di = Math.sign(d) * Math.min(Math.abs(d), maxCurvatureFrac * radius);
    out.push([pts[i][0] - (dy / l) * di, pts[i][1] + (dx / l) * di]);
  }
  // break wherever the offset edge opposes the centre-line edge: that is a fold, not a kerb
  const runs: Pt[][] = [];
  let run: Pt[] = [out[0]];
  for (let i = 1; i < n; i++) {
    const ox = out[i][0] - out[i - 1][0];
    const oy = out[i][1] - out[i - 1][1];
    const cx = pts[i][0] - pts[i - 1][0];
    const cy = pts[i][1] - pts[i - 1][1];
    // reversed, or stretched far past the piece of road it belongs to: both are folds
    const stretched = len(ox, oy) > 3 * len(cx, cy) + 0.5;
    if (ox * cx + oy * cy <= 0 || stretched) {
      if (run.length > 2) runs.push(run);
      run = [out[i]];
      continue;
    }
    run.push(out[i]);
  }
  if (run.length > 2) runs.push(run);
  // A reversed edge is the cheap fold test and it catches most of them; a path noisy enough to
  // wander (a hand-held recording estimates a centre line that moves metres between samples) can
  // still cross itself without any single edge reversing, so the contour is cut at the crossing
  // and the loop between the two ends is dropped. What is drawn is then a kerb or nothing.
  return runs.flatMap(splitAtCrossings);
}

/** Cut a run at its first self-crossing, discarding the loop, until nothing crosses. */
export function splitAtCrossings(run: Pt[]): Pt[][] {
  for (let i = 0; i + 1 < run.length; i++) {
    for (let j = i + 2; j + 1 < run.length; j++) {
      if (!segmentsCross(run[i], run[i + 1], run[j], run[j + 1])) continue;
      return [...splitAtCrossings(run.slice(0, i + 1)), ...splitAtCrossings(run.slice(j + 1))];
    }
  }
  return run.length > 2 ? [run] : [];
}

/** Walk `roadPts` from `from`, taking a point roughly every `stepM`, for `spanM` metres. */
function walk(roadPts: Pt[], closed: boolean, from: number, spanM: number, stepM: number, dir: 1 | -1): number[] {
  const n = roadPts.length;
  const idx: number[] = [];
  let travelled = 0;
  let acc = 0;
  let i = from;
  while (travelled < spanM) {
    const next = closed ? (i + dir + n) % n : i + dir;
    if (next < 0 || next >= n) break;
    const step = len(roadPts[next][0] - roadPts[i][0], roadPts[next][1] - roadPts[i][1]);
    travelled += step;
    acc += step;
    i = next;
    if (acc >= stepM) {
      idx.push(i);
      acc = 0;
    }
  }
  return idx;
}

/**
 * The kerb contours for a track, in metres. One or more runs per corner (a corner whose offset
 * folds contributes the pieces that did not).
 */
export function kerbContours(roadPts: Pt[], closed: boolean, corners: KerbCorner[], opts: KerbOptions = KERB_OPTIONS): Pt[][] {
  const n = roadPts.length;
  if (n < 3 || corners.length === 0) return [];
  const parts: Pt[][] = [];
  for (const c of corners) {
    if (!Number.isFinite(c.x) || !Number.isFinite(c.y)) continue;
    let ai = 0;
    let bestD = Infinity;
    for (let i = 0; i < n; i++) {
      const d = (roadPts[i][0] - c.x) ** 2 + (roadPts[i][1] - c.y) ** 2;
      if (d < bestD) {
        bestD = d;
        ai = i;
      }
    }
    // the span is metres of road, not a count of points: the centre line is resampled at ~1 m
    // for a track model and at whatever the speed was for a trail, and a kerb is a length.
    const spanM = Math.min(opts.maxSpanM, Math.max(opts.minSpanM, (Number.isFinite(c.radiusM) ? c.radiusM : opts.minSpanM) * 0.9));
    const back = walk(roadPts, closed, ai, spanM, opts.stepM, -1).reverse();
    const fwd = walk(roadPts, closed, ai, spanM, opts.stepM, 1);
    const seg = [...back, ai, ...fwd].map((i) => [roadPts[i][0], roadPts[i][1]] as Pt);
    if (seg.length < 3) continue;
    for (const run of offsetRuns(seg, c.direction * opts.offsetM, opts.maxCurvatureFrac)) parts.push(run);
  }
  return parts;
}

/** True when two open segments cross (endpoints touching does not count). */
export function segmentsCross(p1: Pt, p2: Pt, p3: Pt, p4: Pt): boolean {
  const d = (p2[0] - p1[0]) * (p4[1] - p3[1]) - (p2[1] - p1[1]) * (p4[0] - p3[0]);
  if (Math.abs(d) < 1e-12) return false;
  const t = ((p3[0] - p1[0]) * (p4[1] - p3[1]) - (p3[1] - p1[1]) * (p4[0] - p3[0])) / d;
  const u = ((p3[0] - p1[0]) * (p2[1] - p1[1]) - (p3[1] - p1[1]) * (p2[0] - p1[0])) / d;
  return t > 1e-9 && t < 1 - 1e-9 && u > 1e-9 && u < 1 - 1e-9;
}

/** How many times a polyline crosses itself. 0 for anything that may be drawn as a kerb. */
export function selfIntersections(run: Pt[]): number {
  let count = 0;
  for (let i = 0; i + 1 < run.length; i++) {
    for (let j = i + 2; j + 1 < run.length; j++) {
      if (segmentsCross(run[i], run[i + 1], run[j], run[j + 1])) count++;
    }
  }
  return count;
}
