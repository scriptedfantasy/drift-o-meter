/**
 * Spatial index over a resampled reference path for O(1)-ish nearest-point queries.
 * A uniform grid of `cellM` cells maps to the vertices inside it; a query scans the
 * 3×3 block around the point and grows the ring only while a closer segment could still
 * exist outside the scanned area (everything outside `r` rings is ≥ r·cellM away).
 */
import type { RefPoint } from './geometry';

export interface Projection {
  /** Arc length along the reference path, metres, in [0, lengthM). */
  s: number;
  /** Signed lateral offset, metres, + = left of the path direction. */
  lateralM: number;
  /** Unsigned distance to the path, metres. */
  distM: number;
  /** Index of the reference segment the point projects onto. */
  segment: number;
}

const KEY_OFFSET = 1 << 20;

export class PathIndex {
  readonly n: number;
  readonly segCount: number;
  private readonly xs: Float64Array;
  private readonly ys: Float64Array;
  private readonly ss: Float64Array;
  private readonly ux: Float64Array;
  private readonly uy: Float64Array;
  private readonly len: Float64Array;
  private readonly cells = new Map<number, number[]>();
  private readonly maxRing: number;

  constructor(
    ref: readonly RefPoint[],
    readonly closed: boolean,
    readonly lengthM: number,
    readonly cellM = 8,
  ) {
    const n = ref.length;
    this.n = n;
    this.segCount = closed ? n : Math.max(0, n - 1);
    this.xs = new Float64Array(n);
    this.ys = new Float64Array(n);
    this.ss = new Float64Array(n);
    this.ux = new Float64Array(this.segCount);
    this.uy = new Float64Array(this.segCount);
    this.len = new Float64Array(this.segCount);
    for (let i = 0; i < n; i++) {
      this.xs[i] = ref[i].x;
      this.ys[i] = ref[i].y;
      this.ss[i] = ref[i].s;
    }
    for (let j = 0; j < this.segCount; j++) {
      const k = (j + 1) % n;
      const dx = this.xs[k] - this.xs[j];
      const dy = this.ys[k] - this.ys[j];
      const l = Math.hypot(dx, dy);
      this.len[j] = l;
      this.ux[j] = l > 1e-12 ? dx / l : 1;
      this.uy[j] = l > 1e-12 ? dy / l : 0;
      const key = this.key(Math.floor(this.xs[j] / cellM), Math.floor(this.ys[j] / cellM));
      const bucket = this.cells.get(key);
      if (bucket) bucket.push(j);
      else this.cells.set(key, [j]);
    }
    this.maxRing = 6;
  }

  private key(ix: number, iy: number): number {
    return (ix + KEY_OFFSET) * (KEY_OFFSET * 2) + (iy + KEY_OFFSET);
  }

  /** Nearest point on the path. Returns null only for an empty path. */
  project(x: number, y: number): Projection | null {
    if (this.segCount === 0) {
      if (this.n === 1) {
        const d = Math.hypot(x - this.xs[0], y - this.ys[0]);
        return { s: 0, lateralM: 0, distM: d, segment: 0 };
      }
      return null;
    }
    const cx = Math.floor(x / this.cellM);
    const cy = Math.floor(y / this.cellM);
    let best = Infinity;
    let bestSeg = -1;
    let bestT = 0;
    const visit = (j: number): void => {
      const t = this.paramOnSegment(j, x, y);
      const px = this.xs[j] + this.ux[j] * t;
      const py = this.ys[j] + this.uy[j] * t;
      const d2 = (x - px) * (x - px) + (y - py) * (y - py);
      if (d2 < best) {
        best = d2;
        bestSeg = j;
        bestT = t;
      }
    };
    for (let r = 0; r <= this.maxRing; r++) {
      for (let ix = cx - r; ix <= cx + r; ix++) {
        const edgeX = ix === cx - r || ix === cx + r;
        for (let iy = cy - r; iy <= cy + r; iy++) {
          if (!edgeX && iy !== cy - r && iy !== cy + r) continue; // only the new ring
          const bucket = this.cells.get(this.key(ix, iy));
          if (bucket) for (let b = 0; b < bucket.length; b++) visit(bucket[b]);
        }
      }
      // everything outside r rings is at least r·cellM away (minus one segment length)
      if (bestSeg >= 0 && Math.sqrt(best) <= r * this.cellM - 1.5) break;
    }
    if (bestSeg < 0 || Math.sqrt(best) > this.maxRing * this.cellM - 1.5) {
      // far from the track (or the grid was inconclusive): brute force
      for (let j = 0; j < this.segCount; j++) visit(j);
    }
    const j = bestSeg;
    const rx = x - this.xs[j];
    const ry = y - this.ys[j];
    const lateral = this.ux[j] * ry - this.uy[j] * rx;
    let s = this.ss[j] + bestT;
    if (this.closed && s >= this.lengthM) s -= this.lengthM;
    return { s, lateralM: lateral, distM: Math.sqrt(best), segment: j };
  }

  private paramOnSegment(j: number, x: number, y: number): number {
    const t = (x - this.xs[j]) * this.ux[j] + (y - this.ys[j]) * this.uy[j];
    return t < 0 ? 0 : t > this.len[j] ? this.len[j] : t;
  }
}
