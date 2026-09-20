/**
 * scoreDrift — pure, replayable per-drift scoring built on DriftAccumulator.
 */
import type { DriftEvent, DriftScore, SlipState, StyleCallout } from '../types';
import { DriftAccumulator, type DriftContext, type DriftStats } from './accumulator';
import { angleScore, resolveOptions, speedScore, steadinessScore, type ScoreOptions } from './rules';

/**
 * DriftScore plus the bookkeeping the session scorer and the results screen need.
 * Extra fields are additive (a ScoredDrift is a DriftScore). See the report for the
 * suggested types.ts additions.
 */
export interface ScoredDrift extends DriftScore {
  id: number;
  /** True when the points of this drift were discarded because its chain was lost to a spin. */
  lost: boolean;
  /** Ordinal inside its chain (1 = first). */
  chainIndex: number;
  /** Multiplier when the drift ended (what a chained follower inherits). */
  multiplierEnd: number;
  peakMultiplier: number;
  transitions: number;
  spun: boolean;
  cleanExit: boolean;
  stats: DriftStats;
}

export function buildDriftScore(acc: DriftAccumulator, stats: DriftStats, o: ScoreOptions): ScoredDrift {
  const base = acc.base;
  const points = acc.points;
  const bonus = acc.bonus;
  const effMult = base > 1e-9 ? points / base : acc.multiplier;
  const kinds = new Set(acc.callouts.filter((c) => c.kind !== 'initiation').map((c) => c.kind));
  const style = Math.min(100, 20 * kinds.size + 10 * stats.transitions);
  return {
    id: acc.id,
    base,
    multiplier: effMult,
    bonus,
    total: points + bonus,
    angle: angleScore(stats.heldPeakDeg, o),
    consistency: steadinessScore(stats.jitterDeg, o),
    speed: speedScore(stats.meanSpeedKmh, o),
    style,
    callouts: acc.callouts.slice(),
    lost: false,
    chainIndex: stats.chainIndex,
    multiplierEnd: stats.multiplierEnd,
    peakMultiplier: stats.peakMultiplier,
    transitions: stats.transitions,
    spun: stats.spun,
    cleanExit: stats.cleanExit,
    stats,
  };
}

/** The slice of `states` that belongs to `e` (inclusive sample range, clipped to endT). */
export function driftSamples(e: DriftEvent, states: SlipState[]): SlipState[] {
  const n = states.length;
  if (n === 0) return [];
  let a = Math.max(0, Math.min(n - 1, e.sampleStart | 0));
  let b = Math.max(a, Math.min(n - 1, e.sampleEnd | 0));
  // if the indices do not agree with the timestamps, fall back to a time-based slice
  const idxOk = states[a].t <= e.startT + 0.5 && states[b].t >= e.endT - 0.5 && states[a].t >= e.startT - 0.5;
  if (!idxOk) {
    a = lowerBound(states, e.startT);
    b = Math.max(a, upperBound(states, e.endT) - 1);
  }
  const out: SlipState[] = [];
  for (let i = a; i <= b; i++) {
    const s = states[i];
    if (s.t > e.endT + 1e-6) break;
    out.push(s);
  }
  return out;
}

function lowerBound(states: SlipState[], t: number): number {
  let lo = 0;
  let hi = states.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (states[mid].t < t) lo = mid + 1;
    else hi = mid;
  }
  return Math.min(lo, states.length - 1);
}

function upperBound(states: SlipState[], t: number): number {
  let lo = 0;
  let hi = states.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (states[mid].t <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Score one drift from its samples. `ctx` carries the chain state (multiplier inherited
 * from the previous chained drift, drifts already in the chain, an explicit spin flag).
 * With `ctx` from `scoreSession` this reproduces the LiveScorer's accumulation exactly.
 */
export function scoreDrift(e: DriftEvent, states: SlipState[], opts?: Partial<ScoreOptions>, ctx?: DriftContext): ScoredDrift {
  const o = resolveOptions(opts);
  const samples = driftSamples(e, states);
  const spinHint = ctx?.spin ?? (e as { spin?: boolean }).spin;
  const acc = new DriftAccumulator(o, e.id, samples.length ? samples[0].t : e.startT, { ...ctx, spin: undefined });
  let spun = false;
  for (const s of samples) {
    acc.step(s);
    if (acc.spun) {
      spun = true;
      break;
    }
  }
  if (spinHint === true) spun = true;
  const endT = samples.length ? Math.min(e.endT, samples[samples.length - 1].t) : e.endT;
  const { stats } = acc.finish(endT, spun);
  const sd = buildDriftScore(acc, stats, o);
  if (samples.length === 0) {
    // nothing to integrate: keep the event's own numbers so the results screen is not blank
    sd.angle = angleScore((e.peakAngle * 180) / Math.PI, o);
    sd.speed = speedScore(e.meanSpeed * 3.6, o);
  }
  return sd;
}

export type { DriftContext, DriftStats, StyleCallout };
