/**
 * Tiny O(1) recursive filters used by the integrity monitor.
 *
 * Everything here is a scalar (or Vec3) recursion with a time constant, stepped with the
 * actual sample interval `dt`, so the monitor behaves the same at 50, 100 or 120 Hz.
 */
import type { Vec3 } from '../types';

const TWO_PI = Math.PI * 2;

/** First-order low-pass, y += (x − y)·dt/(τ + dt). Primes itself on the first sample. */
export class Lp1 {
  y = 0;
  primed = false;
  constructor(public tau: number) {}
  step(x: number, dt: number): number {
    if (!this.primed) {
      this.y = x;
      this.primed = true;
      return x;
    }
    this.y += ((x - this.y) * dt) / (this.tau + dt);
    return this.y;
  }
  reset(): void {
    this.y = 0;
    this.primed = false;
  }
}

/** Time constant of each stage of a two-stage cascade whose −3 dB point sits at `fc`. */
function cascadeTau(fc: number): number {
  // two identical first-order stages: |H|² = 1/(1+(ωτ)²)² = ½  ⇒  ωτ = √(√2 − 1) ≈ 0.644
  return 0.6436 / (TWO_PI * fc);
}

/** Second-order low-pass (two cascaded first-order stages), −3 dB at `fc` Hz. */
export class Lp2 {
  private a: Lp1;
  private b: Lp1;
  constructor(fc: number) {
    const tau = cascadeTau(fc);
    this.a = new Lp1(tau);
    this.b = new Lp1(tau);
  }
  get y(): number {
    return this.b.y;
  }
  step(x: number, dt: number): number {
    return this.b.step(this.a.step(x, dt), dt);
  }
  reset(): void {
    this.a.reset();
    this.b.reset();
  }
}

/** Band-pass = 2nd-order low-pass at `hiHz` minus 1st-order low-pass at `loHz`. */
export class BandPass {
  private lo: Lp1;
  private hi: Lp2;
  y = 0;
  constructor(loHz: number, hiHz: number) {
    this.lo = new Lp1(1 / (TWO_PI * loHz));
    this.hi = new Lp2(hiHz);
  }
  step(x: number, dt: number): number {
    const smooth = this.hi.step(x, dt);
    const slow = this.lo.step(smooth, dt);
    this.y = smooth - slow;
    return this.y;
  }
  reset(): void {
    this.lo.reset();
    this.hi.reset();
    this.y = 0;
  }
}

/** Component-wise band-pass of a Vec3. */
export class BandPass3 {
  private x: BandPass;
  private yf: BandPass;
  private z: BandPass;
  readonly y: Vec3 = { x: 0, y: 0, z: 0 };
  constructor(loHz: number, hiHz: number) {
    this.x = new BandPass(loHz, hiHz);
    this.yf = new BandPass(loHz, hiHz);
    this.z = new BandPass(loHz, hiHz);
  }
  step(v: Vec3, dt: number): Vec3 {
    this.y.x = this.x.step(v.x, dt);
    this.y.y = this.yf.step(v.y, dt);
    this.y.z = this.z.step(v.z, dt);
    return this.y;
  }
  reset(): void {
    this.x.reset();
    this.yf.reset();
    this.z.reset();
    this.y.x = this.y.y = this.y.z = 0;
  }
}

/** Component-wise 2nd-order low-pass of a Vec3. */
export class Lp3 {
  private x: Lp2;
  private yf: Lp2;
  private z: Lp2;
  readonly y: Vec3 = { x: 0, y: 0, z: 0 };
  constructor(fc: number) {
    this.x = new Lp2(fc);
    this.yf = new Lp2(fc);
    this.z = new Lp2(fc);
  }
  step(v: Vec3, dt: number): Vec3 {
    this.y.x = this.x.step(v.x, dt);
    this.y.y = this.yf.step(v.y, dt);
    this.y.z = this.z.step(v.z, dt);
    return this.y;
  }
  reset(): void {
    this.x.reset();
    this.yf.reset();
    this.z.reset();
    this.y.x = this.y.y = this.y.z = 0;
  }
}

/**
 * Exponentially-weighted mean square with window τ (seconds). Starts at zero, so a fresh
 * monitor never raises an alarm from its very first sample; it needs ~τ of evidence.
 */
export class ExpRms {
  ms = 0;
  constructor(public tau: number) {}
  step(x: number, dt: number): number {
    this.ms += ((x * x - this.ms) * dt) / this.tau;
    return this.ms;
  }
  /** Feed an already-squared quantity (e.g. |v|²). */
  stepSquared(x2: number, dt: number): number {
    this.ms += ((x2 - this.ms) * dt) / this.tau;
    return this.ms;
  }
  get rms(): number {
    return Math.sqrt(Math.max(0, this.ms));
  }
  reset(): void {
    this.ms = 0;
  }
}

export function finite(x: number, fallback = 0): number {
  return Number.isFinite(x) ? x : fallback;
}
