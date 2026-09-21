/**
 * scoreDrift — pure, replayable per-drift scoring built on DriftAccumulator.
 */
import type { DriftEvent, DriftScore, SlipState, StyleCallout } from '../types';
import { clamp } from '../types';
import { DriftAccumulator, type DriftContext, type DriftStats } from './accumulator';
import { angleScore, resolveOptions, speedScore, steadinessScore, NEUTRAL_TRACK, type ScoreOptions, type TrackFactor } from './rules';

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

export function buildDriftScore(acc: DriftAccumulator, stats: DriftStats, o: ScoreOptions, tf: TrackFactor = NEUTRAL_TRACK): ScoredDrift {
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
    angle: angleScore(stats.heldPeakDeg, o, tf),
    // the plateau the jitter was measured on caps what it may claim: a drift that never settled
    // is unsteady, not unjudged
    consistency: steadinessScore(stats.jitterDeg / (tf.jitter || 1), o, stats.plateauS),
    speed: speedScore(stats.meanSpeedKmh, o, tf),
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
  const r = driftSampleRange(e, states);
  const out: SlipState[] = [];
  for (let i = r.a; i <= r.b; i++) out.push(states[i]);
  return out;
}

/**
 * The INCLUSIVE index range of `states` that belongs to `e` (empty when a > b). Indices, not
 * copies, so a caller can line the samples up with a per-sample side channel (the integrity
 * monitor's plausibility mask) without re-deriving the slice.
 */
export function driftSampleRange(e: DriftEvent, states: SlipState[]): { a: number; b: number } {
  const n = states.length;
  if (n === 0) return { a: 0, b: -1 };
  let a = Math.max(0, Math.min(n - 1, e.sampleStart | 0));
  let b = Math.max(a, Math.min(n - 1, e.sampleEnd | 0));
  // if the indices do not agree with the timestamps, fall back to a time-based slice
  const idxOk = states[a].t <= e.startT + 0.5 && states[b].t >= e.endT - 0.5 && states[a].t >= e.startT - 0.5;
  if (!idxOk) {
    a = lowerBound(states, e.startT);
    b = Math.max(a, upperBound(states, e.endT) - 1);
  }
  while (b >= a && states[b].t > e.endT + 1e-6) b--;
  return { a, b };
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
export function scoreDrift(
  e: DriftEvent,
  states: SlipState[],
  opts?: Partial<ScoreOptions>,
  ctx?: DriftContext,
  tf: TrackFactor = NEUTRAL_TRACK,
): ScoredDrift {
  const o = resolveOptions(opts);
  const { a, b } = driftSampleRange(e, states);
  const count = b - a + 1;
  // `DriftEvent.spin` is REQUIRED and it is the detector's verdict; the context may override it
  const spinHint = ctx?.spin ?? e.spin;
  const plausible = ctx?.plausible ?? null;
  const acc = new DriftAccumulator(o, e.id, count > 0 ? states[a].t : e.startT, { ...ctx, spin: undefined, plausible: null });
  let spun = false;
  for (let i = a; i <= b; i++) {
    acc.step(states[i], plausible ? plausible[i] !== 0 : true);
    if (acc.spun) {
      spun = true;
      break;
    }
  }
  if (spinHint === true) spun = true;
  const endT = count > 0 ? Math.min(e.endT, states[b].t) : e.endT;
  const { stats } = acc.finish(endT, spun);
  // TWO PATHS, and they must agree. With the per-sample mask (the live pipeline, and a replay
  // the pipeline hands it to) the accumulator has already refused to pay for the instants the
  // integrity monitor did not believe, bit for bit. WITHOUT it — a session re-scored from
  // storage, where a sample-indexed mask could not survive decimation without silently
  // misaligning — `DriftEvent.suppressedS` is the durable fallback: scale what this drift
  // earned by the fraction of it that WAS believed.
  //
  // Earnings, not just base points: a suppressed sample also fails to advance the sustained
  // multiplier and fails to accrue the seconds LONG DRIFT, SMOOTH and HIGH SPEED need, so a
  // re-score fires callouts at a multiplier the live pass never reached. Scaling the whole
  // drift is the closest a single duration can come.
  //
  // HOW CLOSE, and to WHAT — the bound on the total is not the bound on a component:
  //   total        within 1.3 % of the live total while under ~5 s of a run was suppressed, and
  //                8.5 % on the worst case measured (harbor seed 1, looseness 0.2: 18.6 s
  //                suppressed across two long slides) — measured over 2 tracks × 3 seeds ×
  //                looseness 0/0.1/0.2. It is WIDER than it used to be on purpose: the live pass
  //                now refuses a CALLOUT that fires in an instant the monitor did not believe,
  //                and a single duration cannot say which of a drift's callouts those were, so
  //                the fallback pays their expected value (bonus × believed fraction) instead.
  //                A wholly-refused run re-scores to exactly 0, not to a rounding remainder.
  //   angle,       EXACT. Both are measured off the recorded trace (held peak, jitter, plateau),
  //   consistency  which is kept for every sample whether it was believed or not, so the mask
  //                cannot move them at all.
  //   quality      within ~1 point. It is the only component that integrates dt, which is the
  //                thing the mask zeroes: `timeAtAngleS / durationS` is a RATIO, and scaling the
  //                denominator alone once inflated quality by 13 points on a run whose total was
  //                within a percent. Both ends are scaled below.
  //   speed        within ~1 point, and irreducibly so: the mean speed is over a different set
  //                of samples, and which ones is exactly what a duration cannot say.
  //   style        up to ~6 points on a run that was suppressed OUTRIGHT, where the live pass
  //                fired fewer time-based callouts than a re-score does. Those runs publish
  //                nothing. On a trusted run it does not move.
  if (!plausible && e.suppressedS > 0 && e.durationS > 0) {
    // A drift whose believed remainder is shorter than a single sample gap was not partly
    // believed, it was refused: `suppressedS` is rounded to the millisecond and measured BETWEEN
    // samples, so a wholly-suppressed slide lands a few ms short of its own duration, and
    // scaling by that remainder paid a few points for a run the engine had already refused.
    const remainderS = e.durationS - e.suppressedS;
    const believed = remainderS <= o.maxDtS ? 0 : clamp(remainderS / e.durationS, 0, 1);
    stats.implausibleS = Math.min(e.suppressedS, stats.durationS);
    stats.durationS = Math.max(0, stats.durationS - stats.implausibleS);
    // EVERY accumulated duration, not just the total one. `timeAtAngleS` and `durationS` are a
    // RATIO in the quality term, so scaling the denominator alone inflates it — that single
    // omission moved quality 13 points on a partially-suppressed run while every other
    // component was identical, because angle and consistency are measured off the recorded
    // trace (kept for every sample, believed or not) and only the quality term integrates dt.
    stats.timeAtAngleS *= believed;
    stats.sustainedS *= believed;
    acc.base *= believed;
    acc.points *= believed;
    acc.bonus *= believed;
  }
  const sd = buildDriftScore(acc, stats, o, tf);
  if (count <= 0) {
    // nothing to integrate: keep the event's own numbers so the results screen is not blank
    sd.angle = angleScore((e.peakAngle * 180) / Math.PI, o, tf);
    sd.speed = speedScore(e.meanSpeed * 3.6, o, tf);
  }
  return sd;
}

export type { DriftContext, DriftStats, StyleCallout };
