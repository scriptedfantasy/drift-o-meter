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
 *   +0.50 per transition (β sign change through the ±8° hysteresis band)
 *   +0.25 per full 3 s of sustained angle (|β| ≥ 8°) inside a drift
 *   Carried into the next drift when it starts ≤ 3 s after a clean exit (a "chain").
 *   `DriftScore.multiplier` is the points-weighted effective multiplier, so
 *   total = base × multiplier + bonus holds exactly although it grows mid-drift.
 *
 * CHAIN        — consecutive drifts ≤ 3 s apart share the multiplier and count towards LINK.
 *   Points are AT RISK until 2 s after a clean exit, then "BANKED +N" (LiveTick.banked).
 *   A spin (detector `spin` flag, or |β| ≥ 85°) ends the drift, discards every un-banked
 *   point ("CHAIN LOST −N", LiveTick.lost) and resets the multiplier to 1.0.
 *
 * CALLOUTS     — bonus points with HUD-ready uppercase labels, each at most once per drift
 *   (transition and link escalate: one per transition / per linked drift)
 *   initiation     50   "INITIATION"      first sample of a drift
 *   transition    200×n "TRANSITION ×n"   at the n-th direction change of the drift
 *   extreme-angle 300   "EXTREME ANGLE"   |β| held ≥ 45° over 0.5 s
 *   long-drift    250   "LONG DRIFT"      5 s of sustained angle (|β| ≥ 8°)
 *   smooth        200   "SMOOTH"          std-dev of |β| < 3° over 3 s of uninterrupted angle
 *   high-speed    300   "HIGH SPEED"      running mean speed ≥ 90 km/h after ≥ 1.5 s of drifting
 *   manji         500   "MANJI"           at the 3rd transition of one drift
 *   link          400   "LINK ×n"         at the start of the n-th (n ≥ 3) drift of a chain
 *   perfect-exit  100   "PERFECT EXIT"    no spin and |dβ/dt| ≤ 75°/s over the drift's last 0.5 s
 *   clean-lap     500   "CLEAN LAP"       ≥ 3 drifts ended inside a lap, none spun (needs a
 *                                         TrackModel with laps offline; `LiveScorer.onLapCompleted`
 *                                         live — the points bank immediately)
 *
 * SESSION COMPONENTS (0–100) — `scoreSession`
 *   angle        duration-weighted mean of per-drift HELD peak |β| (highest 1.5 s average, so a
 *                0.4 s flick overshoot is not a peak): 15° → 20, 30° → 60, 45° → 100 (cap).
 *                Duration-weighted so a detector that splits one slide into three does not
 *                triple-count it and a 1 s blip does not drag a 20 s slide down.
 *   consistency  50 % cross-lap + 50 % steadiness when the track has ≥ 2 laps and corners,
 *                else steadiness only.
 *                cross-lap, per corner, angle-weighted: 0.6 × [100 × (1 − 3 × CV of the peak angle
 *                across laps)] + 0.4 × [100 × (1 − sd of the initiation point across laps / 10 m)]
 *                steadiness = RMS jitter of |β| around a local quadratic trend (4 s window) on the
 *                held plateau (|β| ≥ ½ peak, 2 s eroded at each end, intended level changes of ≥ 8°
 *                excluded, sensor-noise floor subtracted): 0.15° → 100, 0.4° → 90, 0.7° → 75,
 *                1.0° → 55, 1.4° → 30, 1.8° → 15, 3° → 0. Holds shorter than 4 s are not judged.
 *   quality      (0.55 × steadiness + 0.45 × timeAtAngle) × exitFactor × spinFactor
 *                timeAtAngle: fraction of drift time with |β| ≥ 15°, 40 % → 0, 85 % → 100
 *                exitFactor = 1 − 0.4 × (1 − clean-exit fraction); spinFactor = 1 − 1.5 × spins/drifts
 *   speed        duration-weighted mean drifting speed: 16 km/h → 0, 40 → 30, 80 → 80, 100 → 100
 *   style        0.4 × variety (6 distinct non-initiation kinds = 100) + 0.3 × transitions per
 *                drift (1.0 = 100) + 0.3 × non-initiation callouts per drift (4 = 100)
 *   combined     0.30 angle + 0.25 consistency + 0.25 quality + 0.10 speed + 0.10 style
 *   grade        S ≥ 90, A ≥ 75, B ≥ 60, C ≥ 45, D below
 *   total        Σ totals of drifts that were not lost (+ clean-lap bonuses)
 *
 * TRANSITIONS are detected by the scorer itself from β (identical code live and offline), so
 * the detector's `transitions` count is informational here; `countTransitions()` is exported
 * so other modules can apply the same rule.
 */
export { LiveScorer } from './live';
export type { LiveTick, LiveDriftInfo } from './live';
export { scoreDrift, driftSamples } from './drift';
export type { ScoredDrift, DriftContext, DriftStats } from './drift';
export { scoreSession, replayChains, crossLapConsistency, cornerPeaksPerLap, cornerStatsPerLap } from './session';
export type { SessionBreakdown, ChainSummary, LapCornerStats } from './session';
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
} from './rules';
export type { ScoreOptions, Curve } from './rules';
export { DriftAccumulator } from './accumulator';
import { DEFAULT_SCORE_OPTIONS } from './rules';

/**
 * Count direction changes in a β trace (radians) with the scorer's hysteresis rule:
 * a transition is a sign change where |β| exceeded `hysteresisDeg` on both sides.
 */
export function countTransitions(betaRad: ArrayLike<number>, hysteresisDeg = DEFAULT_SCORE_OPTIONS.transitionHysteresisDeg): number {
  const h = (hysteresisDeg * Math.PI) / 180;
  let state = 0;
  let n = 0;
  for (let i = 0; i < betaRad.length; i++) {
    const b = betaRad[i];
    const sign = b > h ? 1 : b < -h ? -1 : 0;
    if (sign !== 0) {
      if (state !== 0 && sign !== state) n++;
      state = sign;
    }
  }
  return n;
}
