/**
 * Test / analysis helpers for the slip estimator. NOT part of the engine's public surface —
 * imports the simulator, so it is only used by vitest and tools/analysis.
 *
 * Vehicle-frame samples are built from the simulator's phone-frame motion using the TRUE
 * mount rotation (v_vehicle = run.mount · v_phone): realistic gyro bias, noise, vibration
 * and mount wobble are all present, calibration error is not (the mount module owns that).
 */
import type { SlipState, TruthSample } from '../types';
import { degToRad, radToDeg, wrapAngle } from '../types';
import type { SimulatedRun } from '../../sim';
import { apply } from '../../sim/mat3';
import { SlipEstimator, type SlipMotionInput, type SlipOptions } from './estimator';

/** Rotate phone-frame motion into the vehicle frame with the TRUE mount; `gravity` is the rotated OS gravity estimate. */
export function vehicleSamplesFromRun(run: SimulatedRun, withGravity = true): SlipMotionInput[] {
  const out: SlipMotionInput[] = new Array(run.motion.length);
  for (let i = 0; i < run.motion.length; i++) {
    const m = run.motion[i];
    const a = apply(run.mount, m.accel);
    const w = apply(run.mount, m.rotationRate);
    const g = apply(run.mount, m.gravity);
    out[i] = {
      t: m.t,
      ax: a.x,
      ay: a.y,
      az: a.z,
      yawRate: w.z,
      rollRate: w.x,
      pitchRate: w.y,
      calibrationQuality: 1,
      ...(withGravity ? { gravity: g } : {}),
    };
  }
  return out;
}

/** Feed motion and GPS interleaved by time (a fix is pushed before the first motion sample at or after its receive time). */
export function runEstimator(run: SimulatedRun, opts: Partial<SlipOptions> = {}, est = new SlipEstimator(opts), withGravity = true): SlipState[] {
  const motion = vehicleSamplesFromRun(run, withGravity);
  const gps = [...run.gps].sort((a, b) => a.t - b.t);
  const states: SlipState[] = new Array(motion.length);
  let j = 0;
  for (let i = 0; i < motion.length; i++) {
    while (j < gps.length && gps[j].t <= motion[i].t) est.pushGps(gps[j++]);
    states[i] = est.pushMotion(motion[i]);
  }
  return states;
}

export interface SlipMetrics {
  name: string;
  /** Evaluation window (s): from 1 s after the estimator first reported valid, to the first truth discontinuity. */
  fromT: number;
  toT: number;
  driftRmsDeg: number;
  driftPeakDeg: number;
  straightRmsDeg: number;
  straightPeakDeg: number;
  peakDeg: number;
  lagMs: number;
  signErrors: number;
  signSamples: number;
  speedRms: number;
  posRms: number;
  /** Fraction of drift samples where |err| < 2·betaSigma (sigma honesty). */
  sigmaCoverage: number;
  meanSigmaDeg: number;
  driftSamples: number;
  straightSamples: number;
  validFraction: number;
  allFinite: boolean;
}

export const DRIFT_THRESHOLD_DEG = 8;
export const STRAIGHT_THRESHOLD_DEG = 3;
export const SIGN_THRESHOLD_DEG = 12;

export function evaluate(name: string, run: SimulatedRun, states: SlipState[], opts: { originOffset?: { x: number; y: number } } = {}): SlipMetrics {
  const truth = run.truth;
  const n = Math.min(truth.length, states.length);
  let firstValid = -1;
  for (let i = 0; i < n; i++) {
    if (states[i].valid) {
      firstValid = i;
      break;
    }
  }
  const fromT = firstValid >= 0 ? states[firstValid].t + 1 : Infinity;
  // The simulator's truth can teleport (e.g. a closed-track run that ends mid-drift snaps
  // heading/β to the centre-line in one sample). No sensor can see that, so the window ends
  // at the first truth heading jump larger than 5° in one 10 ms step.
  let toT = Infinity;
  for (let i = 1; i < n; i++) {
    if (truth[i].t <= fromT) continue;
    if (Math.abs(wrapAngle(truth[i].heading - truth[i - 1].heading)) > degToRad(5)) {
      toT = truth[i].t;
      break;
    }
  }
  let allFinite = true;
  let dSq = 0;
  let dN = 0;
  let dPeak = 0;
  let sSq = 0;
  let sN = 0;
  let sPeak = 0;
  let peak = 0;
  let signErr = 0;
  let signN = 0;
  let vSq = 0;
  let vN = 0;
  let pSq = 0;
  let pN = 0;
  let cover = 0;
  let sigSum = 0;
  let validN = 0;
  let winN = 0;
  const off = opts.originOffset ?? { x: 0, y: 0 };
  const errs: number[] = [];
  const bt: number[] = [];
  const be: number[] = [];
  for (let i = 0; i < n; i++) {
    const s = states[i];
    const tr = truth[i];
    const vals = [s.beta, s.betaSigma, s.heading, s.course, s.speed, s.yawRate, s.ay, s.ax, s.x, s.y];
    for (const v of vals) if (!Number.isFinite(v)) allFinite = false;
    if (s.t < fromT || s.t >= toT) continue;
    winN++;
    if (s.valid) validN++;
    const err = radToDeg(s.beta - tr.beta);
    const bTrue = radToDeg(tr.beta);
    errs.push(err);
    bt.push(tr.beta);
    be.push(s.beta);
    if (tr.speed > 2) {
      peak = Math.max(peak, Math.abs(err));
      if (Math.abs(bTrue) > DRIFT_THRESHOLD_DEG) {
        dSq += err * err;
        dN++;
        dPeak = Math.max(dPeak, Math.abs(err));
        if (Math.abs(err) < 2 * radToDeg(s.betaSigma)) cover++;
        sigSum += radToDeg(s.betaSigma);
      } else if (Math.abs(bTrue) < STRAIGHT_THRESHOLD_DEG) {
        sSq += err * err;
        sN++;
        sPeak = Math.max(sPeak, Math.abs(err));
      }
      if (Math.abs(bTrue) > SIGN_THRESHOLD_DEG) {
        signN++;
        if (Math.sign(s.beta) !== Math.sign(tr.beta)) signErr++;
      }
    }
    const ve = s.speed - tr.speed;
    vSq += ve * ve;
    vN++;
    const px = s.x + off.x - tr.x;
    const py = s.y + off.y - tr.y;
    pSq += px * px + py * py;
    pN++;
  }
  return {
    name,
    fromT,
    toT,
    driftRmsDeg: dN ? Math.sqrt(dSq / dN) : NaN,
    driftPeakDeg: dPeak,
    straightRmsDeg: sN ? Math.sqrt(sSq / sN) : NaN,
    straightPeakDeg: sPeak,
    peakDeg: peak,
    lagMs: estimateLagMs(bt, be, 0.01),
    signErrors: signErr,
    signSamples: signN,
    speedRms: vN ? Math.sqrt(vSq / vN) : NaN,
    posRms: pN ? Math.sqrt(pSq / pN) : NaN,
    sigmaCoverage: dN ? cover / dN : NaN,
    meanSigmaDeg: dN ? sigSum / dN : NaN,
    driftSamples: dN,
    straightSamples: sN,
    validFraction: winN ? validN / winN : 0,
    allFinite,
  };
}

/**
 * Lag of `est` relative to `truth` via normalised cross-correlation over ±maxLag samples,
 * with parabolic sub-sample refinement. Positive = estimate lags the truth.
 */
export function estimateLagMs(truth: number[], est: number[], dt: number, maxLagS = 0.4): number {
  const n = Math.min(truth.length, est.length);
  if (n < 100) return NaN;
  let mt = 0;
  let me = 0;
  for (let i = 0; i < n; i++) {
    mt += truth[i];
    me += est[i];
  }
  mt /= n;
  me /= n;
  const maxLag = Math.round(maxLagS / dt);
  const corr: number[] = [];
  let best = -Infinity;
  let bestK = 0;
  for (let k = -maxLag; k <= maxLag; k++) {
    let acc = 0;
    let n1 = 0;
    let n2 = 0;
    // est[i] ≈ truth[i - k]  →  k > 0 means the estimate lags
    for (let i = Math.max(0, k); i < Math.min(n, n + k); i++) {
      const a = est[i] - me;
      const b = truth[i - k] - mt;
      acc += a * b;
      n1 += a * a;
      n2 += b * b;
    }
    const c = n1 > 0 && n2 > 0 ? acc / Math.sqrt(n1 * n2) : 0;
    corr.push(c);
    if (c > best) {
      best = c;
      bestK = k;
    }
  }
  const idx = bestK + maxLag;
  let lag = bestK;
  if (idx > 0 && idx < corr.length - 1) {
    const y0 = corr[idx - 1];
    const y1 = corr[idx];
    const y2 = corr[idx + 1];
    const den = y0 - 2 * y1 + y2;
    if (Math.abs(den) > 1e-12) lag += (0.5 * (y0 - y2)) / den;
  }
  return lag * dt * 1000;
}

/** Offset that maps the estimator's local frame (origin = first fix) onto the track's ENU frame. */
export function originOffset(run: SimulatedRun, est: SlipEstimator): { x: number; y: number } {
  const o = est.origin;
  if (!o) return { x: 0, y: 0 };
  const mPerDegLat = 111132.954;
  const mPerDegLon = mPerDegLat * Math.cos((run.originLat * Math.PI) / 180);
  return { x: (o.lon - run.originLon) * mPerDegLon, y: (o.lat - run.originLat) * mPerDegLat };
}

export function formatMetricsTable(rows: SlipMetrics[]): string {
  const head = ['run', 'window s', 'drift RMS°', 'drift pk°', 'str RMS°', 'str pk°', 'lag ms', 'sign err', 'spd RMS', 'pos RMS', 'σ cov', 'σ mean°', 'valid%'];
  const lines = [head.join(' | ')];
  for (const r of rows) {
    lines.push(
      [
        r.name.padEnd(22),
        `${r.fromT.toFixed(1)}-${Number.isFinite(r.toT) ? r.toT.toFixed(1) : 'end'}`,
        r.driftRmsDeg.toFixed(2),
        r.driftPeakDeg.toFixed(2),
        r.straightRmsDeg.toFixed(2),
        r.straightPeakDeg.toFixed(2),
        r.lagMs.toFixed(0),
        `${r.signErrors}/${r.signSamples}`,
        r.speedRms.toFixed(2),
        r.posRms.toFixed(2),
        r.sigmaCoverage.toFixed(2),
        r.meanSigmaDeg.toFixed(2),
        (100 * r.validFraction).toFixed(0),
      ].join(' | '),
    );
  }
  return lines.join('\n');
}

export type { TruthSample };
