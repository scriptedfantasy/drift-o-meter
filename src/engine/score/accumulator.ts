/**
 * DriftAccumulator — the ONE integrator both `LiveScorer` and `scoreDrift` run.
 *
 * It consumes SlipStates one at a time (causally), accrues base points, grows the
 * multiplier, detects transitions / spins, fires callouts at their moment, and on
 * `finish()` computes the per-drift statistics the components need. Because the live
 * and the offline paths feed the same samples through this same code, a replay
 * reproduces the live accumulation exactly (not "within 1 %": bit-for-bit).
 */
import type { SlipState, StyleCallout, StyleCalloutKind } from '../types';
import { radToDeg } from '../types';
import { angleFactor, calloutLabel, KMH, speedFactor, type ScoreOptions } from './rules';

/** Chain context handed to a drift when it starts. */
export interface DriftContext {
  /** Multiplier carried in from the chain (1.0 for a fresh chain). */
  multiplier?: number;
  /** Drifts already in the chain before this one (0 for a fresh chain). */
  chainDrifts?: number;
  /** Force the spin flag (e.g. from a detector that knows better). */
  spin?: boolean;
}

/** Everything `finish()` knows about a drift. */
export interface DriftStats {
  id: number;
  startT: number;
  endT: number;
  durationS: number;
  /** Seconds with |β| ≥ angleFloorDeg. */
  sustainedS: number;
  /** Seconds with |β| ≥ qualityAngleDeg. */
  timeAtAngleS: number;
  /** Instantaneous peak |β| (deg, 0.1 s smoothed). */
  peakDeg: number;
  peakT: number;
  /** Peak of |β| held over `peakHoldS` (deg) — what the angle component and EXTREME ANGLE use. */
  heldPeakDeg: number;
  meanDeg: number;
  /** RMS jitter of |β| (deg) around a local quadratic trend, sustained plateau only. */
  jitterDeg: number;
  /** Seconds of plateau the jitter was measured on (0 = too short to judge; steadiness weight 0). */
  plateauS: number;
  /** Max |dβ/dt| (deg/s) over the last exitWindowS of the drift. */
  exitRateDegS: number;
  meanSpeedKmh: number;
  entrySpeedKmh: number;
  transitions: number;
  spun: boolean;
  cleanExit: boolean;
  /** Multiplier value when the drift ended (carried into a chained drift). */
  multiplierEnd: number;
  peakMultiplier: number;
  /** Chain ordinal of this drift (1 = first in its chain). */
  chainIndex: number;
}

export interface StepResult {
  /** Points (base × multiplier) added this step, not counting callouts. */
  points: number;
  /** Bonus points from callouts fired this step. */
  bonus: number;
  callouts: StyleCallout[];
  /** Instantaneous rate, points per second, for a HUD needle. */
  rate: number;
}

interface Sample {
  t: number;
  v: number;
}

/** Trailing time-window moving average. */
class Trailing {
  private q: Sample[] = [];
  private head = 0;
  private sum = 0;
  constructor(private windowS: number) {}
  push(t: number, v: number): number {
    this.q.push({ t, v });
    this.sum += v;
    while (this.head < this.q.length && this.q[this.head].t < t - this.windowS) {
      this.sum -= this.q[this.head].v;
      this.head++;
    }
    if (this.head > 256 && this.head * 2 > this.q.length) {
      this.q = this.q.slice(this.head);
      this.head = 0;
    }
    return this.sum / (this.q.length - this.head);
  }
}

/** Trailing window mean & std-dev that resets when `clear()` is called. */
class TrailingStats {
  private q: Sample[] = [];
  private head = 0;
  private sum = 0;
  private sumSq = 0;
  private startT = NaN;
  private lastT = NaN;
  constructor(private windowS: number) {}
  clear(): void {
    this.q = [];
    this.head = 0;
    this.sum = 0;
    this.sumSq = 0;
    this.startT = NaN;
    this.lastT = NaN;
  }
  push(t: number, v: number): void {
    if (Number.isNaN(this.startT)) this.startT = t;
    this.lastT = t;
    this.q.push({ t, v });
    this.sum += v;
    this.sumSq += v * v;
    while (this.head < this.q.length && this.q[this.head].t < t - this.windowS) {
      const s = this.q[this.head];
      this.sum -= s.v;
      this.sumSq -= s.v * s.v;
      this.head++;
    }
    if (this.head > 512 && this.head * 2 > this.q.length) {
      this.q = this.q.slice(this.head);
      this.head = 0;
    }
  }
  /** Seconds since the window was (re)started — i.e. of uninterrupted sustained angle. */
  get elapsedS(): number {
    return Number.isNaN(this.startT) ? 0 : this.lastT - this.startT;
  }
  get stdDev(): number {
    const n = this.q.length - this.head;
    if (n < 2) return 0;
    const mean = this.sum / n;
    const v = Math.max(0, this.sumSq / n - mean * mean);
    return Math.sqrt(v);
  }
}

export class DriftAccumulator {
  readonly id: number;
  readonly chainIndex: number;
  readonly startT: number;
  /** Integrated 100 × angleFactor × speedFactor × dt (no multiplier). */
  base = 0;
  /** Integrated base × multiplier(t). */
  points = 0;
  bonus = 0;
  callouts: StyleCallout[] = [];
  multiplier: number;
  peakMultiplier: number;
  transitions = 0;
  spun = false;
  finished = false;

  private o: ScoreOptions;
  private lastT: number | null = null;
  private lastRate = 0;
  private durationS = 0;
  private sustainedS = 0;
  private sustainedSteps = 0;
  private timeAtAngleS = 0;
  private peakDeg = 0;
  private peakT: number;
  private speedIntegral = 0;
  private entrySpeedKmh = 0;
  private signState: -1 | 0 | 1 = 0;
  private smoother: Trailing;
  private holder: Trailing;
  private extremeHolder: Trailing;
  private heldPeakDeg = 0;
  private smoothWin: TrailingStats;
  private fired = new Set<StyleCalloutKind>();
  private tTrace: number[] = [];
  private betaTrace: number[] = []; // signed, smoothed, degrees
  private rawTrace: number[] = []; // signed, raw, degrees
  private ctxSpin: boolean | undefined;

  constructor(o: ScoreOptions, id: number, startT: number, ctx?: DriftContext) {
    this.o = o;
    this.id = id;
    this.startT = startT;
    this.peakT = startT;
    this.multiplier = ctx?.multiplier ?? o.multiplierStart;
    this.peakMultiplier = this.multiplier;
    this.chainIndex = (ctx?.chainDrifts ?? 0) + 1;
    this.ctxSpin = ctx?.spin;
    this.smoother = new Trailing(o.smoothingS);
    this.holder = new Trailing(o.peakHoldS);
    this.extremeHolder = new Trailing(o.extremeAngleHoldS);
    this.smoothWin = new TrailingStats(o.smoothWindowS);
  }

  /** Callouts that fire at the first sample of the drift (initiation, link). */
  private fireStart(t: number): StyleCallout[] {
    const out: StyleCallout[] = [];
    out.push(this.fire('initiation', t));
    if (this.chainIndex >= this.o.linkDrifts) out.push(this.fire('link', t, this.chainIndex));
    return out;
  }

  private fire(kind: StyleCalloutKind, t: number, n = 1): StyleCallout {
    const per = this.o.calloutPoints[kind];
    const points = kind === 'transition' ? per * n : per;
    const c: StyleCallout = { t, kind, label: calloutLabel(kind, n), points };
    this.callouts.push(c);
    this.bonus += points;
    if (kind !== 'transition') this.fired.add(kind);
    return c;
  }

  private bump(delta: number): void {
    this.multiplier = Math.min(this.o.multiplierCap, this.multiplier + delta);
    if (this.multiplier > this.peakMultiplier) this.peakMultiplier = this.multiplier;
  }

  step(s: SlipState): StepResult {
    const o = this.o;
    const res: StepResult = { points: 0, bonus: 0, callouts: [], rate: 0 };
    if (this.finished || this.spun) return res;
    const t = s.t;
    const first = this.lastT === null;
    let dt = first ? 0 : t - (this.lastT as number);
    if (dt < 0) dt = 0;
    if (dt > o.maxDtS) dt = 0; // a gap: no points for time we did not observe
    this.lastT = t;

    const rawDeg = radToDeg(s.beta);
    this.rawTrace.push(rawDeg);
    const betaDeg = this.smoother.push(t, rawDeg);
    const absDeg = Math.abs(betaDeg);
    const heldDeg = Math.abs(this.holder.push(t, betaDeg));
    if (heldDeg > this.heldPeakDeg) this.heldPeakDeg = heldDeg;
    const extremeDeg = Math.abs(this.extremeHolder.push(t, betaDeg));
    const speedKmh = Math.max(0, s.speed) * KMH;
    this.tTrace.push(t);
    this.betaTrace.push(betaDeg);

    if (first) {
      this.entrySpeedKmh = speedKmh;
      res.callouts.push(...this.fireStart(t));
    }

    // ---- spin ---------------------------------------------------------------------------
    if (absDeg >= o.spinAngleDeg || this.ctxSpin === true) {
      this.spun = true;
      for (const c of res.callouts) res.bonus += c.points;
      return res;
    }

    // ---- transitions (sign change through the hysteresis band) ------------------------
    const sign: -1 | 0 | 1 = betaDeg > o.transitionHysteresisDeg ? 1 : betaDeg < -o.transitionHysteresisDeg ? -1 : 0;
    if (sign !== 0) {
      if (this.signState !== 0 && sign !== this.signState) {
        this.transitions++;
        this.bump(o.multiplierPerTransition);
        res.callouts.push(this.fire('transition', t, this.transitions));
        if (this.transitions === o.manjiTransitions) res.callouts.push(this.fire('manji', t));
      }
      this.signState = sign;
    }

    // ---- base points ----------------------------------------------------------------------
    const af = angleFactor(absDeg, o);
    const sf = speedFactor(speedKmh, o);
    const rate = o.basePointsPerSecond * af * sf;
    this.base += rate * dt;
    const pts = rate * this.multiplier * dt;
    this.points += pts;
    res.points = pts;
    res.rate = rate * this.multiplier;
    this.lastRate = res.rate;

    // ---- time bookkeeping --------------------------------------------------------------
    this.durationS += dt;
    this.speedIntegral += speedKmh * dt;
    if (absDeg >= o.angleFloorDeg) {
      this.sustainedS += dt;
      const steps = Math.floor(this.sustainedS / o.sustainedStepS);
      while (this.sustainedSteps < steps) {
        this.sustainedSteps++;
        this.bump(o.multiplierPerSustained);
      }
      this.smoothWin.push(t, absDeg);
    } else {
      this.smoothWin.clear();
    }
    if (absDeg >= o.qualityAngleDeg) this.timeAtAngleS += dt;
    if (absDeg > this.peakDeg) {
      this.peakDeg = absDeg;
      this.peakT = t;
    }

    // ---- moment callouts ---------------------------------------------------------------
    if (!this.fired.has('extreme-angle') && extremeDeg >= o.extremeAngleDeg) res.callouts.push(this.fire('extreme-angle', t));
    if (!this.fired.has('long-drift') && this.sustainedS >= o.longDriftS) res.callouts.push(this.fire('long-drift', t));
    if (!this.fired.has('smooth') && this.smoothWin.elapsedS >= o.smoothWindowS && this.smoothWin.stdDev < o.smoothMaxStdDevDeg)
      res.callouts.push(this.fire('smooth', t));
    if (!this.fired.has('high-speed') && this.durationS >= o.highSpeedMinS && this.speedIntegral / this.durationS >= o.highSpeedKmh)
      res.callouts.push(this.fire('high-speed', t));

    for (const c of res.callouts) res.bonus += c.points;
    return res;
  }

  /** Current drift points including callouts (what the HUD's "this drift" counter shows). */
  get driftTotal(): number {
    return this.points + this.bonus;
  }

  get elapsedS(): number {
    return this.durationS;
  }

  get currentRate(): number {
    return this.lastRate;
  }

  /**
   * Close the drift. `spin` marks a spin ending (chain lost; no perfect-exit).
   * Returns the callouts fired at the end (perfect-exit) and the final statistics.
   */
  finish(endT: number, spin = false): { callouts: StyleCallout[]; stats: DriftStats } {
    const o = this.o;
    const out: StyleCallout[] = [];
    this.finished = true;
    if (spin) this.spun = true;
    const n = this.betaTrace.length;
    const exitRate = this.exitRate();
    const jit = this.jitter();
    const cleanExit = !this.spun && exitRate <= o.perfectExitMaxRateDegS && n > 1;
    if (cleanExit && !this.fired.has('perfect-exit')) out.push(this.fire('perfect-exit', endT));
    const stats: DriftStats = {
      id: this.id,
      startT: this.startT,
      endT,
      durationS: this.durationS,
      sustainedS: this.sustainedS,
      timeAtAngleS: this.timeAtAngleS,
      peakDeg: this.peakDeg,
      peakT: this.peakT,
      heldPeakDeg: this.heldPeakDeg,
      meanDeg: n ? this.betaTrace.reduce((a, b) => a + Math.abs(b), 0) / n : 0,
      jitterDeg: jit.jitterDeg,
      plateauS: jit.plateauS,
      exitRateDegS: exitRate,
      meanSpeedKmh: this.durationS > 0 ? this.speedIntegral / this.durationS : this.entrySpeedKmh,
      entrySpeedKmh: this.entrySpeedKmh,
      transitions: this.transitions,
      spun: this.spun,
      cleanExit,
      multiplierEnd: this.multiplier,
      peakMultiplier: this.peakMultiplier,
      chainIndex: this.chainIndex,
    };
    return { callouts: out, stats };
  }

  /** Max |dβ/dt| over the last exitWindowS, from the smoothed signed trace (deg/s). */
  private exitRate(): number {
    const o = this.o;
    const n = this.tTrace.length;
    if (n < 2) return 0;
    const tEnd = this.tTrace[n - 1];
    const lag = 0.2; // differentiate over 0.2 s to keep sensor noise out of the rate
    let worst = 0;
    let j = n - 1;
    for (let i = n - 1; i >= 0 && this.tTrace[i] >= tEnd - o.exitWindowS; i--) {
      while (j > 0 && this.tTrace[j] > this.tTrace[i] - lag) j--;
      const dt = this.tTrace[i] - this.tTrace[j];
      if (dt <= 1e-6) continue;
      const r = Math.abs(this.betaTrace[i] - this.betaTrace[j]) / dt;
      if (r > worst) worst = r;
    }
    return worst;
  }

  /**
   * Jitter = RMS of the residual of |β| around a local quadratic trend fitted over a centred
   * `jitterWindowS` window (a corner's angle hump is locally quadratic; wobble at 0.3–1 Hz
   * and correction kicks are not). Only the sustained plateau counts: |β| ≥ max(angleFloorDeg,
   * ½ peak), eroded by `jitterErodeS` on each side so entry/exit ramps, transition dips and the
   * initiation overshoot are neither evaluated nor used to fit the trend. Holds shorter than
   * 2 × jitterErodeS are not judged (plateauS = 0). Also reports the plateau seconds used.
   */
  private jitter(): { jitterDeg: number; plateauS: number } {
    const o = this.o;
    const n = this.betaTrace.length;
    if (n < 3) return { jitterDeg: 0, plateauS: 0 };
    const j = this.jitterWith(o.jitterWindowS, o.jitterErodeS);
    // no eroded plateau (a short drift): fall back to the un-eroded residual, but report 0 usable seconds
    const r = j.plateauS > 0 ? j : { jitterDeg: this.jitterWith(o.jitterWindowS, 0).jitterDeg, plateauS: 0 };
    if (!o.jitterNoiseCorrection) return r;
    const floor = this.noiseFloorDeg();
    return { jitterDeg: Math.sqrt(Math.max(0, r.jitterDeg * r.jitterDeg - floor * floor)), plateauS: r.plateauS };
  }

  /**
   * Sensor-noise floor of the smoothed trace: white noise σ estimated from first differences
   * of the RAW β (RMS(Δβ)/√2), divided by √(samples in the smoothing window).
   */
  private noiseFloorDeg(): number {
    const n = this.rawTrace.length;
    if (n < 10) return 0;
    let sq = 0;
    for (let i = 1; i < n; i++) {
      const d = this.rawTrace[i] - this.rawTrace[i - 1];
      sq += d * d;
    }
    const sigmaRaw = Math.sqrt(sq / (n - 1) / 2);
    const span = this.tTrace[n - 1] - this.tTrace[0];
    const rate = span > 0 ? (n - 1) / span : 100;
    const samples = Math.max(1, this.o.smoothingS * rate);
    return sigmaRaw / Math.sqrt(samples);
  }

  private jitterWith(windowS: number, erodeS: number): { jitterDeg: number; plateauS: number } {
    const o = this.o;
    const n = this.betaTrace.length;
    const tt = this.tTrace;
    const abs = new Float64Array(n);
    for (let i = 0; i < n; i++) abs[i] = Math.abs(this.betaTrace[i]);
    const half = windowS / 2;
    const gate = Math.max(o.angleFloorDeg, 0.5 * this.peakDeg);
    const sustained = new Uint8Array(n);
    for (let i = 0; i < n; i++) sustained[i] = abs[i] >= gate ? 1 : 0;
    const eligible = new Uint8Array(n);
    let lastBad = -Infinity;
    for (let i = 0; i < n; i++) {
      if (!sustained[i]) lastBad = tt[i];
      eligible[i] = sustained[i] && tt[i] - lastBad >= erodeS ? 1 : 0;
    }
    let nextBad = Infinity;
    for (let i = n - 1; i >= 0; i--) {
      if (!sustained[i]) nextBad = tt[i];
      if (eligible[i] && nextBad - tt[i] < erodeS) eligible[i] = 0;
    }
    // intended level changes (the driver moving to a new target angle without a sign flip)
    // are not wobble: samples whose 1 s-averaged level moves ≥ levelChangeDeg across
    // levelChangeSpanS are excluded from the judged plateau
    if (o.levelChangeDeg > 0) {
      const ma = new Float64Array(n);
      let l0 = 0;
      let h0 = 0;
      let sum0 = 0;
      for (let i = 0; i < n; i++) {
        while (h0 < n && tt[h0] <= tt[i] + 0.5) sum0 += abs[h0++];
        while (l0 < h0 && tt[l0] < tt[i] - 0.5) sum0 -= abs[l0++];
        ma[i] = sum0 / (h0 - l0);
      }
      const halfSpan = o.levelChangeSpanS / 2;
      let ja = 0;
      let jb = 0;
      for (let i = 0; i < n; i++) {
        if (!eligible[i]) continue;
        while (ja < n - 1 && tt[ja + 1] <= tt[i] - halfSpan) ja++;
        while (jb < n - 1 && tt[jb + 1] <= tt[i] + halfSpan) jb++;
        if (Math.abs(ma[jb] - ma[ja]) >= o.levelChangeDeg) eligible[i] = 0;
      }
    }
    let lo = 0;
    let hi = 0;
    let sq = 0;
    let cnt = 0;
    let plateauS = 0;
    for (let i = 0; i < n; i++) {
      const t = tt[i];
      while (hi < n && tt[hi] <= t + half) hi++;
      while (lo < hi && tt[lo] < t - half) lo++;
      if (!eligible[i]) continue;
      if (i > 0 && eligible[i - 1]) plateauS += t - tt[i - 1];
      // local quadratic least squares y = c0 + c1 τ + c2 τ², τ = t_j − t_i; residual = y_i − c0
      let s0 = 0;
      let s1 = 0;
      let s2 = 0;
      let s3 = 0;
      let s4 = 0;
      let y0 = 0;
      let y1 = 0;
      let y2 = 0;
      for (let j = lo; j < hi; j++) {
        if (!eligible[j]) continue; // the trend is fitted on the eroded plateau only: never through a dip, ramp or initiation overshoot
        const x = tt[j] - t;
        const x2 = x * x;
        const y = abs[j];
        s0 += 1;
        s1 += x;
        s2 += x2;
        s3 += x2 * x;
        s4 += x2 * x2;
        y0 += y;
        y1 += y * x;
        y2 += y * x2;
      }
      let fit: number;
      if (s0 < 6) fit = y0 / s0;
      else {
        // Cramer's rule on the 3×3 normal equations
        const det = s0 * (s2 * s4 - s3 * s3) - s1 * (s1 * s4 - s3 * s2) + s2 * (s1 * s3 - s2 * s2);
        if (Math.abs(det) < 1e-12) fit = y0 / s0;
        else fit = (y0 * (s2 * s4 - s3 * s3) - s1 * (y1 * s4 - s3 * y2) + s2 * (y1 * s3 - s2 * y2)) / det;
      }
      const r = abs[i] - fit;
      sq += r * r;
      cnt++;
    }
    return { jitterDeg: cnt > 0 ? Math.sqrt(sq / cnt) : 0, plateauS };
  }
}
