/**
 * Scoring rules & tunables. Every number the scorer uses lives in `ScoreOptions`
 * so the app (or a test) can retune without touching the logic.
 * See index.ts for the human-readable rule set.
 */
import type { StyleCalloutKind, Grade } from '../types';
import { clamp, radToDeg } from '../types';
import { SPIN_ANGLE_DEG, TRANSITION_RULE, type TransitionRule } from '../detect/options';

/** A piecewise-linear curve: sorted [x, y] knots, flat (clamped) outside the knots. */
export type Curve = Array<[number, number]>;

export interface ScoreOptions {
  // ---- base rate ---------------------------------------------------------------------
  /** Points per second at angleFactor 1 × speedFactor 1 × multiplier 1. */
  basePointsPerSecond: number;
  /** |β| (deg) below which no points accrue and the sustained timer pauses. angleFactor = 0. */
  angleFloorDeg: number;
  /** |β| (deg) where angleFactor reaches 1.0. */
  angleFullDeg: number;
  /** |β| (deg) at/above which angleFactor is capped at `angleCapFactor`. */
  angleCapDeg: number;
  angleCapFactor: number;
  /** speedFactor curve, km/h → factor. Below the first knot the factor ramps to 0 at `speedZeroKmh`. */
  speedCurve: Curve;
  speedZeroKmh: number;

  // ---- multiplier ----------------------------------------------------------------------
  multiplierStart: number;
  multiplierPerTransition: number;
  multiplierCap: number;
  /** +`multiplierPerSustained` every `sustainedStepS` seconds of |β| ≥ angleFloorDeg inside a drift. */
  multiplierPerSustained: number;
  sustainedStepS: number;
  /**
   * The ONE transition rule (shared with the detector): a sign change through `angleRad` that
   * is held `minDwellS` on BOTH sides, swung inside `maxSwingS`, with `yawRate` behind it.
   * The scorer used to count a bare ±8° sign change with no dwell and no yaw gate, which paid
   * a driver sawing the wheel at 2.5 Hz 75 transitions in 30 s.
   */
  transitionRule: TransitionRule;
  /** Display mirror of `transitionRule.angleRad` in degrees. Informational only. */
  transitionHysteresisDeg: number;
  /** At most this many transitions per drift PAY a bonus; beyond it they only grow the multiplier. */
  transitionBonusMaxPerDrift: number;
  /** Callout bonuses are worth the live multiplier (chaining compounds) instead of a flat fee. */
  calloutsUseMultiplier: boolean;

  // ---- chain -----------------------------------------------------------------------------
  /** Consecutive drifts that start within this many seconds of the previous clean exit share the multiplier. */
  chainGapS: number;
  /** Un-banked chain points bank this many seconds after a clean exit (if no new drift started). */
  bankDelayS: number;
  /** |β| (deg) at/above which a drift counts as a spin (the detector's `spin` flag also counts). */
  spinAngleDeg: number;

  // ---- callouts ---------------------------------------------------------------------------
  calloutPoints: Record<StyleCalloutKind, number>;
  extremeAngleDeg: number;
  longDriftS: number;
  smoothWindowS: number;
  smoothMaxStdDevDeg: number;
  highSpeedKmh: number;
  /** Seconds of drifting before the running-mean speed may fire `high-speed`. */
  highSpeedMinS: number;
  manjiTransitions: number;
  linkDrifts: number;
  /** Max |dβ/dt| (deg/s) over the last `exitWindowS` of a drift for the PERFECT EXIT callout. */
  perfectExitMaxRateDegS: number;
  /**
   * Max |dβ/dt| (deg/s) over the same window for the exit to count as DRIVEN OUT CLEAN — the
   * quality term and the results screen's "N of M exits clean". Deliberately looser than the
   * callout: PERFECT EXIT is a rare flourish, a clean exit is the normal way to finish a drift,
   * and using one number for both meant tuning the callout to fire on a quarter of drifts
   * silently took 30 % off every driver's quality score.
   */
  cleanExitMaxRateDegS: number;
  exitWindowS: number;
  cleanLapMinDrifts: number;

  // ---- signal conditioning --------------------------------------------------------------
  /** Trailing moving-average window applied to |β| before every threshold test (kills 1° sensor noise). */
  smoothingS: number;
  /** The peak angle the ANGLE COMPONENT counts is the highest |β| HELD over this window (s): a 0.4 s flick overshoot is not a held angle. */
  peakHoldS: number;
  /** EXTREME ANGLE fires when |β| is held over this (shorter, snappier) window. */
  extremeAngleHoldS: number;
  /** Centred window of the local quadratic trend that splits |β| into "intended" and "jitter". */
  jitterWindowS: number;
  /** Seconds trimmed from each end of a sustained plateau before jitter is measured. */
  jitterErodeS: number;
  /** Subtract the measured sensor-noise floor from the jitter (true) or report it raw (false). */
  jitterNoiseCorrection: boolean;
  /** The noise floor may never remove more than this fraction of the measured jitter (bounded subtraction). */
  noiseCorrectionMaxFraction: number;
  /** Erode at most this fraction of the longest hold from each end before jitter is measured. */
  jitterErodeFraction: number;
  /** A ≥ this (deg) move of the 1 s-averaged angle across `levelChangeSpanS` is an intended target change, not wobble (0 = off). */
  levelChangeDeg: number;
  levelChangeSpanS: number;
  /** Samples further apart than this (s) are treated as a gap: no points for the missing time. */
  maxDtS: number;
  /** Seconds of SlipStates the LiveScorer keeps, to replay a drift it never saw live. */
  ringKeepS: number;

  // ---- session components (0–100) ----------------------------------------------------------
  /** Peak |β| (deg) → angle score. */
  angleCurve: Curve;
  /** Mean drifting speed (km/h) → speed score. */
  speedScoreCurve: Curve;
  /** Jitter RMS (deg) → steadiness score. */
  jitterCurve: Curve;
  /**
   * Plateau seconds the jitter was measured on → the HIGHEST steadiness that measurement may
   * claim. A drift whose angle never settles has no plateau, and "never settles" IS unsteady:
   * it is capped low instead of being dropped from the average, and near-zero jitter over a
   * 0.6 s window can no longer mean 100.
   */
  plateauCapCurve: Curve;
  /** Cross-lap: cornerScore = 100 × (1 − cvScale × CV(peak angle per lap)). */
  cvScale: number;
  /** Cross-lap: initiation-point score = 100 × (1 − sd(initiation arc-length per lap) / initiationSdFullM). */
  initiationSdFullM: number;
  /** Cross-lap = w × angle-CV score + (1 − w) × initiation-point score. */
  crossLapAngleWeight: number;
  /** Initiation is looked for from this many metres before a corner (the transition point in a linked section). */
  initiationLookbackM: number;
  /** Blend of cross-lap corner consistency vs within-drift steadiness. */
  crossLapWeight: number;
  /**
   * Score for cross-lap consistency that could not be MEASURED although the track COULD have
   * shown it — a closed circuit driven for one lap. Neutral, not removed: dropping the term let
   * the same driver grade S over one lap and A over two, i.e. driving less raised the grade.
   */
  crossLapNeutral: number;
  /**
   * Whether a point-to-point road (never a closed circuit, so there is no second lap to be
   * consistent with) also pays the neutral. False: a road cannot be lapped, and a driver is not
   * marked down for the shape of the road — only for not proving something they could have.
   */
  crossLapNeutralOnOpenTrack: boolean;
  /**
   * A corner only counts towards cross-lap consistency when the reference path actually fits a
   * circular arc through it to within this many metres RMS. A mis-placed apex puts the corner
   * window on a different piece of road in every lap, which is noise, not inconsistency.
   */
  cornerFitMaxResidualM: number;
  /** Corner windows start this many metres BEFORE the corner (drivers initiate early) ... */
  cornerLeadMarginM: number;
  /** ... and end this many metres after it (a small trail so the next corner's entry is not caught). */
  cornerTrailMarginM: number;
  /** "Time at angle" quality term counts |β| ≥ this (deg). */
  qualityAngleDeg: number;
  /** Fraction of drift time at angle → 0..100. */
  timeAtAngleCurve: Curve;
  /** quality = (w.steadiness × steadiness + w.timeAtAngle × timeAtAngle) × exitFactor × spinFactor */
  qualityWeights: { steadiness: number; timeAtAngle: number };
  /** exitFactor = 1 − exitPenalty × (1 − clean-exit fraction). */
  exitPenalty: number;
  /** spinFactor = max(0, 1 − spinPenalty × spins / drifts). */
  spinPenalty: number;
  /** Style: distinct callout kinds (excluding `initiation`) needed for full variety credit. */
  styleVarietyTarget: number;
  /** Style: transitions per drift needed for full transition credit. */
  styleTransitionsPerDrift: number;
  /** Style: drifts in the longest chain needed for full chaining credit. */
  styleChainTarget: number;
  /**
   * Style: RARE callouts per drift needed for full flair credit — EXTREME ANGLE, MANJI, HIGH
   * SPEED, LINK, CLEAN LAP. The old "flair" term counted every callout per drift, and since
   * three of them fired on nearly every drift it scored 74–100 for everybody.
   */
  styleRarePerDrift: number;
  /** style = variety × w.variety + transitions × w.transitions + chain × w.chain + flair × w.flair. */
  styleWeights: { variety: number; transitions: number; chain: number; flair: number };
  /** Component weights for the combined score. */
  weights: { angle: number; consistency: number; quality: number; speed: number; style: number };
  gradeThresholds: { S: number; A: number; B: number; C: number };
  /** Drifts shorter than this (s) get proportionally less weight in duration-weighted means (never zero). */
  minWeightS: number;
  /**
   * Track normalisation. A tight harbour circuit and an open mountain road do not offer the same
   * angles, speeds or links, so the same driving scored 48.7–77.6 on one and 42.5–95.4 on the
   * other: two letters on one track, five on the other. Two measured properties of the TrackModel
   * scale the expectations:
   *   - median corner radius — how fast a corner can be taken;
   *   - median gap between corners — how LINKED the road is. Corners 19 m apart can be joined
   *     into one long slide; corners 47 m apart force the car straight in between, which caps
   *     the angle held, the transitions per drift and the fraction of the drift spent at angle.
   * Everything here is geometry of the road, never a per-track constant.
   */
  trackNormalise: boolean;
  /** Corner radius (m) → factor the angle / speed curves are stretched by. */
  radiusAngleCurve: Curve;
  radiusSpeedCurve: Curve;
  /** Median corner-to-corner gap (m) → factor on the angle, transition and time-at-angle expectations. */
  gapAngleCurve: Curve;
  gapTransitionCurve: Curve;
  gapTimeAtAngleCurve: Curve;
  /** Median corner-to-corner gap (m) → factor on the jitter a steady driver is allowed. */
  gapJitterCurve: Curve;
  /**
   * A run whose mount was loose / implausible for more than this fraction of its drifting time
   * does not get a published total or grade (`SessionBreakdown.integrity.scoreTrusted`).
   */
  integrityMaxImplausibleFraction: number;
}

export const DEFAULT_SCORE_OPTIONS: ScoreOptions = {
  basePointsPerSecond: 100,
  angleFloorDeg: 8,
  angleFullDeg: 35,
  angleCapDeg: 50,
  angleCapFactor: 1.3,
  speedCurve: [
    [20, 0.5],
    [55, 1.0],
    [85, 1.5],
  ],
  speedZeroKmh: 10,

  multiplierStart: 1.0,
  multiplierPerTransition: 0.5,
  multiplierCap: 5.0,
  multiplierPerSustained: 0.25,
  sustainedStepS: 3,
  transitionRule: TRANSITION_RULE,
  transitionHysteresisDeg: radToDeg(TRANSITION_RULE.angleRad),
  transitionBonusMaxPerDrift: 4,
  calloutsUseMultiplier: true,

  chainGapS: 3,
  bankDelayS: 2,
  spinAngleDeg: SPIN_ANGLE_DEG,

  calloutPoints: {
    initiation: 20,
    transition: 90,
    'extreme-angle': 150,
    'long-drift': 110,
    smooth: 120,
    'high-speed': 150,
    manji: 220,
    link: 180,
    'perfect-exit': 45,
    'clean-lap': 300,
  },
  extremeAngleDeg: 45,
  longDriftS: 9,
  smoothWindowS: 4,
  smoothMaxStdDevDeg: 0.9,
  highSpeedKmh: 72,
  highSpeedMinS: 1.5,
  manjiTransitions: 3,
  linkDrifts: 3,
  perfectExitMaxRateDegS: 16,
  cleanExitMaxRateDegS: 75,
  exitWindowS: 0.5,
  cleanLapMinDrifts: 3,

  smoothingS: 0.1,
  peakHoldS: 1.5,
  extremeAngleHoldS: 0.5,
  jitterWindowS: 4.0,
  jitterErodeS: 2.0,
  jitterNoiseCorrection: true,
  noiseCorrectionMaxFraction: 0.5,
  jitterErodeFraction: 0.3,
  levelChangeDeg: 8,
  levelChangeSpanS: 3,
  maxDtS: 0.1,
  ringKeepS: 120,

  // The top of the scale must not be reachable by anyone who gets sideways once: it used to
  // pay 100 at 43°, so a 43° driver and a 60° driver were indistinguishable on the component
  // that carries the most weight. It now keeps climbing to 60° — beyond which 75° is a SPIN,
  // not a better drift — with the returns flattening above 44°.
  //
  // ── CALIBRATED AGAINST A DRIVER MODEL, NOT AGAINST DRIFTING ──────────────────────────────
  // These knots are fitted to what the SIMULATOR's driver produces: held peaks run 27–41°
  // across the whole skill grid, with individual drifts reaching about 50°. The 44–60° band is
  // deliberately compressed (97 → 100) because the model rarely gets there, and stretching it
  // to where real competition angles live would put the top grade out of reach of every driver
  // we can currently measure.
  //
  // Real drifting routinely sits at 45–60°, so on real recordings that compressed band is
  // where a lot of genuine skill will live, and good and great drivers will pile up against
  // the ceiling. THIS IS THE FIRST THING TO RE-DERIVE once real recordings exist. The symptom
  // that it needs re-deriving is real drivers clustering above 95 on the angle component.
  // See docs/ARCHITECTURE.md § "What only a phone can settle".
  angleCurve: [
    [24, 0],
    [29, 30],
    [33, 65],
    [37, 92],
    [44, 97],
    [60, 100],
  ],
  speedScoreCurve: [
    [44, 0],
    [50, 25],
    [55, 55],
    [60, 92],
    [66, 100],
  ],
  jitterCurve: [
    [0.35, 100],
    [0.55, 95],
    [0.75, 70],
    [0.95, 40],
    [1.2, 18],
    [1.6, 4],
    [2.2, 0],
  ],
  plateauCapCurve: [
    [0, 30],
    [0.6, 80],
    [1.5, 100],
  ],
  cvScale: 3.0,
  initiationSdFullM: 12,
  crossLapAngleWeight: 0.6,
  initiationLookbackM: 40,
  crossLapWeight: 0.4,
  crossLapNeutral: 55,
  crossLapNeutralOnOpenTrack: false,
  cornerFitMaxResidualM: 4,
  cornerLeadMarginM: 15,
  cornerTrailMarginM: 5,
  qualityAngleDeg: 15,
  timeAtAngleCurve: [
    [0.6, 0],
    [0.72, 40],
    [0.82, 85],
    [0.9, 100],
  ],
  qualityWeights: { steadiness: 0.55, timeAtAngle: 0.45 },
  exitPenalty: 0.4,
  spinPenalty: 1.5,
  styleVarietyTarget: 8,
  styleTransitionsPerDrift: 1.3,
  styleChainTarget: 5,
  styleRarePerDrift: 0.9,
  styleWeights: { variety: 0.25, transitions: 0.3, chain: 0.2, flair: 0.25 },
  // Re-derived from the measured p10→p90 spread of each component over the full skill grid on
  // both tracks (angle 67, consistency 55, quality 36, speed 32, style 33 points of spread):
  // weight ∝ discrimination. Speed and style used to carry 20 % of the weight and 2 % of the
  // discrimination; quality used to carry 25 % while duplicating steadiness.
  weights: { angle: 0.3, consistency: 0.25, quality: 0.16, speed: 0.15, style: 0.14 },
  gradeThresholds: { S: 90, A: 75, B: 60, C: 45 },
  minWeightS: 1.0,
  trackNormalise: true,
  radiusAngleCurve: [
    [20, 0.82],
    [50, 1.0],
    [90, 1.1],
  ],
  radiusSpeedCurve: [
    [20, 0.74],
    [50, 1.0],
    [90, 1.22],
  ],
  // Measured: the best driver holds the SAME peak angle on a linked road and on a circuit
  // (36.7° vs 36.8°), so linkedness gets no vote on the angle expectation. It does on the
  // things that did differ — jitter (0.39° vs 0.79°) and transitions per drift (1.33 vs 0.75).
  gapAngleCurve: [
    [15, 1.0],
    [90, 1.0],
  ],
  gapTransitionCurve: [
    [15, 1.25],
    [30, 1.0],
    [50, 0.8],
    [90, 0.65],
  ],
  // ...and the fraction of drift time spent at angle did not differ either (97 % vs 96 %).
  gapTimeAtAngleCurve: [
    [15, 1.0],
    [90, 1.0],
  ],
  gapJitterCurve: [
    [15, 0.92],
    [30, 1.0],
    [50, 1.35],
    [90, 1.5],
  ],
  integrityMaxImplausibleFraction: 0.25,
};

export function resolveOptions(opts?: Partial<ScoreOptions>): ScoreOptions {
  if (!opts) return DEFAULT_SCORE_OPTIONS;
  return {
    ...DEFAULT_SCORE_OPTIONS,
    ...opts,
    calloutPoints: { ...DEFAULT_SCORE_OPTIONS.calloutPoints, ...(opts.calloutPoints ?? {}) },
    transitionRule: { ...DEFAULT_SCORE_OPTIONS.transitionRule, ...(opts.transitionRule ?? {}) },
    qualityWeights: { ...DEFAULT_SCORE_OPTIONS.qualityWeights, ...(opts.qualityWeights ?? {}) },
    styleWeights: { ...DEFAULT_SCORE_OPTIONS.styleWeights, ...(opts.styleWeights ?? {}) },
    weights: { ...DEFAULT_SCORE_OPTIONS.weights, ...(opts.weights ?? {}) },
    gradeThresholds: { ...DEFAULT_SCORE_OPTIONS.gradeThresholds, ...(opts.gradeThresholds ?? {}) },
  };
}

/** Evaluate a piecewise-linear curve; flat outside the outermost knots. */
export function curve(c: Curve, x: number): number {
  if (c.length === 0) return 0;
  if (x <= c[0][0]) return c[0][1];
  const last = c[c.length - 1];
  if (x >= last[0]) return last[1];
  for (let i = 1; i < c.length; i++) {
    const [x1, y1] = c[i];
    if (x <= x1) {
      const [x0, y0] = c[i - 1];
      const f = x1 === x0 ? 1 : (x - x0) / (x1 - x0);
      return y0 + (y1 - y0) * f;
    }
  }
  return last[1];
}

/** 0 at angleFloorDeg → 1 at angleFullDeg → angleCapFactor at angleCapDeg (flat beyond). */
export function angleFactor(absBetaDeg: number, o: ScoreOptions): number {
  return curve(
    [
      [o.angleFloorDeg, 0],
      [o.angleFullDeg, 1],
      [o.angleCapDeg, o.angleCapFactor],
    ],
    absBetaDeg,
  );
}

/** speedCurve in km/h, ramping to 0 below the first knot down to speedZeroKmh. */
export function speedFactor(speedKmh: number, o: ScoreOptions): number {
  const first = o.speedCurve[0];
  if (speedKmh < first[0]) {
    if (speedKmh <= o.speedZeroKmh) return 0;
    return (first[1] * (speedKmh - o.speedZeroKmh)) / (first[0] - o.speedZeroKmh);
  }
  return curve(o.speedCurve, speedKmh);
}

/**
 * How hard the track makes big angles and high speeds, from its own geometry. 1.0 = the track
 * the curves are written for; < 1 = tighter (expect less), > 1 = more open (expect more).
 * `medianRadiusM` ≤ 0 (no track model) means "no opinion": both factors are 1.
 */
export interface TrackFactor {
  angle: number;
  speed: number;
  /** Multiplies the transitions-per-drift target style asks for. */
  transitions: number;
  /** Multiplies the fraction-of-drift-time-at-angle the quality term asks for. */
  timeAtAngle: number;
  /** Divides the measured jitter: a tight circuit costs corrections a long sweeper does not. */
  jitter: number;
  medianRadiusM: number;
  medianGapM: number;
}

export const NEUTRAL_TRACK: TrackFactor = { angle: 1, speed: 1, transitions: 1, timeAtAngle: 1, jitter: 1, medianRadiusM: 0, medianGapM: 0 };

export function trackFactorFor(medianRadiusM: number, medianGapM: number, o: ScoreOptions): TrackFactor;
export function trackFactorFor(medianRadiusM: number, o: ScoreOptions): TrackFactor;
export function trackFactorFor(medianRadiusM: number, gapOrOpts: number | ScoreOptions, maybeOpts?: ScoreOptions): TrackFactor {
  const o = typeof gapOrOpts === 'number' ? (maybeOpts as ScoreOptions) : gapOrOpts;
  const medianGapM = typeof gapOrOpts === 'number' ? gapOrOpts : 0;
  if (!o || !o.trackNormalise || !(medianRadiusM > 0)) return NEUTRAL_TRACK;
  // no gap given (a caller that only knows the radius): the neutral 30 m, i.e. no link opinion
  const gap = medianGapM > 0 ? medianGapM : 30;
  return {
    angle: curve(o.radiusAngleCurve, medianRadiusM) * curve(o.gapAngleCurve, gap),
    speed: curve(o.radiusSpeedCurve, medianRadiusM),
    transitions: curve(o.gapTransitionCurve, gap),
    timeAtAngle: curve(o.gapTimeAtAngleCurve, gap),
    jitter: curve(o.gapJitterCurve, gap),
    medianRadiusM,
    medianGapM: gap,
  };
}

/** Peak |β| → 0..100, with the track's own expectation applied. */
export function angleScore(peakDeg: number, o: ScoreOptions, tf: TrackFactor = NEUTRAL_TRACK): number {
  return clamp(curve(o.angleCurve, peakDeg / (tf.angle || 1)), 0, 100);
}

/** Mean drifting speed (km/h) → 0..100, with the track's own expectation applied. */
export function speedScore(meanKmh: number, o: ScoreOptions, tf: TrackFactor = NEUTRAL_TRACK): number {
  return clamp(curve(o.speedScoreCurve, meanKmh / (tf.speed || 1)), 0, 100);
}

/**
 * Jitter RMS (deg) over `plateauS` seconds of settled angle → 0..100. The plateau length caps
 * the claim: 0 s of settled angle cannot mean "steady", however quiet the residual looks.
 */
export function steadinessScore(jitterDeg: number, o: ScoreOptions, plateauS = Infinity): number {
  const raw = clamp(curve(o.jitterCurve, jitterDeg), 0, 100);
  const cap = Number.isFinite(plateauS) ? clamp(curve(o.plateauCapCurve, plateauS), 0, 100) : 100;
  return Math.min(raw, cap);
}

export function gradeFor(combined: number, o: ScoreOptions): Grade {
  const g = o.gradeThresholds;
  if (combined >= g.S) return 'S';
  if (combined >= g.A) return 'A';
  if (combined >= g.B) return 'B';
  if (combined >= g.C) return 'C';
  return 'D';
}

/** HUD-ready uppercase label for a callout. `n` is the ordinal for transition / link. */
export function calloutLabel(kind: StyleCalloutKind, n = 1): string {
  switch (kind) {
    case 'initiation':
      return 'INITIATION';
    case 'transition':
      return `TRANSITION ×${n}`;
    case 'extreme-angle':
      return 'EXTREME ANGLE';
    case 'long-drift':
      return 'LONG DRIFT';
    case 'smooth':
      return 'SMOOTH';
    case 'high-speed':
      return 'HIGH SPEED';
    case 'manji':
      return 'MANJI';
    case 'link':
      return `LINK ×${n}`;
    case 'perfect-exit':
      return 'PERFECT EXIT';
    case 'clean-lap':
      return 'CLEAN LAP';
  }
}

export const KMH = 3.6;
