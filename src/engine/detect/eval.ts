import { type DriftEvent, type SlipState, type TruthSample, degToRad, radToDeg } from '../types';

/**
 * Evaluation helpers for the detector: build a realistic SlipState stream from simulator
 * ground truth (estimator noise, lag, GPS gaps), derive the truth events a judge would
 * score, and compare. Pure — no simulator import, so the harness can reuse it.
 */

/** mulberry32 + Box–Muller, so evaluation streams are reproducible. */
export class EvalRng {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0 || 0x9e3779b9;
  }
  next(): number {
    let t = (this.s += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  gauss(): number {
    let u = 0;
    let v = 0;
    while (u === 0) u = this.next();
    while (v === 0) v = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
}

export interface NoiseOptions {
  seed: number;
  /** 1σ white noise added to β, radians. */
  noiseRad: number;
  /** Estimator lag, seconds: the state at t reports the truth at t − delayS. */
  delayS: number;
  /** Mean spacing of `valid:false` gaps (0 = none) and their length. */
  gapEveryS: number;
  gapLenS: number;
  /** Speed floor below which the estimator reports valid:false. */
  validSpeed: number;
}

export const DEFAULT_NOISE: NoiseOptions = { seed: 1, noiseRad: degToRad(1.5), delayS: 0.08, gapEveryS: 4, gapLenS: 0.3, validSpeed: 2 };

/** Turn simulator truth into the SlipState stream a (noisy, lagging) estimator would produce. */
export function noisyStream(truth: TruthSample[], opts: Partial<NoiseOptions> = {}): SlipState[] {
  const o = { ...DEFAULT_NOISE, ...opts };
  const rng = new EvalRng(o.seed * 2654435761 + 12345);
  const n = truth.length;
  if (n === 0) return [];
  const dt = n > 1 ? (truth[n - 1].t - truth[0].t) / (n - 1) : 0.01;
  const delayN = Math.round(o.delayS / dt);
  const out: SlipState[] = new Array(n);
  let nextGapAt = o.gapEveryS > 0 ? o.gapEveryS * (0.5 + rng.next()) : Infinity;
  let gapUntil = -Infinity;
  for (let i = 0; i < n; i++) {
    const t = truth[i].t;
    const src = truth[Math.max(0, i - delayN)];
    if (t >= nextGapAt) {
      gapUntil = t + o.gapLenS;
      nextGapAt = t + o.gapLenS + o.gapEveryS * (0.5 + rng.next());
    }
    const inGap = t < gapUntil;
    const valid = src.speed > o.validSpeed && !inGap;
    out[i] = {
      t,
      beta: src.beta + rng.gauss() * o.noiseRad,
      betaSigma: o.noiseRad,
      heading: src.heading,
      course: src.course,
      speed: src.speed,
      yawRate: src.yawRate,
      ay: src.ay,
      ax: src.ax,
      x: src.x,
      y: src.y,
      valid,
    };
  }
  return out;
}

export interface TruthEvent {
  startT: number;
  endT: number;
  /** Peak |β|, radians. */
  peak: number;
  /** Sign changes of β inside the interval with |β| above `transitionAngle` on both sides. */
  transitions: number;
}

export interface TruthOptions {
  mergeGapS: number;
  minDurationS: number;
  transitionAngle: number;
}

export const DEFAULT_TRUTH: TruthOptions = { mergeGapS: 1.0, minDurationS: 0.7, transitionAngle: degToRad(5) };

/** Contiguous `drifting` intervals, merged across short gaps, twitches dropped. */
export function truthEvents(truth: TruthSample[], opts: Partial<TruthOptions> = {}): TruthEvent[] {
  const o = { ...DEFAULT_TRUTH, ...opts };
  const raw: Array<{ ia: number; ib: number }> = [];
  let cur: { ia: number; ib: number } | null = null;
  for (let i = 0; i < truth.length; i++) {
    if (truth[i].drifting) {
      if (cur) cur.ib = i;
      else cur = { ia: i, ib: i };
    } else if (cur) {
      raw.push(cur);
      cur = null;
    }
  }
  if (cur) raw.push(cur);
  const merged: Array<{ ia: number; ib: number }> = [];
  for (const r of raw) {
    const last = merged[merged.length - 1];
    if (last && truth[r.ia].t - truth[last.ib].t < o.mergeGapS) last.ib = r.ib;
    else merged.push({ ...r });
  }
  const out: TruthEvent[] = [];
  for (const m of merged) {
    const startT = truth[m.ia].t;
    const endT = truth[m.ib].t;
    if (endT - startT < o.minDurationS) continue;
    let peak = 0;
    let transitions = 0;
    let lastSign = 0;
    for (let i = m.ia; i <= m.ib; i++) {
      const b = truth[i].beta;
      const a = Math.abs(b);
      if (a > peak) peak = a;
      if (a > o.transitionAngle) {
        const s = Math.sign(b);
        if (lastSign !== 0 && s !== lastSign) transitions++;
        lastSign = s;
      }
    }
    out.push({ startT, endT, peak, transitions });
  }
  return out;
}

export interface MatchedPair {
  event: DriftEvent;
  truth: TruthEvent;
  iou: number;
}

export interface RunMetrics {
  name: string;
  truthN: number;
  detectedN: number;
  matched: number;
  precision: number;
  recall: number;
  /** Seconds; entry = event.startT − truth.startT, exit = event.endT − truth.endT. */
  entryMean: number;
  entryMax: number;
  exitMean: number;
  exitMax: number;
  /** Fraction of matched events whose transition count equals the truth's. */
  transitionsExact: number;
  transitionsMismatched: number;
  /** Radians, over matched pairs. */
  peakErrMean: number;
  peakErrMax: number;
  pairs: MatchedPair[];
  unmatchedEvents: DriftEvent[];
  unmatchedTruth: TruthEvent[];
}

function iou(a0: number, a1: number, b0: number, b1: number): number {
  const inter = Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
  const union = Math.max(a1, b1) - Math.min(a0, b0);
  return union > 0 ? inter / union : 0;
}

/** Greedy one-to-one matching by descending IoU, threshold `iouMin`. */
export function evaluateRun(name: string, events: DriftEvent[], truth: TruthEvent[], iouMin = 0.5): RunMetrics {
  const cands: Array<{ e: number; t: number; iou: number }> = [];
  for (let e = 0; e < events.length; e++)
    for (let t = 0; t < truth.length; t++) {
      const v = iou(events[e].startT, events[e].endT, truth[t].startT, truth[t].endT);
      if (v >= iouMin) cands.push({ e, t, iou: v });
    }
  cands.sort((a, b) => b.iou - a.iou);
  const usedE = new Set<number>();
  const usedT = new Set<number>();
  const pairs: MatchedPair[] = [];
  for (const c of cands) {
    if (usedE.has(c.e) || usedT.has(c.t)) continue;
    usedE.add(c.e);
    usedT.add(c.t);
    pairs.push({ event: events[c.e], truth: truth[c.t], iou: c.iou });
  }
  pairs.sort((a, b) => a.event.startT - b.event.startT);
  const entry = pairs.map((p) => p.event.startT - p.truth.startT);
  const exit = pairs.map((p) => p.event.endT - p.truth.endT);
  const peakErr = pairs.map((p) => p.event.peakAngle - p.truth.peak);
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
  const maxAbs = (xs: number[]) => (xs.length ? Math.max(...xs.map(Math.abs)) : NaN);
  const exact = pairs.filter((p) => p.event.transitions === p.truth.transitions).length;
  return {
    name,
    truthN: truth.length,
    detectedN: events.length,
    matched: pairs.length,
    precision: events.length ? pairs.length / events.length : 1,
    recall: truth.length ? pairs.length / truth.length : 1,
    entryMean: mean(entry),
    entryMax: maxAbs(entry),
    exitMean: mean(exit),
    exitMax: maxAbs(exit),
    transitionsExact: pairs.length ? exact / pairs.length : 1,
    transitionsMismatched: pairs.length - exact,
    peakErrMean: mean(peakErr.map(Math.abs)),
    peakErrMax: maxAbs(peakErr),
    pairs,
    unmatchedEvents: events.filter((_, i) => !usedE.has(i)),
    unmatchedTruth: truth.filter((_, i) => !usedT.has(i)),
  };
}

/** Pool several runs into one row (latencies weighted by matched pairs). */
export function aggregate(rows: RunMetrics[], name = 'ALL'): RunMetrics {
  const pairs = rows.flatMap((r) => r.pairs);
  const events = rows.flatMap((r) => [...r.pairs.map((p) => p.event), ...r.unmatchedEvents]);
  const truth = rows.flatMap((r) => [...r.pairs.map((p) => p.truth), ...r.unmatchedTruth]);
  const entry = pairs.map((p) => p.event.startT - p.truth.startT);
  const exit = pairs.map((p) => p.event.endT - p.truth.endT);
  const peakErr = pairs.map((p) => Math.abs(p.event.peakAngle - p.truth.peak));
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
  const maxAbs = (xs: number[]) => (xs.length ? Math.max(...xs.map(Math.abs)) : NaN);
  const exact = pairs.filter((p) => p.event.transitions === p.truth.transitions).length;
  return {
    name,
    truthN: truth.length,
    detectedN: events.length,
    matched: pairs.length,
    precision: events.length ? pairs.length / events.length : 1,
    recall: truth.length ? pairs.length / truth.length : 1,
    entryMean: mean(entry),
    entryMax: maxAbs(entry),
    exitMean: mean(exit),
    exitMax: maxAbs(exit),
    transitionsExact: pairs.length ? exact / pairs.length : 1,
    transitionsMismatched: pairs.length - exact,
    peakErrMean: mean(peakErr),
    peakErrMax: maxAbs(peakErr),
    pairs,
    unmatchedEvents: rows.flatMap((r) => r.unmatchedEvents),
    unmatchedTruth: rows.flatMap((r) => r.unmatchedTruth),
  };
}

export function formatMetricsTable(rows: RunMetrics[]): string {
  const ms = (x: number) => (Number.isFinite(x) ? `${(x * 1000).toFixed(0).padStart(4)}` : '   -');
  const pct = (x: number) => `${(x * 100).toFixed(0).padStart(3)}%`;
  const dg = (x: number) => (Number.isFinite(x) ? radToDeg(x).toFixed(1).padStart(4) : '   -');
  const head = 'run                      truth det  TP  prec  rec  entry ms(mean/max) exit ms(mean/max) trans-exact peakErr°(mean/max)';
  const lines = rows.map(
    (r) =>
      `${r.name.padEnd(24)} ${String(r.truthN).padStart(5)} ${String(r.detectedN).padStart(3)} ${String(r.matched).padStart(3)}  ${pct(r.precision)} ${pct(r.recall)}  ${ms(r.entryMean)} / ${ms(r.entryMax)}        ${ms(r.exitMean)} / ${ms(r.exitMax)}       ${pct(r.transitionsExact)} (${r.transitionsMismatched} off)  ${dg(r.peakErrMean)} / ${dg(r.peakErrMax)}`,
  );
  return [head, ...lines].join('\n');
}
