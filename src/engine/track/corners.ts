/**
 * Corner extraction from the curvature profile of a resampled reference path.
 */
import type { TrackCorner } from '../types';
import { curvatureProfile, modS, type RefPoint } from './geometry';

export interface CornerOptions {
  /** Curvature entry threshold, 1/m (default 1/70: radius below 70 m counts as a corner). */
  kappaMin: number;
  /** A run keeps going while |κ| > kappaMin × exitFactor (hysteresis, like the simulator's truth). */
  exitFactor: number;
  /** Runs shorter than this are not corners, metres. */
  minLengthM: number;
  /** Same-direction runs separated by less than this are merged, metres. */
  mergeGapM: number;
  /** Curvature smoothing window (each of the two box stages spans ±windowM/2), metres; use an even number of metres at 1 m spacing. */
  windowM: number;
}

export const DEFAULT_CORNER_OPTIONS: CornerOptions = {
  kappaMin: 1 / 70,
  exitFactor: 0.6,
  minLengthM: 12,
  mergeGapM: 6,
  windowM: 6,
};

interface Run {
  /** Start index in scan order (0..n-1 on the ring / path). */
  start: number;
  /** Number of samples in the run. */
  count: number;
  dir: 1 | -1;
  kSum: number;
  /** Number of samples contributing to kSum (dips inside a merged run are excluded). */
  kCount: number;
  kMax: number;
  apex: number;
}

/**
 * Find corners: contiguous runs of |κ| above the threshold (with hysteresis), merged when
 * the same direction continues after a short dip, and kept when longer than `minLengthM`.
 * On a closed ring the scan starts at a straight so a corner straddling s = 0 is one run;
 * such a corner has `endS > lengthM` (its span is `startS..endS` unwrapped, apexS in [0, L)).
 */
export function findCornersOnPath(
  ref: readonly RefPoint[],
  closed: boolean,
  lengthM: number,
  opts: Partial<CornerOptions> = {},
): TrackCorner[] {
  const o = { ...DEFAULT_CORNER_OPTIONS, ...opts };
  const n = ref.length;
  if (n < 3 || !(lengthM > 0)) return [];
  const h = closed ? lengthM / n : lengthM / (n - 1);
  const kappa = curvatureProfile(ref, closed, o.windowM);
  const kExit = o.kappaMin * o.exitFactor;

  // scan origin: on a ring pick a point that is not inside a corner
  let origin = 0;
  if (closed) {
    let best = -1;
    let bestK = Infinity;
    for (let i = 0; i < n; i++) {
      const a = Math.abs(kappa[i]);
      if (a < bestK) {
        bestK = a;
        best = i;
      }
      if (a <= kExit) {
        best = i;
        break;
      }
    }
    origin = best < 0 ? 0 : best;
  }
  const at = (k: number): number => (closed ? (origin + k) % n : k);

  const runs: Run[] = [];
  let cur: Run | null = null;
  for (let k = 0; k < n; k++) {
    const i = at(k);
    const kv = kappa[i];
    const a = Math.abs(kv);
    const dir: 1 | -1 = kv > 0 ? 1 : -1;
    if (cur) {
      if (a > kExit && dir === cur.dir) {
        cur.count++;
        cur.kSum += a;
        cur.kCount++;
        if (a > cur.kMax) {
          cur.kMax = a;
          cur.apex = k;
        }
        continue;
      }
      runs.push(cur);
      cur = null;
    }
    if (a > o.kappaMin) cur = { start: k, count: 1, dir, kSum: a, kCount: 1, kMax: a, apex: k };
  }
  if (cur) runs.push(cur);

  // merge same-direction runs separated by a short dip
  const merged: Run[] = [];
  for (const r of runs) {
    const prev = merged[merged.length - 1];
    if (prev && prev.dir === r.dir && (r.start - (prev.start + prev.count)) * h < o.mergeGapM) {
      const gap = r.start - (prev.start + prev.count);
      prev.count += gap + r.count;
      prev.kSum += r.kSum;
      prev.kCount += r.kCount;
      if (r.kMax > prev.kMax) {
        prev.kMax = r.kMax;
        prev.apex = r.apex;
      }
    } else merged.push({ ...r });
  }
  // ring wrap-around: the last run may continue into the first one across the scan origin
  if (closed && merged.length >= 2) {
    const first = merged[0];
    const last = merged[merged.length - 1];
    const gap = n - (last.start + last.count) + first.start;
    if (first.dir === last.dir && gap * h < o.mergeGapM) {
      last.count += gap + first.count;
      last.kSum += first.kSum;
      last.kCount += first.kCount;
      if (first.kMax > last.kMax) {
        last.kMax = first.kMax;
        last.apex = first.apex + n;
      }
      merged.shift();
    }
  }

  const corners: TrackCorner[] = [];
  for (const r of merged) {
    const len = r.count * h;
    if (len <= o.minLengthM) continue;
    // mean |κ| uses only the samples actually above the exit threshold (dips excluded)
    const startS = modS(at(r.start) * h, lengthM);
    const apexIdx = at(r.apex % n);
    const apexS = closed ? modS(apexIdx * h, lengthM) : apexIdx * h;
    const meanK = r.kSum / Math.max(1, r.kCount);
    corners.push({
      id: 0,
      apexS,
      startS: closed ? startS : r.start * h,
      endS: (closed ? startS : r.start * h) + len,
      x: ref[apexIdx].x,
      y: ref[apexIdx].y,
      direction: r.dir,
      radiusM: meanK > 1e-9 ? 1 / meanK : Infinity,
    });
  }
  corners.sort((a, b) => a.startS - b.startS);
  corners.forEach((c, i) => (c.id = i));
  return corners;
}

/** True when arc length `s` lies inside the corner's span (handles corners that straddle s = 0). */
export function cornerContainsS(corner: TrackCorner, s: number, lengthM: number, closed: boolean): boolean {
  const span = corner.endS - corner.startS;
  if (!closed) return s >= corner.startS && s <= corner.endS;
  return modS(s - corner.startS, lengthM) <= span;
}
