/**
 * Fixed-capacity ring buffer of dead-reckoning integrals, indexed by time.
 *
 * Every motion step pushes the cumulative integrals the estimator has propagated so far
 * (course, longitudinal accel, ENU displacement). When a GPS fix arrives — ~0.5 s after the
 * instant it describes — the estimator looks up the integrals at the fix's TRUE time and
 * subtracts them from the current ones, which yields "how much did I dead-reckon since the
 * fix". That converts the delayed measurement into an innovation on the current state
 * without keeping a copy of the full filter state per sample.
 */
export interface HistoryPoint {
  t: number;
  /** Cumulative propagated course change ∫ χ̇ dt (rad). */
  c: number;
  /** Cumulative measured longitudinal acceleration ∫ a_long dt (m/s). */
  v: number;
  /** Cumulative dead-reckoned displacement (m). */
  x: number;
  y: number;
  /** Low-passed copies of c and v (the GPS receiver filters course/speed before reporting them). */
  cl: number;
  vl: number;
}

const STRIDE = 7;

export class History {
  private readonly buf: Float64Array;
  private readonly cap: number;
  private head = 0; // index of the next slot to write
  private count = 0;

  constructor(capacity = 512) {
    this.cap = capacity;
    this.buf = new Float64Array(capacity * STRIDE);
  }

  clear(): void {
    this.head = 0;
    this.count = 0;
  }

  get length(): number {
    return this.count;
  }

  push(p: HistoryPoint): void {
    const o = this.head * STRIDE;
    this.buf[o] = p.t;
    this.buf[o + 1] = p.c;
    this.buf[o + 2] = p.v;
    this.buf[o + 3] = p.x;
    this.buf[o + 4] = p.y;
    this.buf[o + 5] = p.cl;
    this.buf[o + 6] = p.vl;
    this.head = (this.head + 1) % this.cap;
    if (this.count < this.cap) this.count++;
  }

  private slot(i: number): number {
    // i = 0 is the oldest retained sample
    const start = (this.head - this.count + this.cap) % this.cap;
    return ((start + i) % this.cap) * STRIDE;
  }

  oldestT(): number {
    return this.count ? this.buf[this.slot(0)] : NaN;
  }

  newestT(): number {
    return this.count ? this.buf[this.slot(this.count - 1)] : NaN;
  }

  /**
   * Integrals at time t, linearly interpolated. Clamped to the oldest/newest sample when t
   * falls outside the retained window; `clamped` reports how far (s) the request was outside.
   */
  at(t: number): (HistoryPoint & { clamped: number }) | null {
    if (this.count === 0) return null;
    const n = this.count;
    const t0 = this.buf[this.slot(0)];
    const t1 = this.buf[this.slot(n - 1)];
    if (t <= t0) return { ...this.read(0), clamped: t0 - t };
    if (t >= t1) return { ...this.read(n - 1), clamped: t - t1 };
    // binary search for the last sample with time <= t
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.buf[this.slot(mid)] <= t) lo = mid;
      else hi = mid;
    }
    const a = this.read(lo);
    const b = this.read(hi);
    const span = b.t - a.t;
    const f = span > 1e-9 ? (t - a.t) / span : 0;
    return {
      t,
      c: a.c + (b.c - a.c) * f,
      v: a.v + (b.v - a.v) * f,
      x: a.x + (b.x - a.x) * f,
      y: a.y + (b.y - a.y) * f,
      cl: a.cl + (b.cl - a.cl) * f,
      vl: a.vl + (b.vl - a.vl) * f,
      clamped: 0,
    };
  }

  private read(i: number): HistoryPoint {
    const o = this.slot(i);
    return { t: this.buf[o], c: this.buf[o + 1], v: this.buf[o + 2], x: this.buf[o + 3], y: this.buf[o + 4], cl: this.buf[o + 5], vl: this.buf[o + 6] };
  }
}
