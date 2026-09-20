/**
 * DriftAccumulator — the ONE integrator both `LiveScorer` and `scoreDrift` run.
 *
 * It consumes SlipStates one at a time (causally), accrues base points, grows the
 * multiplier, detects transitions / spins, fires callouts at their moment, and on
 * `finish()` computes the per-drift statistics the components need. Because the live
 * and the offline paths feed the same samples through this same code, a replay
 * reproduces the live accumulation exactly (not "within 1 %": bit-for-bit).
 *
 * ── Rules that are NOT defined here ───────────────────────────────────────────────────────
 * A direction change and a spin are the detector's definitions, imported from
 * `detect/options.ts` (`TransitionCounter`, `SPIN_ANGLE_DEG`). The scorer used to carry its
 * own, looser versions — a bare ±8° sign change with no dwell and no yaw gate, and an 85°
 * spin threshold against the detector's 75° — which paid 570 000 points for sawing the wheel
 * and reported a clean exit for a drift the detector had already ended as a spin.
 *
 * ── Real-time contract ────────────────────────────────────────────────────────────────────
 * `step()` is called at 100 Hz. It allocates NOTHING on a quiet sample: the result object is
 * reused, its `callouts` is a shared frozen empty array unless something fires, and every
 * trailing window is a typed-array ring buffer.
 */
import type { SlipState, StyleCallout, StyleCalloutKind } from '../types';
import { radToDeg } from '../types';
import { TransitionCounter, type TransitionRule } from '../detect/options';
import { angleFactor, calloutLabel, KMH, speedFactor, type ScoreOptions } from './rules';

/** Chain context handed to a drift when it starts. */
export interface DriftContext {
  /** Multiplier carried in from the chain (1.0 for a fresh chain). */
  multiplier?: number;
  /** Drifts already in the chain before this one (0 for a fresh chain). */
  chainDrifts?: number;
  /** Force the spin flag (e.g. from a detector that knows better — `DriftEvent.spin`). */
  spin?: boolean;
  /**
   * 1 where the integrity monitor believed the slide, 0 where it did not, indexed like the
   * `states` array `scoreDrift` is given. Absent = believe everything.
   */
  plausible?: Uint8Array | null;
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
  /** Seconds of plateau the jitter was measured on (0 = the angle never settled at all). */
  plateauS: number;
  /** Max |dβ/dt| (deg/s) over the last exitWindowS of the drift. */
  exitRateDegS: number;
  meanSpeedKmh: number;
  entrySpeedKmh: number;
  transitions: number;
  spun: boolean;
  cleanExit: boolean;
  /** Seconds the integrity monitor refused to believe this slide (mount loose, physics, …). */
  implausibleS: number;
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

/** Shared, never-written empty callout list: a quiet 100 Hz sample allocates nothing. */
const NO_CALLOUTS: StyleCallout[] = [];

const DEG2RAD = Math.PI / 180;

/** Trailing time-window moving average over a typed-array ring. */
class Trailing {
  private ts: Float64Array;
  private vs: Float64Array;
  private head = 0;
  private tail = 0;
  private sum = 0;
  constructor(private windowS: number) {
    this.ts = new Float64Array(64);
    this.vs = new Float64Array(64);
  }
  private grow(): void {
    const n = this.ts.length;
    const ts = new Float64Array(n * 2);
    const vs = new Float64Array(n * 2);
    let k = 0;
    for (let i = this.tail; i !== this.head; i = (i + 1) % n, k++) {
      ts[k] = this.ts[i];
      vs[k] = this.vs[i];
    }
    this.ts = ts;
    this.vs = vs;
    this.tail = 0;
    this.head = k;
  }
  push(t: number, v: number): number {
    const cap = this.ts.length;
    if ((this.head + 1) % cap === this.tail) {
      this.grow();
      return this.push(t, v);
    }
    this.ts[this.head] = t;
    this.vs[this.head] = v;
    this.head = (this.head + 1) % cap;
    this.sum += v;
    let n = (this.head - this.tail + cap) % cap;
    while (n > 1 && this.ts[this.tail] < t - this.windowS) {
      this.sum -= this.vs[this.tail];
      this.tail = (this.tail + 1) % cap;
      n--;
    }
    return this.sum / n;
  }
}

/** Trailing window mean & std-dev that resets when `clear()` is called. */
class TrailingStats {
  private ts: Float64Array;
  private vs: Float64Array;
  private head = 0;
  private tail = 0;
  private sum = 0;
  private sumSq = 0;
  private startT = NaN;
  private lastT = NaN;
  constructor(private windowS: number) {
    this.ts = new Float64Array(64);
    this.vs = new Float64Array(64);
  }
  clear(): void {
    this.head = 0;
    this.tail = 0;
    this.sum = 0;
    this.sumSq = 0;
    this.startT = NaN;
    this.lastT = NaN;
  }
  private grow(): void {
    const n = this.ts.length;
    const ts = new Float64Array(n * 2);
    const vs = new Float64Array(n * 2);
    let k = 0;
    for (let i = this.tail; i !== this.head; i = (i + 1) % n, k++) {
      ts[k] = this.ts[i];
      vs[k] = this.vs[i];
    }
    this.ts = ts;
    this.vs = vs;
    this.tail = 0;
    this.head = k;
  }
  push(t: number, v: number): void {
    if (Number.isNaN(this.startT)) this.startT = t;
    this.lastT = t;
    const cap = this.ts.length;
    if ((this.head + 1) % cap === this.tail) {
      this.grow();
      this.push(t, v);
      return;
    }
    this.ts[this.head] = t;
    this.vs[this.head] = v;
    this.head = (this.head + 1) % cap;
    this.sum += v;
    this.sumSq += v * v;
    while (this.count > 1 && this.ts[this.tail] < t - this.windowS) {
      const x = this.vs[this.tail];
      this.sum -= x;
      this.sumSq -= x * x;
      this.tail = (this.tail + 1) % cap;
    }
  }
  private get count(): number {
    const cap = this.ts.length;
    return (this.head - this.tail + cap) % cap;
  }
  /** Seconds since the window was (re)started — i.e. of uninterrupted sustained angle. */
  get elapsedS(): number {
    return Number.isNaN(this.startT) ? 0 : this.lastT - this.startT;
  }
  get stdDev(): number {
    const n = this.count;
    if (n < 2) return 0;
    const mean = this.sum / n;
    const v = Math.max(0, this.sumSq / n - mean * mean);
    return Math.sqrt(v);
  }
}

/** Growable Float64 column (the per-drift traces the jitter fit needs). */
class Column {
  private buf = new Float64Array(1024);
  length = 0;
  push(v: number): void {
    if (this.length === this.buf.length) {
      const b = new Float64Array(this.buf.length * 2);
      b.set(this.buf);
      this.buf = b;
    }
    this.buf[this.length++] = v;
  }
  get(i: number): number {
    return this.buf[i];
  }
  get data(): Float64Array {
    return this.buf;
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
  private implausibleS = 0;
  private peakDeg = 0;
  private peakT: number;
  private speedIntegral = 0;
  private entrySpeedKmh = 0;
  private smoother: Trailing;
  private holder: Trailing;
  private extremeHolder: Trailing;
  private heldPeakDeg = 0;
  private smoothWin: TrailingStats;
  private fired = new Set<StyleCalloutKind>();
  private tTrace = new Column();
  private betaTrace = new Column(); // signed, smoothed, degrees
  private rawTrace = new Column(); // signed, raw, degrees
  private ctxSpin: boolean | undefined;
  private tc: TransitionCounter | null = null;
  private paidTransitions = 0;
  /** Reused across steps: `step()` must not allocate on a quiet sample. */
  private res: StepResult = { points: 0, bonus: 0, callouts: NO_CALLOUTS, rate: 0 };

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

  /** The detector's transition rule, with this scorer's overrides applied. */
  private get rule(): TransitionRule {
    return this.o.transitionRule;
  }

  private fire(kind: StyleCalloutKind, t: number, n = 1): void {
    const o = this.o;
    // every callout is worth the multiplier the driver has EARNED: chaining compounds instead of
    // paying a flat participation fee, and a callout can no longer out-earn the drift it sits in
    const points = o.calloutPoints[kind] * (o.calloutsUseMultiplier ? this.multiplier : 1);
    const c: StyleCallout = { t, kind, label: calloutLabel(kind, n), points };
    this.callouts.push(c);
    this.bonus += points;
    if (kind !== 'transition') this.fired.add(kind);
    if (this.res.callouts === NO_CALLOUTS) this.res.callouts = [];
    this.res.callouts.push(c);
    this.res.bonus += points;
  }

  private bump(delta: number): void {
    this.multiplier = Math.min(this.o.multiplierCap, this.multiplier + delta);
    if (this.multiplier > this.peakMultiplier) this.peakMultiplier = this.multiplier;
  }

  /**
   * One sample. `plausible` is the integrity monitor's verdict for this instant: while it is
   * false the slide is not believed (phone loose in its mount, impossible physics, no GPS…)
   * and NO points accrue — exactly what the detector does with `valid:false` samples.
   */
  step(s: SlipState, plausible = true): StepResult {
    const o = this.o;
    const res = this.res;
    res.points = 0;
    res.bonus = 0;
    res.rate = 0;
    if (res.callouts !== NO_CALLOUTS) res.callouts = NO_CALLOUTS;
    if (this.finished || this.spun) return res;
    const t = s.t;
    const first = this.lastT === null;
    let dt = first ? 0 : t - (this.lastT as number);
    if (dt < 0) dt = 0;
    if (dt > o.maxDtS) dt = 0; // a gap: no points for time we did not observe
    this.lastT = t;
    if (!plausible) {
      this.implausibleS += dt;
      dt = 0; // the integrity monitor does not believe this instant: it earns nothing
    }

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
    const sign: 1 | -1 = betaDeg < 0 ? -1 : 1;

    if (first) {
      this.entrySpeedKmh = speedKmh;
      this.tc = new TransitionCounter(this.rule, t, sign, s.yawRate);
      this.fire('initiation', t);
      if (this.chainIndex >= o.linkDrifts) this.fire('link', t, this.chainIndex);
    }

    // ---- spin ---------------------------------------------------------------------------
    // ONE threshold with the detector (SPIN_ANGLE_DEG), and the detector's own verdict wins
    if (absDeg >= o.spinAngleDeg || this.ctxSpin === true) {
      this.spun = true;
      return res;
    }

    // ---- transitions (the detector's rule: angle + dwell on both sides + yaw behind it) ----
    if (this.tc && this.tc.push(t, absDeg * DEG2RAD, sign, s.yawRate)) {
      this.transitions++;
      this.bump(o.multiplierPerTransition);
      // the bonus is capped per drift; beyond the cap a transition still grows the multiplier,
      // still counts for MANJI and still counts for style — it just stops paying cash
      if (this.paidTransitions < o.transitionBonusMaxPerDrift) {
        this.paidTransitions++;
        this.fire('transition', t, this.transitions);
      }
      if (this.transitions === o.manjiTransitions) this.fire('manji', t);
    }

    // ---- base points ----------------------------------------------------------------------
    const af = angleFactor(absDeg, o);
    const sf = speedFactor(speedKmh, o);
    const rate = o.basePointsPerSecond * af * sf;
    this.base += rate * dt;
    const pts = rate * this.multiplier * dt;
    this.points += pts;
    res.points = pts;
    res.rate = plausible ? rate * this.multiplier : 0;
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
    if (!this.fired.has('extreme-angle') && extremeDeg >= o.extremeAngleDeg) this.fire('extreme-angle', t);
    if (!this.fired.has('long-drift') && this.sustainedS >= o.longDriftS) this.fire('long-drift', t);
    if (!this.fired.has('smooth') && this.smoothWin.elapsedS >= o.smoothWindowS && this.smoothWin.stdDev < o.smoothMaxStdDevDeg) this.fire('smooth', t);
    if (!this.fired.has('high-speed') && this.durationS >= o.highSpeedMinS && this.speedIntegral / this.durationS >= o.highSpeedKmh) this.fire('high-speed', t);

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

  /** Seconds of this drift the integrity monitor refused to believe. */
  get implausibleSeconds(): number {
    return this.implausibleS;
  }

  /**
   * Close the drift. `spin` marks a spin ending (chain lost; no perfect-exit).
   * Returns the callouts fired at the end (perfect-exit) and the final statistics.
   */
  finish(endT: number, spin = false): { callouts: StyleCallout[]; stats: DriftStats } {
    const o = this.o;
    this.finished = true;
    if (spin) this.spun = true;
    const n = this.betaTrace.length;
    const exitRate = this.exitRate();
    const jit = this.jitter();
    const cleanExit = !this.spun && exitRate <= o.cleanExitMaxRateDegS && n > 1;
    const perfect = !this.spun && exitRate <= o.perfectExitMaxRateDegS && n > 1;
    const before = this.callouts.length;
    if (perfect && !this.fired.has('perfect-exit')) {
      if (this.res.callouts !== NO_CALLOUTS) this.res.callouts = NO_CALLOUTS;
      this.fire('perfect-exit', endT);
    }
    const out = this.callouts.slice(before);
    if (this.res.callouts !== NO_CALLOUTS) this.res.callouts = NO_CALLOUTS;
    let meanSum = 0;
    for (let i = 0; i < n; i++) meanSum += Math.abs(this.betaTrace.get(i));
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
      meanDeg: n ? meanSum / n : 0,
      jitterDeg: jit.jitterDeg,
      plateauS: jit.plateauS,
      exitRateDegS: exitRate,
      meanSpeedKmh: this.durationS > 0 ? this.speedIntegral / this.durationS : this.entrySpeedKmh,
      entrySpeedKmh: this.entrySpeedKmh,
      transitions: this.transitions,
      spun: this.spun,
      cleanExit,
      implausibleS: this.implausibleS,
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
    const tt = this.tTrace;
    const bb = this.betaTrace;
    const tEnd = tt.get(n - 1);
    const lag = 0.2; // differentiate over 0.2 s to keep sensor noise out of the rate
    let worst = 0;
    let j = n - 1;
    for (let i = n - 1; i >= 0 && tt.get(i) >= tEnd - o.exitWindowS; i--) {
      while (j > 0 && tt.get(j) > tt.get(i) - lag) j--;
      const dt = tt.get(i) - tt.get(j);
      if (dt <= 1e-6) continue;
      const r = Math.abs(bb.get(i) - bb.get(j)) / dt;
      if (r > worst) worst = r;
    }
    return worst;
  }

  /**
   * Jitter = RMS of the residual of |β| around a local quadratic trend fitted over a centred
   * `jitterWindowS` window (a corner's angle hump is locally quadratic; wobble at 0.3–1 Hz
   * and correction kicks are not). Only the sustained plateau counts: |β| ≥ max(angleFloorDeg,
   * ½ peak), eroded on each side so entry/exit ramps, transition dips and the initiation
   * overshoot are neither evaluated nor used to fit the trend. The erosion is ADAPTIVE — at
   * most `jitterErodeFraction` of the longest hold on each side — so a short-but-real hold is
   * still judged instead of being dropped, and `plateauS` is only 0 when the angle genuinely
   * never settled. That case is scored as unsteady by the caller, never dropped.
   */
  private jitter(): { jitterDeg: number; plateauS: number } {
    const o = this.o;
    const n = this.betaTrace.length;
    if (n < 3) return { jitterDeg: 0, plateauS: 0 };
    const j = this.jitterWith(o.jitterWindowS, o.jitterErodeS);
    // no eroded plateau at all (the angle never settled): fall back to the un-eroded residual
    // and report 0 usable seconds, which the caller scores as BAD rather than dropping.
    const r = j.plateauS > 0 ? j : { jitterDeg: this.jitterWith(o.jitterWindowS, 0).jitterDeg, plateauS: 0 };
    if (!o.jitterNoiseCorrection) return r;
    // Bounded: the noise floor may never remove more than `noiseCorrectionMaxFraction` of the
    // measured jitter. Subtracting an unbounded estimate in quadrature made a NOISIER trace
    // score steadier than a clean one (vibration 0 → 58.8, vibration 1 → 87.8).
    const floor = Math.min(this.noiseFloorDeg(), o.noiseCorrectionMaxFraction * r.jitterDeg);
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
      const d = this.rawTrace.get(i) - this.rawTrace.get(i - 1);
      sq += d * d;
    }
    const sigmaRaw = Math.sqrt(sq / (n - 1) / 2);
    const span = this.tTrace.get(n - 1) - this.tTrace.get(0);
    const rate = span > 0 ? (n - 1) / span : 100;
    const samples = Math.max(1, this.o.smoothingS * rate);
    return sigmaRaw / Math.sqrt(samples);
  }

  private jitterWith(windowS: number, erodeS: number): { jitterDeg: number; plateauS: number } {
    const o = this.o;
    const n = this.betaTrace.length;
    const tt = this.tTrace.data;
    const abs = new Float64Array(n);
    for (let i = 0; i < n; i++) abs[i] = Math.abs(this.betaTrace.get(i));
    const half = windowS / 2;
    const gate = Math.max(o.angleFloorDeg, 0.5 * this.peakDeg);
    const sustained = new Uint8Array(n);
    for (let i = 0; i < n; i++) sustained[i] = abs[i] >= gate ? 1 : 0;
    // adaptive erosion: never erode away more than a fraction of the longest hold, so a 5 s
    // corner is judged on its middle instead of being thrown out for being shorter than 2×2 s
    if (erodeS > 0 && o.jitterErodeFraction > 0) {
      let longest = 0;
      let runStart = -1;
      for (let i = 0; i < n; i++) {
        if (sustained[i]) {
          if (runStart < 0) runStart = i;
          const len = tt[i] - tt[runStart];
          if (len > longest) longest = len;
        } else runStart = -1;
      }
      erodeS = Math.min(erodeS, o.jitterErodeFraction * longest);
    }
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
