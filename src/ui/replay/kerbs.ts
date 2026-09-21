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
  /** Two apexes closer together than this are the same bend found twice, not a chicane. */
  sameBendM: number;
  /**
   * The shortest stripe that may be DRAWN as a kerb, metres.
   *
   * What survives the fold tests is not automatically a kerb. On the hand-held fixture — whose
   * centre line is an estimate that wanders metres between samples — half the runs came out as
   * 3.2–8.6 m fragments of three to five points, and those are what the verge was littered with.
   * On every rigidly-mounted fixture the shortest run is 48.6 m and the median is 75 m.
   */
  minDrawM: number;
  /**
   * How far the drawn contour may be pulled off its intended offset before it stops being the
   * edge of the road, as a fraction of `offsetM`.
   *
   * The per-vertex curvature clamp exists to stop a fold, and where it bites hardest it can pull
   * the contour most of the way back to the centre line: `handheld` produced "kerbs" sitting
   * 0.5–2.7 m out on a road 9.5 m wide, i.e. on the racing line. A stripe that is not on the
   * edge is not a kerb, and the honest thing to draw is nothing.
   */
  minOffsetFrac: number;
  /**
   * How close two kerbs may come, metres. They are stroked 1.1 m wide (`scene.ts`), so two runs
   * nearer than this overlap into one smear whether or not their segments actually cross — which
   * is what "two quads visibly overlapping" was. On every rigid fixture the nearest pair is
   * 10.6 m apart; on `handheld` eight pairs were within 1.6 m and two within 0.3 m.
   */
  minGapM: number;
}

export const KERB_OPTIONS: KerbOptions = {
  offsetM: 5.3,
  minSpanM: 8,
  maxSpanM: 40,
  stepM: 2,
  maxCurvatureFrac: 0.55,
  sameBendM: 5,
  minDrawM: 8,
  minOffsetFrac: 0.6,
  minGapM: 1.6,
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
  // The clamped offset is computed for every vertex FIRST and then smoothed along the line.
  // An unsmoothed clamp is its own artefact: the curvature of an estimated path jumps from
  // vertex to vertex, so the offset jumped with it and threw a metres-long spike out sideways —
  // which is how the road edge line came to zig-zag across the asphalt on the loose-mount
  // fixture even after the folds were gone.
  const dists = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const c = clampIndex(i);
    const { radius, side } = curvatureRadius(near(c, -2), pts[c], near(c, 2));
    // `side` +1 means the path turns left here, so its centre of curvature is to the LEFT,
    // which is where a positive offset points. Only that case can fold.
    dists[i] = side !== 0 && Math.sign(d) === side ? Math.sign(d) * Math.min(Math.abs(d), maxCurvatureFrac * radius) : d;
  }
  for (let pass = 0; pass < 3; pass++) {
    const next = dists.slice();
    for (let i = 1; i < n - 1; i++) next[i] = 0.25 * dists[i - 1] + 0.5 * dists[i] + 0.25 * dists[i + 1];
    for (let i = 0; i < n; i++) dists[i] = next[i];
  }
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
    const di = dists[i];
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
  // still spike or cross itself without any single edge reversing. So the contour is also cut at
  // any hairpin vertex, and at any self-crossing, dropping the piece between the two ends. What
  // is drawn is then a line along the road or nothing at all.
  // (both wrapped: `flatMap` passes the index as the second argument, which is a threshold here)
  const cut = runs.flatMap((r) => splitAtSpikes(r)).flatMap((r) => splitAtCrossings(r));
  // …AND THEN BETWEEN THE PIECES. Every test above runs INSIDE one run, so a fold that straddles
  // a break — the offset doubling back across the gap the break just made — was never looked at.
  // Measured on `handheld`: the left road edge came out as 35 runs with 20 crossings BETWEEN
  // them and the right as 25 with 12, which draw as overlapping quads and a Y-shaped spur into
  // the verge. Two pieces of contour that cross are not a contour.
  return splitBetweenRuns(cut);
}

/**
 * The sharpest turn a drawn contour may make. Beyond this it is a spike, not a corner.
 *
 * 60°, down from 100°. These contours are sampled at `stepM` = 2 m, and no kerb or road edge on
 * a drivable road turns 60° in two metres — that is a 1.7 m radius. The old 100° passed a 94°
 * turn on `handheld` and a 99° one on its road edge, which is what the floating chevron across
 * the verge was made of. A contour that claims one is not being mitred badly, it is wrong, and
 * the honest thing to draw is the road on either side of it and nothing in between.
 */
export const MAX_TURN_RAD = (60 * Math.PI) / 180;

/**
 * Cut every run of a contour SET where it crosses another run of the same set.
 *
 * Order matters and is the input's: a run is kept whole if it crosses nothing already kept, and
 * otherwise cut at its first offending edge — the crossing edge itself is dropped and the rest
 * re-tested, so a run that folds twice loses both folds and keeps the road between them. Pieces
 * of two vertices or fewer are not contours and are dropped.
 *
 * This is deliberately NOT span-limited the way `splitAtCrossings` is: the runs of one offset
 * contour are already the pieces a fold broke it into, so two of them meeting is a fold, not the
 * harbour circuit's two legs passing each other (those are one run, and the span limit inside it
 * is what protects them).
 */
export function splitBetweenRuns(runs: Pt[][]): Pt[][] {
  // each kept run carries its own box, so the pairwise test stays cheap on a lap-long contour
  const kept: Array<{ pts: Pt[]; box: number[] }> = [];
  const boxOf = (pts: Pt[]): number[] => {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const [x, y] of pts) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    return [minX, minY, maxX, maxY];
  };
  for (const run of runs) {
    let rest = run;
    while (rest.length > 2) {
      const box = boxOf(rest);
      const near = kept.filter((k) => box[0] <= k.box[2] && box[2] >= k.box[0] && box[1] <= k.box[3] && box[3] >= k.box[1]);
      let cut = -1;
      for (let i = 0; i + 1 < rest.length && cut < 0; i++) {
        for (const other of near) {
          for (let j = 0; j + 1 < other.pts.length; j++) {
            if (segmentsCross(rest[i], rest[i + 1], other.pts[j], other.pts[j + 1])) {
              cut = i;
              break;
            }
          }
          if (cut >= 0) break;
        }
      }
      if (cut < 0) {
        kept.push({ pts: rest, box });
        break;
      }
      const head = rest.slice(0, cut + 1);
      if (head.length > 2) kept.push({ pts: head, box: boxOf(head) });
      rest = rest.slice(cut + 2);
    }
  }
  return kept.map((k) => k.pts);
}

/** Cut a run at every vertex sharper than `MAX_TURN_RAD`, dropping that vertex. */
export function splitAtSpikes(run: Pt[], maxTurn = MAX_TURN_RAD): Pt[][] {
  const out: Pt[][] = [];
  let cur: Pt[] = run.length ? [run[0]] : [];
  for (let i = 1; i + 1 < run.length; i++) {
    const ax = run[i][0] - run[i - 1][0];
    const ay = run[i][1] - run[i - 1][1];
    const bx = run[i + 1][0] - run[i][0];
    const by = run[i + 1][1] - run[i][1];
    const la = len(ax, ay);
    const lb = len(bx, by);
    const turn = la > 1e-9 && lb > 1e-9 ? Math.acos(Math.max(-1, Math.min(1, (ax * bx + ay * by) / (la * lb)))) : 0;
    if (turn > maxTurn) {
      if (cur.length > 2) out.push(cur);
      cur = [];
      continue;
    }
    cur.push(run[i]);
  }
  if (run.length > 1) cur.push(run[run.length - 1]);
  if (cur.length > 2) out.push(cur);
  return out;
}

/**
 * Cut a run at its first LOCAL self-crossing, discarding the loop, until nothing crosses.
 *
 * Local is the point. A fold is two segments a handful of vertices apart doubling back on each
 * other, and the loop between them is the artefact. Two segments a THOUSAND vertices apart that
 * cross are simply two pieces of road passing close to each other — the harbour circuit's two
 * legs run within 8 m at the hairpin, so their inner edge lines genuinely overlap — and cutting
 * "the loop between them" there throws away half the lap. It did: the inner edge line of the
 * showcase track came back as nothing at all.
 */
export function splitAtCrossings(run: Pt[], maxSpan = FOLD_SPAN): Pt[][] {
  for (let i = 0; i + 1 < run.length; i++) {
    const last = Math.min(run.length - 2, i + maxSpan);
    for (let j = i + 2; j <= last; j++) {
      if (!segmentsCross(run[i], run[i + 1], run[j], run[j + 1])) continue;
      return [...splitAtCrossings(run.slice(0, i + 1), maxSpan), ...splitAtCrossings(run.slice(j + 1), maxSpan)];
    }
  }
  return run.length > 2 ? [run] : [];
}

/** How many vertices apart two segments can be and still count as the same fold. */
export const FOLD_SPAN = 24;

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
  const apexes: Pt[] = [];
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
    // One bend, one kerb. A corner detector run over an estimated path finds the same bend two
    // or three times (22 "corners" on a circuit with ten of them, for a hand-held recording),
    // and their kerbs then lie across each other.
    if (apexes.some((a) => Math.hypot(a[0] - roadPts[ai][0], a[1] - roadPts[ai][1]) < opts.sameBendM)) continue;
    apexes.push(roadPts[ai]);
    // the span is metres of road, not a count of points: the centre line is resampled at ~1 m
    // for a track model and at whatever the speed was for a trail, and a kerb is a length.
    const spanM = Math.min(opts.maxSpanM, Math.max(opts.minSpanM, (Number.isFinite(c.radiusM) ? c.radiusM : opts.minSpanM) * 0.9));
    const back = walk(roadPts, closed, ai, spanM, opts.stepM, -1).reverse();
    const fwd = walk(roadPts, closed, ai, spanM, opts.stepM, 1);
    const seg = [...back, ai, ...fwd].map((i) => [roadPts[i][0], roadPts[i][1]] as Pt);
    if (seg.length < 3) continue;
    for (const run of offsetRuns(seg, c.direction * opts.offsetM, opts.maxCurvatureFrac)) {
      // WHAT SURVIVES THE FOLD TESTS IS NOT AUTOMATICALLY A KERB. Three more things have to be
      // true of a painted stripe, and on an estimated centre line none of them comes for free:
      // it has to be long enough to read as a stripe, it has to be ON THE EDGE of the road
      // rather than somewhere the curvature clamp dragged it, and it must not lie on top of
      // another one. Everything that fails is debris — and the honest thing to draw is the road
      // with no kerb on it, not a fragment on the verge.
      if (pathLength(run) < opts.minDrawM) continue;
      if (Math.min(...run.map((p) => distanceToPath(p, roadPts))) < opts.minOffsetFrac * opts.offsetM) continue;
      // …and no kerb is ever drawn across another one, or close enough to smear into it. Two of
      // them crossing renders as a translucent red X over the asphalt, which is what a viewer
      // reads as a broken polygon.
      if (parts.some((other) => crosses(run, other) || minSeparation(run, other) < opts.minGapM)) continue;
      parts.push(run);
    }
  }
  return parts;
}

/** Length of a polyline, metres. */
export function pathLength(run: Pt[]): number {
  let total = 0;
  for (let i = 1; i < run.length; i++) total += len(run[i][0] - run[i - 1][0], run[i][1] - run[i - 1][1]);
  return total;
}

/** Shortest distance from a point to a polyline. */
export function distanceToPath(p: Pt, path: Pt[]): number {
  let best = Infinity;
  for (let i = 1; i < path.length; i++) {
    const ax = path[i - 1][0];
    const ay = path[i - 1][1];
    const dx = path[i][0] - ax;
    const dy = path[i][1] - ay;
    const l2 = dx * dx + dy * dy;
    const t = l2 > 1e-12 ? Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / l2)) : 0;
    best = Math.min(best, len(p[0] - (ax + t * dx), p[1] - (ay + t * dy)));
  }
  return best;
}

/** How close two polylines come to each other, metres. */
export function minSeparation(a: Pt[], b: Pt[]): number {
  let best = Infinity;
  for (const p of a) best = Math.min(best, distanceToPath(p, b));
  for (const p of b) best = Math.min(best, distanceToPath(p, a));
  return best;
}

/** True when any segment of `a` crosses any segment of `b`. */
export function crosses(a: Pt[], b: Pt[]): boolean {
  for (let i = 0; i + 1 < a.length; i++) {
    for (let j = 0; j + 1 < b.length; j++) {
      if (segmentsCross(a[i], a[i + 1], b[j], b[j + 1])) return true;
    }
  }
  return false;
}

/** True when two open segments cross (endpoints touching does not count). */
export function segmentsCross(p1: Pt, p2: Pt, p3: Pt, p4: Pt): boolean {
  const d = (p2[0] - p1[0]) * (p4[1] - p3[1]) - (p2[1] - p1[1]) * (p4[0] - p3[0]);
  if (Math.abs(d) < 1e-12) return false;
  const t = ((p3[0] - p1[0]) * (p4[1] - p3[1]) - (p3[1] - p1[1]) * (p4[0] - p3[0])) / d;
  const u = ((p3[0] - p1[0]) * (p2[1] - p1[1]) - (p3[1] - p1[1]) * (p2[0] - p1[0])) / d;
  return t > 1e-9 && t < 1 - 1e-9 && u > 1e-9 && u < 1 - 1e-9;
}

/**
 * How many times a polyline crosses itself. 0 for anything that may be drawn as a kerb.
 * `maxSpan` limits it to crossings within that many vertices — the fold scale — so a long
 * contour that legitimately passes near itself is not counted as broken.
 */
export function selfIntersections(run: Pt[], maxSpan = Infinity): number {
  let count = 0;
  for (let i = 0; i + 1 < run.length; i++) {
    const last = Math.min(run.length - 2, i + maxSpan);
    for (let j = i + 2; j <= last; j++) {
      if (segmentsCross(run[i], run[i + 1], run[j], run[j + 1])) count++;
    }
  }
  return count;
}
