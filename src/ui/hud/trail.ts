/**
 * The run's trail: a flat, append-only store of where the car has been.
 *
 * Points arrive at ~8 Hz (one per 0.12 s of recording time) and are written into growing typed
 * arrays — no object per point, no array reallocation per push, and the bounds are maintained
 * incrementally so a map can fit itself without scanning. `drift[i]` marks the points laid down
 * while the car was sideways, so a drawing of the line can tell the slides from the transit.
 *
 * NOTHING DRAWS IT ON THE DRIVE SCREEN. The live mini-map it was written for came off the
 * display — a driver at 60 km/h does not read a map of where they have just been — and the
 * store stayed, because `useDriveRun` fills it for the price of two array writes every eighth
 * of a second and the replay screen is the place a line of a run belongs.
 */
export interface Trail {
  x: Float32Array;
  y: Float32Array;
  /** 1 while drifting, 0 otherwise. */
  drift: Uint8Array;
  /** Points written. */
  n: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

const INITIAL = 1024;

export function createTrail(): Trail {
  return {
    x: new Float32Array(INITIAL),
    y: new Float32Array(INITIAL),
    drift: new Uint8Array(INITIAL),
    n: 0,
    minX: Infinity,
    maxX: -Infinity,
    minY: Infinity,
    maxY: -Infinity,
  };
}

export function resetTrail(t: Trail): void {
  t.n = 0;
  t.minX = Infinity;
  t.maxX = -Infinity;
  t.minY = Infinity;
  t.maxY = -Infinity;
}

export function pushTrail(t: Trail, x: number, y: number, drifting: boolean): void {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  if (t.n === t.x.length) grow(t);
  t.x[t.n] = x;
  t.y[t.n] = y;
  t.drift[t.n] = drifting ? 1 : 0;
  t.n++;
  if (x < t.minX) t.minX = x;
  if (x > t.maxX) t.maxX = x;
  if (y < t.minY) t.minY = y;
  if (y > t.maxY) t.maxY = y;
}

function grow(t: Trail): void {
  const cap = t.x.length * 2;
  const x = new Float32Array(cap);
  const y = new Float32Array(cap);
  const drift = new Uint8Array(cap);
  x.set(t.x);
  y.set(t.y);
  drift.set(t.drift);
  t.x = x;
  t.y = y;
  t.drift = drift;
}

export interface TrailFit {
  /** World metres → canvas px. */
  scale: number;
  /** Canvas px offset. */
  ox: number;
  oy: number;
  empty: boolean;
}

/**
 * Fit the trail into `w × h` px with `pad` px of margin, keeping the aspect ratio and flipping
 * y (ENU north is up on screen). A short trail is scaled as if it spanned `minSpanM`, so the map
 * does not zoom wildly during the first seconds of a run.
 */
export function fitTrail(t: Trail, w: number, h: number, pad = 10, minSpanM = 60): TrailFit {
  if (t.n === 0) return { scale: 1, ox: w / 2, oy: h / 2, empty: true };
  const spanX = Math.max(t.maxX - t.minX, minSpanM);
  const spanY = Math.max(t.maxY - t.minY, minSpanM);
  const scale = Math.min((w - 2 * pad) / spanX, (h - 2 * pad) / spanY);
  const cx = (t.minX + t.maxX) / 2;
  const cy = (t.minY + t.maxY) / 2;
  return { scale, ox: w / 2 - cx * scale, oy: h / 2 + cy * scale, empty: false };
}
