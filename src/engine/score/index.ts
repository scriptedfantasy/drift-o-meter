/**
 * Drift-O-Meter scoring engine — NFS-style live scoring, callouts, chains and grades.
 *
 * Pure TypeScript. Two entry points share ONE integrator (`DriftAccumulator`), so a
 * replay (`scoreDrift` / `scoreSession`) reproduces the live HUD numbers exactly.
 *
 * ── RULE SET (every number lives in `ScoreOptions`; defaults in `DEFAULT_SCORE_OPTIONS`) ──
 *
 * BASE POINTS  — while a drift is in progress, per second:
 *     100 × angleFactor × speedFactor × multiplier
 *   angleFactor : 0 at 8° → 1.0 at 35° → 1.3 at ≥ 50° (piecewise linear, |β| smoothed 0.1 s)
 *   speedFactor : 0.5 at 20 km/h → 1.0 at 60 → 1.5 at ≥ 100 (0 below 10 km/h)
 *
 * MULTIPLIER   — starts at 1.0, capped at 5.0
 *   +0.50 per transition (the DETECTOR's rule: see TRANSITION below)
 *   +0.25 per full 3 s of sustained angle (|β| ≥ 8°) inside a drift
 *   Carried into the next drift when it starts ≤ 3 s after a clean exit (a "chain").
 *   `DriftScore.multiplier` is the points-weighted effective multiplier, so
 *   total = base × multiplier + bonus holds exactly although it grows mid-drift.
 *
 * TRANSITION   — ONE rule, defined in `detect/options.ts` (`TRANSITION_RULE`) and used by the
 *   detector, by this scorer and by `countTransitions()`: a β sign change through ±5° that is
 *   HELD 0.4 s on both sides, swung inside 1.5 s, with ≥ 0.15 rad/s of yaw behind it. A flick
 *   that falls straight back is a feint, not a direction change. At most 4 transitions per
 *   drift pay a bonus; beyond that they still grow the (capped) multiplier and still count for
 *   MANJI and for style. Sawing the wheel is therefore worth nothing: it never holds a side.
 *
 * SPIN         — ONE threshold, `SPIN_ANGLE_DEG` (75°) in `detect/options.ts`, plus the
 *   detector's speed-collapse rule, carried on `DriftEvent.spin`. The scorer used to use 85°,
 *   which left a 75–85° band where the detector ended the drift as a spin and the results
 *   screen reported a clean exit.
 *
 * INTEGRITY    — while the integrity monitor's `driftPlausible` is false (phone loose in its
 *   mount, impossible physics, no GPS, too slow), or the estimator has marked the state
 *   invalid, the drift earns NOTHING: no base points AND no callout bonuses. One expression
 *   decides it (`countsForPoints`), every paying path asks that expression, and `LiveTick`
 *   reports the answer as `counting`, so a HUD can never show a `+N` for a point the scorer
 *   refused to pay. `SessionBreakdown.integrity` reports how much of the run was suppressed
 *   and refuses to vouch for the total when it was material.
 *
 * CHAIN        — consecutive drifts ≤ 3 s apart share the multiplier and count towards LINK.
 *   Points are AT RISK until 2 s after a clean exit, then "BANKED +N" (LiveTick.banked).
 *   A spin (detector `spin` flag, or |β| ≥ 85°) ends the drift, discards every un-banked
 *   point ("CHAIN LOST −N", LiveTick.lost) and resets the multiplier to 1.0.
 *
 * CALLOUTS     — bonus points with HUD-ready uppercase labels, each at most once per drift
 *   (transition and link escalate: one per transition / per linked drift)
 *   Every callout is worth its points × THE LIVE MULTIPLIER, so chaining compounds instead of
 *   paying a flat participation fee (flat bonuses used to be ~40 % of a harbour run's score and
 *   varied by 6 % across the whole skill range).
 *   initiation     20   "INITIATION"      first sample of a drift
 *   transition     90   "TRANSITION ×n"   at the n-th direction change (first 4 per drift pay)
 *   extreme-angle 150   "EXTREME ANGLE"   |β| held ≥ 45° over 0.5 s
 *   long-drift    110   "LONG DRIFT"      9 s of sustained angle (|β| ≥ 8°)
 *   smooth        120   "SMOOTH"          std-dev of |β| < 1.1° over 4 s of uninterrupted angle
 *   high-speed    150   "HIGH SPEED"      running mean speed ≥ 68 km/h after ≥ 1.5 s of drifting
 *   manji         220   "MANJI"           at the 3rd transition of one drift
 *   link          180   "LINK ×n"         at the start of the n-th (n ≥ 3) drift of a chain
 *   perfect-exit   45   "PERFECT EXIT"    no spin and |dβ/dt| ≤ 22°/s over the drift's last 0.5 s
 *   clean-lap     300   "CLEAN LAP"       ≥ 3 drifts ended inside a lap, none spun (needs a
 *                                         TrackModel with laps offline; `LiveScorer.onLapCompleted`
 *                                         live — the points bank immediately)
 *
 * SESSION COMPONENTS (0–100) — `scoreSession`
 *   angle        duration-weighted mean of per-drift HELD peak |β| (highest 1.5 s average, so a
 *                0.4 s flick overshoot is not a peak): 12° → 0, 22° → 30, 33° → 65, 45° → 95.
 *                Duration-weighted so a detector that splits one slide into three does not
 *                triple-count it and a 1 s blip does not drag a 20 s slide down.
 *   consistency  0.4 × cross-lap + 0.6 × steadiness. Cross-lap that could not be measured (one
 *                lap, no corners) counts as NEUTRAL (55), never as absent: removing it made one
 *                lap out-grade two for the same driving.
 *                cross-lap, per corner, angle-weighted, and only over corners the reference path
 *                really fits (RMS circle residual ≤ 4 m): 0.6 × [100 × (1 − 3 × CV of the peak
 *                angle across laps)] + 0.4 × [100 × (1 − sd of the initiation point / 10 m)]
 *                steadiness = duration-weighted mean over EVERY drift of its own steadiness:
 *                RMS jitter of |β| around a local quadratic trend (4 s window) on the held
 *                plateau (|β| ≥ ½ peak, eroded adaptively, intended level changes excluded, a
 *                BOUNDED noise-floor subtraction), 0.15° → 100 … 3° → 0, capped by how long the
 *                plateau lasted (0 s → 35, 0.6 s → 60, ≥ 2 s → 100). A drift whose angle never
 *                settles is scored as unsteady, never dropped from the average.
 *   quality      (0.55 × steadiness + 0.45 × timeAtAngle) × exitFactor × spinFactor
 *                timeAtAngle: fraction of drift time with |β| ≥ 15°, 40 % → 0, 85 % → 100
 *                exitFactor = 1 − 0.4 × (1 − clean-exit fraction); spinFactor = 1 − 1.5 × spins/drifts
 *   speed        duration-weighted mean drifting speed, on the scale drifting actually happens
 *                at: 25 km/h → 0, 40 → 25, 55 → 55, 70 → 85, 85 → 100
 *   style        0.30 variety (6 distinct non-initiation kinds) + 0.25 transitions per drift
 *                + 0.25 longest chain (4 drifts = 100) + 0.20 commitment (90 s sideways = 100)
 *   combined     0.26 angle + 0.24 consistency + 0.24 quality + 0.13 speed + 0.13 style
 *   grade        S ≥ 90, A ≥ 75, B ≥ 60, C ≥ 45, D below
 *   total        Σ totals of drifts that were not lost (+ clean-lap bonuses)
 *
 *   TRACK NORMALISATION — the angle and speed curves are written for a `referenceRadiusM` (45 m)
 *   track and stretched by the median corner radius of the TrackModel, so a grade means the same
 *   thing on a tight harbour circuit and on an open mountain road.
 *
 * TRANSITIONS are counted by the detector's rule in both paths (`TRANSITION_RULE`), so
 * `DriftEvent.transitions` and `ScoredDrift.transitions` are the same number by construction;
 * `countTransitions()` applies that same rule to a bare β trace.
 */
export { LiveScorer } from './live';
export type { LiveTick, LiveDriftInfo } from './live';
export { scoreDrift, driftSamples, driftSampleRange } from './drift';
export type { ScoredDrift, DriftContext, DriftStats } from './drift';
export { scoreSession, replayChains, crossLapConsistency, cornerPeaksPerLap, cornerStatsPerLap, cornerFitResidualM, medianCornerRadiusM, medianCornerGapM } from './session';
export type { SessionBreakdown, ChainSummary, LapCornerStats, SessionContext } from './session';
export {
  DEFAULT_SCORE_OPTIONS,
  resolveOptions,
  angleFactor,
  speedFactor,
  angleScore,
  speedScore,
  steadinessScore,
  gradeFor,
  calloutLabel,
  curve,
  trackFactorFor,
  NEUTRAL_TRACK,
} from './rules';
export type { ScoreOptions, Curve, TrackFactor } from './rules';
export { SPIN_ANGLE_DEG, TRANSITION_RULE, TransitionCounter } from '../detect/options';
export type { TransitionRule } from '../detect/options';
export { DriftAccumulator, countsForPoints } from './accumulator';
import { TRANSITION_RULE, TransitionCounter, type TransitionRule } from '../detect/options';

export interface CountTransitionsOptions {
  /** Sample times (s). Without them the trace is assumed to be evenly sampled at `hz`. */
  t?: ArrayLike<number>;
  /** Sample rate used when `t` is absent. Default 100 Hz. */
  hz?: number;
  /**
   * Yaw rate per sample (rad/s). Without it the yaw gate is satisfied automatically — a bare β
   * trace cannot prove the car actually rotated.
   */
  yawRate?: ArrayLike<number>;
  /** Overrides on the shared rule (for tuning; the default IS the detector's rule). */
  rule?: Partial<TransitionRule>;
}

/**
 * Count direction changes in a β trace (radians) with THE rule — the same one the detector and
 * the live scorer use: a sign change through `angleRad` held `minDwellS` on both sides, swung
 * inside `maxSwingS`, with `yawRate` behind it. There is deliberately no second, looser
 * definition: a bare sign-change count called a 0.2 s flick inside a 30° slide two transitions.
 */
export function countTransitions(betaRad: ArrayLike<number>, opts: CountTransitionsOptions = {}): number {
  const rule: TransitionRule = { ...TRANSITION_RULE, ...(opts.rule ?? {}) };
  const n = betaRad.length;
  if (n === 0) return 0;
  const dt = 1 / (opts.hz && opts.hz > 0 ? opts.hz : 100);
  const tAt = (i: number) => (opts.t ? opts.t[i] : i * dt);
  // no yaw channel: the gate cannot be tested, so it is not applied
  const yawAt = (i: number) => (opts.yawRate ? opts.yawRate[i] : rule.yawRate);
  const b0 = betaRad[0];
  const tc = new TransitionCounter(rule, tAt(0), b0 < 0 ? -1 : 1, yawAt(0));
  for (let i = 0; i < n; i++) {
    const b = betaRad[i];
    tc.push(tAt(i), Math.abs(b), b < 0 ? -1 : 1, yawAt(i));
  }
  return tc.transitions;
}
