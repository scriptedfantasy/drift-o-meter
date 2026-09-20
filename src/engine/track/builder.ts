/**
 * TrackBuilder — builds a TrackModel live from the estimator's 100 Hz positions.
 *
 * Pipeline per pushed SlipState:
 *   raw (x, y) ──► centred box smoother (±smoothHalfWindowS, delayed output) ──► lap logic
 *                                                                              └► decimated path store (every decimateM)
 * Lap logic on the smoothed stream:
 *   1. start point  = position when speed first exceeds startSpeedMs (rolling starts are fine);
 *      for a standing start (the car was below slowSpeedMs within startLookbackS) the lap began
 *      when it set off, so that earlier sample is the start point and lap-1 start time.
 *      start heading = direction of the first 5 m of travel.
 *   2. after ≥ minLapDistanceM and ≥ minLapTimeS, the first time the car is within gateHalfWidth
 *      of the start point moving within headingToleranceDeg of the start heading, the
 *      start/finish gate is fixed: a segment of ±gateHalfWidth perpendicular to the start heading.
 *   3. every forward crossing of that segment (segment/segment intersection of consecutive
 *      smoothed positions, direction-checked, re-armed only after the car has been ≥ armDistanceM
 *      behind the line, and subject to the same minimum lap distance/time) completes a lap.
 *      The crossing time is interpolated on the segment, not snapped to a sample.
 *   4. the first completed lap becomes the reference: loop-closed, resampled at resampleM,
 *      Gaussian-smoothed (pathSmoothSigmaM), corners extracted, spatial index built. `model` is
 *      non-null from then on. Every later lap is folded into the mean line (refineWithLaps), which
 *      keeps the lap-1 arc-length frame and gate but roughly halves the curvature noise by lap 3,
 *      so corners and apexes settle; `model` is replaced by a new object on every lap.
 *
 * The smoother delays the lap logic by smoothHalfWindowS (0.1 s): `lapCompleted` is reported
 * that much after the real crossing, but the recorded times are exact. `progress` and
 * `projectToS` use the undelayed raw position.
 *
 * Sample indices (Lap.sampleStart/End) count pushes since construction/reset, so they index the
 * same SlipState[] the pipeline records, provided every state is pushed in order.
 */
import type { Lap, SlipState, TrackCorner, TrackModel } from '../types';
import { DEFAULT_CORNER_OPTIONS, findCornersOnPath } from './corners';
import { angleDiff, closeLoop, resamplePolyline, segmentIntersection, smoothPolyline, type Pt, type RefPoint } from './geometry';
import { PathIndex, type Projection } from './projector';

export interface TrackOptions {
  /** Half-width of the start/finish gate, metres. */
  gateHalfWidth: number;
  /** Minimum distance travelled (m) and time (s) before a lap can complete. */
  minLapDistanceM: number;
  minLapTimeS: number;
  /** Motion direction must be within this many degrees of the start heading to arm/define the gate. */
  headingToleranceDeg: number;
  /** Speed at which the run is considered started (start point), m/s. */
  startSpeedMs: number;
  /**
   * Standing starts: when the car first exceeds startSpeedMs, the lap actually began at the last
   * moment it was slower than this (m/s) within startLookbackS seconds; that sample becomes the
   * start point and lap-1 start time. Rolling starts (never slow) use the startSpeedMs sample.
   */
  slowSpeedMs: number;
  startLookbackS: number;
  /** Half window of the centred position smoother, seconds. */
  smoothHalfWindowS: number;
  /** Path store decimation, metres. */
  decimateM: number;
  /** Reference path spacing, metres. */
  resampleM: number;
  /** Gaussian σ of the spatial smoothing applied to the reference path before corner extraction, metres (0 = off). */
  pathSmoothSigmaM: number;
  /** Curvature smoothing window for corner extraction (two box stages of ±windowM/2 on top of the Gaussian), metres. */
  curvatureWindowM: number;
  cornerKappaMin: number;
  cornerExitFactor: number;
  cornerMinLengthM: number;
  cornerMergeGapM: number;
  /** The car must be this far behind the gate line before another crossing can count, metres. */
  armDistanceM: number;
  /** A raw position jump larger than this resets the smoother (estimator re-initialised), metres. */
  maxStepM: number;
  /** Spatial index cell size, metres. */
  cellM: number;
  /**
   * Refine the reference with every completed lap: the centre-line becomes the mean line of all
   * laps (projected onto the lap-1 frame, whose s = 0 and gate are kept). Halves the curvature
   * noise after a few laps, so corners and apexes settle. Off = the reference is lap 1 only.
   */
  refineWithLaps: boolean;
  /** Lap points farther than this from the reference (spins, pit lane) are ignored when refining, metres. */
  refineMaxLateralM: number;
  /** ENU origin copied into the TrackModel (the pipeline knows it from the first GPS fix). */
  originLat: number;
  originLon: number;
}

export const DEFAULT_TRACK_OPTIONS: TrackOptions = {
  gateHalfWidth: 12,
  minLapDistanceM: 150,
  minLapTimeS: 15,
  headingToleranceDeg: 60,
  startSpeedMs: 3,
  slowSpeedMs: 1,
  startLookbackS: 10,
  smoothHalfWindowS: 0.1,
  decimateM: 0.5,
  resampleM: 1,
  pathSmoothSigmaM: 1,
  curvatureWindowM: DEFAULT_CORNER_OPTIONS.windowM,
  cornerKappaMin: DEFAULT_CORNER_OPTIONS.kappaMin,
  cornerExitFactor: DEFAULT_CORNER_OPTIONS.exitFactor,
  cornerMinLengthM: DEFAULT_CORNER_OPTIONS.minLengthM,
  cornerMergeGapM: DEFAULT_CORNER_OPTIONS.mergeGapM,
  armDistanceM: 3,
  maxStepM: 50,
  cellM: 8,
  refineWithLaps: true,
  refineMaxLateralM: 15,
  originLat: 0,
  originLon: 0,
};

export interface TrackTick {
  lapCompleted: Lap | null;
  lapCount: number;
  /** 0..1 along the reference lap when a closed model exists, else NaN. */
  progress: number;
}

interface Smoothed {
  x: number;
  y: number;
  t: number;
  speed: number;
  /** Original push index. */
  i: number;
}

interface Stored extends Pt {
  t: number;
  i: number;
  /** Cumulative path distance, metres. */
  d: number;
}

/** Centred moving average with a fixed delay of D samples; partial windows at the edges. */
class BoxSmoother {
  private readonly cap: number;
  private readonly xs: Float64Array;
  private readonly ys: Float64Array;
  private readonly ts: Float64Array;
  private readonly vs: Float64Array;
  private readonly is: Int32Array;
  private head = 0;
  private count = 0;
  private sumX = 0;
  private sumY = 0;
  private n = -1;

  constructor(readonly D: number) {
    this.cap = 2 * D + 1;
    this.xs = new Float64Array(this.cap);
    this.ys = new Float64Array(this.cap);
    this.ts = new Float64Array(this.cap);
    this.vs = new Float64Array(this.cap);
    this.is = new Int32Array(this.cap);
  }

  reset(): void {
    this.head = 0;
    this.count = 0;
    this.sumX = 0;
    this.sumY = 0;
    this.n = -1;
  }

  push(x: number, y: number, t: number, speed: number, i: number): Smoothed | null {
    if (this.count === this.cap) {
      this.sumX -= this.xs[this.head];
      this.sumY -= this.ys[this.head];
    } else this.count++;
    this.xs[this.head] = x;
    this.ys[this.head] = y;
    this.ts[this.head] = t;
    this.vs[this.head] = speed;
    this.is[this.head] = i;
    this.head = (this.head + 1) % this.cap;
    this.sumX += x;
    this.sumY += y;
    this.n++;
    if (this.n < this.D) return null;
    const pos = (this.head - 1 - this.D + this.cap) % this.cap;
    return { x: this.sumX / this.count, y: this.sumY / this.count, t: this.ts[pos], speed: this.vs[pos], i: this.is[pos] };
  }

  /** The D centres still waiting for future samples, averaged over what is available. Non-destructive. */
  tail(): Smoothed[] {
    const out: Smoothed[] = [];
    const m = this.count;
    if (m === 0) return out;
    const lin: number[] = new Array(m);
    for (let k = 0; k < m; k++) lin[k] = (this.head - m + k + this.cap) % this.cap;
    const firstCentre = Math.max(0, m - this.D);
    if (this.n < this.D) {
      // nothing has been emitted yet: emit every sample with a partial window
      for (let c = 0; c < m; c++) out.push(this.avg(lin, Math.max(0, c - this.D), m - 1, lin[c]));
      return out;
    }
    for (let c = firstCentre; c < m; c++) out.push(this.avg(lin, Math.max(0, c - this.D), m - 1, lin[c]));
    return out;
  }

  private avg(lin: number[], from: number, to: number, centrePos: number): Smoothed {
    let sx = 0;
    let sy = 0;
    let cnt = 0;
    for (let k = from; k <= to; k++) {
      sx += this.xs[lin[k]];
      sy += this.ys[lin[k]];
      cnt++;
    }
    return { x: sx / cnt, y: sy / cnt, t: this.ts[centrePos], speed: this.vs[centrePos], i: this.is[centrePos] };
  }
}

export class TrackBuilder {
  readonly opts: TrackOptions;
  private _laps: Lap[] = [];
  private _model: TrackModel | null = null;
  private index: PathIndex | null = null;

  private sampleIndex = -1;
  private pending: { x: number; y: number; t: number; speed: number; i: number } | null = null;
  private smoother: BoxSmoother | null = null;
  private lastRaw: Pt | null = null;

  private stored: Stored[] = [];
  private travelled = 0;
  private prev: Smoothed | null = null;

  private started = false;
  private slow: { o: Smoothed; storedLen: number } | null = null;
  private startPt: Pt = { x: 0, y: 0 };
  private startHeading: number | null = null;
  private startPathIdx = 0;
  private startSampleIdx = 0;

  private lapStartT = 0;
  private lapStartD = 0;
  private lapStartSample = 0;
  private lapPathStart = 0;

  private gate: { ax: number; ay: number; bx: number; by: number; ux: number; uy: number } | null = null;
  private armed = false;

  /** Lap-1 frame used for multi-lap refinement. */
  private base: RefPoint[] | null = null;
  private baseIndex: PathIndex | null = null;
  private baseNx: Float64Array | null = null;
  private baseNy: Float64Array | null = null;
  private latSum: Float64Array | null = null;
  private latCount: Int32Array | null = null;

  constructor(opts: Partial<TrackOptions> = {}) {
    this.opts = { ...DEFAULT_TRACK_OPTIONS, ...opts };
  }

  get laps(): Lap[] {
    return this._laps;
  }

  get model(): TrackModel | null {
    return this._model;
  }

  /** True once the car has moved faster than startSpeedMs. */
  get isStarted(): boolean {
    return this.started;
  }

  /** Set the ENU origin (known to the pipeline after the first GPS fix). */
  setOrigin(lat: number, lon: number): void {
    this.opts.originLat = lat;
    this.opts.originLon = lon;
    if (this._model) this._model = { ...this._model, originLat: lat, originLon: lon };
  }

  reset(): void {
    this._laps = [];
    this._model = null;
    this.index = null;
    this.sampleIndex = -1;
    this.pending = null;
    this.smoother = null;
    this.lastRaw = null;
    this.stored = [];
    this.travelled = 0;
    this.prev = null;
    this.started = false;
    this.slow = null;
    this.startHeading = null;
    this.startPathIdx = 0;
    this.startSampleIdx = 0;
    this.lapStartT = 0;
    this.lapStartD = 0;
    this.lapStartSample = 0;
    this.lapPathStart = 0;
    this.gate = null;
    this.armed = false;
    this.base = null;
    this.baseIndex = null;
    this.baseNx = null;
    this.baseNy = null;
    this.latSum = null;
    this.latCount = null;
  }

  push(s: SlipState): TrackTick {
    this.sampleIndex++;
    const i = this.sampleIndex;
    const x = s.x;
    const y = s.y;
    const t = s.t;
    const speed = Number.isFinite(s.speed) ? Math.abs(s.speed) : 0;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(t)) return this.tick(null, x, y);

    let lapCompleted: Lap | null = null;
    if (!this.smoother) {
      // the smoother window is sized in samples: infer the rate from the first two timestamps
      if (!this.pending) {
        this.pending = { x, y, t, speed, i };
        return this.tick(null, x, y);
      }
      const dt = t - this.pending.t;
      const D = dt > 1e-4 && dt < 1 ? Math.max(1, Math.min(500, Math.round(this.opts.smoothHalfWindowS / dt))) : 25;
      this.smoother = new BoxSmoother(D);
      const p = this.pending;
      this.pending = null;
      this.lastRaw = { x: p.x, y: p.y };
      const o = this.smoother.push(p.x, p.y, p.t, p.speed, p.i);
      if (o) lapCompleted = this.onSmoothed(o) ?? lapCompleted;
    }
    if (this.lastRaw && Math.hypot(x - this.lastRaw.x, y - this.lastRaw.y) > this.opts.maxStepM) {
      // estimator re-initialised: flush what we have and restart the smoother at the new position
      for (const o of this.smoother.tail()) lapCompleted = this.onSmoothed(o) ?? lapCompleted;
      this.smoother.reset();
      this.prev = null;
    }
    this.lastRaw = { x, y };
    const o = this.smoother.push(x, y, t, speed, i);
    if (o) lapCompleted = this.onSmoothed(o) ?? lapCompleted;
    return this.tick(lapCompleted, x, y);
  }

  private tick(lapCompleted: Lap | null, x: number, y: number): TrackTick {
    let progress = NaN;
    if (this.index && this._model && this._model.closed && this._model.lengthM > 0 && Number.isFinite(x) && Number.isFinite(y)) {
      const p = this.index.project(x, y);
      if (p) progress = p.s / this._model.lengthM;
    }
    return { lapCompleted, lapCount: this._laps.length, progress };
  }

  /** Nearest point on the reference path (closed model, or the open model after build()). */
  projectToS(x: number, y: number): { s: number; lateralM: number } | null {
    if (!this.index) return null;
    const p: Projection | null = this.index.project(x, y);
    return p ? { s: p.s, lateralM: p.lateralM } : null;
  }

  /** Full projection including distance to the path and the segment index. */
  projectFull(x: number, y: number): Projection | null {
    return this.index ? this.index.project(x, y) : null;
  }

  private storePoint(x: number, y: number, t: number, i: number, force: boolean): void {
    const last = this.stored[this.stored.length - 1];
    if (!last) {
      this.stored.push({ x, y, t, i, d: 0 });
      return;
    }
    const step = Math.hypot(x - last.x, y - last.y);
    if (!force && step < this.opts.decimateM) return;
    this.travelled += step;
    this.stored.push({ x, y, t, i, d: this.travelled });
  }

  /** Insert a path point at `at` (used once, for a standing start) and recompute cumulative distances after it. */
  private insertPoint(at: number, o: Smoothed): void {
    const idx = Math.max(0, Math.min(at, this.stored.length));
    this.stored.splice(idx, 0, { x: o.x, y: o.y, t: o.t, i: o.i, d: 0 });
    for (let k = Math.max(1, idx); k < this.stored.length; k++) {
      const a = this.stored[k - 1];
      const b = this.stored[k];
      b.d = a.d + Math.hypot(b.x - a.x, b.y - a.y);
    }
    this.travelled = this.stored[this.stored.length - 1].d;
  }

  private onSmoothed(o: Smoothed): Lap | null {
    const opts = this.opts;
    let completed: Lap | null = null;

    if (!this.started) {
      if (o.speed > opts.startSpeedMs) {
        this.started = true;
        const slow = this.slow;
        const plausibleM = 4 * opts.startSpeedMs * opts.startLookbackS; // could not have gone further while below startSpeedMs
        if (slow && o.t - slow.o.t <= opts.startLookbackS && Math.hypot(o.x - slow.o.x, o.y - slow.o.y) <= plausibleM) {
          // standing start: the lap began when the car set off, not when it reached startSpeedMs
          this.startPt = { x: slow.o.x, y: slow.o.y };
          this.startSampleIdx = slow.o.i;
          this.lapStartT = slow.o.t;
          this.insertPoint(slow.storedLen, slow.o);
          this.startPathIdx = slow.storedLen;
          this.storePoint(o.x, o.y, o.t, o.i, false);
        } else {
          this.startPt = { x: o.x, y: o.y };
          this.startSampleIdx = o.i;
          this.lapStartT = o.t;
          this.storePoint(o.x, o.y, o.t, o.i, true);
          this.startPathIdx = this.stored.length - 1;
        }
        this.lapPathStart = this.startPathIdx;
        this.lapStartD = this.stored[this.startPathIdx].d;
        this.lapStartSample = this.startSampleIdx;
        this.prev = o;
        return null;
      }
      if (o.speed < opts.slowSpeedMs) this.slow = { o, storedLen: this.stored.length };
      this.storePoint(o.x, o.y, o.t, o.i, false);
      this.prev = o;
      return null;
    }

    if (this.startHeading === null) {
      const dx = o.x - this.startPt.x;
      const dy = o.y - this.startPt.y;
      if (Math.hypot(dx, dy) >= 5) this.startHeading = Math.atan2(dy, dx);
    }

    const prev = this.prev;
    if (this.startHeading !== null && prev) {
      const h0 = this.startHeading;
      const ux = Math.cos(h0);
      const uy = Math.sin(h0);
      const lapLongEnough = this.travelled - this.lapStartD >= opts.minLapDistanceM && o.t - this.lapStartT >= opts.minLapTimeS;
      const mx = o.x - prev.x;
      const my = o.y - prev.y;
      const moving = Math.hypot(mx, my) > 1e-6;
      const motionDir = moving ? Math.atan2(my, mx) : h0;
      const tol = (opts.headingToleranceDeg * Math.PI) / 180;

      if (!this.gate && lapLongEnough) {
        const dist = Math.hypot(o.x - this.startPt.x, o.y - this.startPt.y);
        if (dist <= opts.gateHalfWidth && moving && angleDiff(motionDir, h0) <= tol) {
          const w = opts.gateHalfWidth;
          this.gate = {
            ax: this.startPt.x - uy * w,
            ay: this.startPt.y + ux * w,
            bx: this.startPt.x + uy * w,
            by: this.startPt.y - ux * w,
            ux,
            uy,
          };
          const sdPrev = (prev.x - this.startPt.x) * ux + (prev.y - this.startPt.y) * uy;
          this.armed = sdPrev < 0;
          if (sdPrev >= 0) {
            // entered the gate circle already past the line: count the crossing now
            completed = this.completeLap(o, o, 0);
          }
        }
      }
      if (this.gate) {
        const sd = (o.x - this.startPt.x) * ux + (o.y - this.startPt.y) * uy;
        if (!this.armed && sd < -opts.armDistanceM) this.armed = true;
        if (this.armed && !completed && lapLongEnough && moving && mx * ux + my * uy > 0) {
          const f = segmentIntersection(prev.x, prev.y, o.x, o.y, this.gate.ax, this.gate.ay, this.gate.bx, this.gate.by);
          if (f >= 0) completed = this.completeLap(prev, o, f);
        }
      }
    }

    this.storePoint(o.x, o.y, o.t, o.i, false);
    this.prev = o;
    return completed;
  }

  private completeLap(prev: Smoothed, cur: Smoothed, f: number): Lap {
    const tX = prev.t + f * (cur.t - prev.t);
    const xX = prev.x + f * (cur.x - prev.x);
    const yX = prev.y + f * (cur.y - prev.y);
    const lap: Lap = {
      index: this._laps.length,
      startT: this.lapStartT,
      endT: tX,
      durationS: tX - this.lapStartT,
      sampleStart: this.lapStartSample,
      sampleEnd: Math.max(this.lapStartSample, cur.i - 1),
    };
    // the crossing point closes this lap's path and opens the next
    this.storePoint(xX, yX, tX, cur.i, true);
    const crossingIdx = this.stored.length - 1;
    this._laps = [...this._laps, lap];
    if (this._laps.length === 1) this.buildReference(this.lapPathStart, crossingIdx);
    else if (this._model && this.opts.refineWithLaps && this.base) this.refineReference(this.lapPathStart, crossingIdx);
    else if (this._model) this._model = { ...this._model, laps: this._laps };
    this.lapPathStart = crossingIdx;
    this.lapStartT = tX;
    this.lapStartD = this.travelled;
    this.lapStartSample = cur.i;
    this.armed = false;
    return lap;
  }

  /** Decimated path → equally spaced, spatially smoothed reference path. */
  private toReference(pts: readonly Pt[], closed: boolean): RefPoint[] {
    let ref = resamplePolyline(pts, this.opts.resampleM, closed);
    if (ref.length >= 3 && this.opts.pathSmoothSigmaM > 0) {
      ref = resamplePolyline(smoothPolyline(ref, this.opts.pathSmoothSigmaM, closed), this.opts.resampleM, closed);
    }
    return ref;
  }

  private buildReference(from: number, to: number): void {
    const pts: Pt[] = this.stored.slice(from, to + 1);
    if (pts.length < 3) return;
    const ring = closeLoop(pts);
    const ref = this.toReference(ring, true);
    if (ref.length < 3) return;
    const n = ref.length;
    this.base = ref;
    this.baseIndex = new PathIndex(ref, true, n * (ref[1].s - ref[0].s), this.opts.cellM);
    this.baseNx = new Float64Array(n);
    this.baseNy = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const a = ref[(i + n - 1) % n];
      const b = ref[(i + 1) % n];
      const l = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      this.baseNx[i] = -(b.y - a.y) / l; // unit left normal
      this.baseNy[i] = (b.x - a.x) / l;
    }
    this.latSum = new Float64Array(n);
    this.latCount = new Int32Array(n);
    this.publishClosed(ref);
  }

  /** Fold one more lap into the mean line and rebuild corners/index in the lap-1 frame. */
  private refineReference(from: number, to: number): void {
    const base = this.base;
    const bi = this.baseIndex;
    if (!base || !bi || !this.baseNx || !this.baseNy || !this.latSum || !this.latCount) return;
    const n = base.length;
    const h = bi.lengthM / n;
    const sum = new Float64Array(n);
    const cnt = new Int32Array(n);
    for (let k = from; k <= to; k++) {
      const p = this.stored[k];
      const pr = bi.project(p.x, p.y);
      if (!pr || Math.abs(pr.lateralM) > this.opts.refineMaxLateralM) continue;
      const bin = Math.round(pr.s / h) % n;
      sum[bin] += pr.lateralM;
      cnt[bin]++;
    }
    let touched = 0;
    for (let i = 0; i < n; i++) {
      if (cnt[i] === 0) continue;
      this.latSum[i] += sum[i] / cnt[i];
      this.latCount[i]++;
      touched++;
    }
    if (touched < n / 2) {
      // the lap did not cover the track (long gap): keep the current reference
      if (this._model) this._model = { ...this._model, laps: this._laps };
      return;
    }
    const pts: Pt[] = new Array(n);
    for (let i = 0; i < n; i++) {
      // lap 1 (the base itself) contributes a zero offset with the same weight as every other lap
      const mean = this.latSum[i] / (this.latCount[i] + 1);
      pts[i] = { x: base[i].x + this.baseNx[i] * mean, y: base[i].y + this.baseNy[i] * mean };
    }
    const ref = this.toReference(pts, true);
    if (ref.length < 3) return;
    this.publishClosed(ref);
  }

  private publishClosed(ref: RefPoint[]): void {
    const lengthM = ref.length * (ref[1].s - ref[0].s);
    const corners = this.corners(ref, true, lengthM);
    this.index = new PathIndex(ref, true, lengthM, this.opts.cellM);
    const g = this.gate;
    this._model = {
      originLat: this.opts.originLat,
      originLon: this.opts.originLon,
      refPath: ref,
      closed: true,
      lengthM,
      corners,
      laps: this._laps,
      gate: g ? { ax: g.ax, ay: g.ay, bx: g.bx, by: g.by } : undefined,
    };
  }

  private corners(ref: RefPoint[], closed: boolean, lengthM: number): TrackCorner[] {
    return findCornersOnPath(ref, closed, lengthM, {
      kappaMin: this.opts.cornerKappaMin,
      exitFactor: this.opts.cornerExitFactor,
      minLengthM: this.opts.cornerMinLengthM,
      mergeGapM: this.opts.cornerMergeGapM,
      windowM: this.opts.curvatureWindowM,
    });
  }

  /**
   * Finalise: the closed model when at least one lap completed, otherwise an open
   * (point-to-point) model of everything driven so far. Null when there is no usable path.
   * For an open model the builder keeps the result so projectToS works afterwards.
   */
  build(): TrackModel | null {
    if (this._model && this._model.closed) return this._model;
    const pts: Pt[] = this.stored.slice(this.started ? this.startPathIdx : 0);
    if (this.smoother) {
      // include the samples still inside the smoother window, decimated like the store
      let last: Pt | undefined = pts[pts.length - 1];
      for (const o of this.smoother.tail()) {
        if (!last || Math.hypot(o.x - last.x, o.y - last.y) >= this.opts.decimateM) {
          pts.push({ x: o.x, y: o.y });
          last = pts[pts.length - 1];
        }
      }
    }
    const ref = this.toReference(pts, false);
    if (ref.length < 2) return null;
    const lengthM = ref[ref.length - 1].s;
    if (!(lengthM > 2)) return null;
    const corners = this.corners(ref, false, lengthM);
    this.index = new PathIndex(ref, false, lengthM, this.opts.cellM);
    this._model = {
      originLat: this.opts.originLat,
      originLon: this.opts.originLon,
      refPath: ref,
      closed: false,
      lengthM,
      corners,
      laps: [],
    };
    return this._model;
  }
}
