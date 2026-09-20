/**
 * Scoring rules & tunables. Every number the scorer uses lives in `ScoreOptions`
 * so the app (or a test) can retune without touching the logic.
 * See index.ts for the human-readable rule set.
 */
import type { StyleCalloutKind, Grade } from '../types';
import { clamp } from '../types';

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
  /** A transition = β sign change where |β| exceeded this (deg) on both sides. */
  transitionHysteresisDeg: number;

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
  /** Max |dβ/dt| (deg/s) over the last `exitWindowS` of a drift for a `perfect-exit`. */
  perfectExitMaxRateDegS: number;
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
  /** A ≥ this (deg) move of the 1 s-averaged angle across `levelChangeSpanS` is an intended target change, not wobble (0 = off). */
  levelChangeDeg: number;
  levelChangeSpanS: number;
  /** Samples further apart than this (s) are treated as a gap: no points for the missing time. */
  maxDtS: number;

  // ---- session components (0–100) ----------------------------------------------------------
  /** Peak |β| (deg) → angle score. */
  angleCurve: Curve;
  /** Mean drifting speed (km/h) → speed score. */
  speedScoreCurve: Curve;
  /** Jitter RMS (deg) → steadiness score. */
  jitterCurve: Curve;
  /** Cross-lap: cornerScore = 100 × (1 − cvScale × CV(peak angle per lap)). */
  cvScale: number;
  /** Cross-lap: initiation-point score = 100 × (1 − sd(initiation arc-length per lap) / initiationSdFullM). */
  initiationSdFullM: number;
  /** Cross-lap = w × angle-CV score + (1 − w) × initiation-point score. */
  crossLapAngleWeight: number;
  /** Initiation is looked for from this many metres before a corner (the transition point in a linked section). */
  initiationLookbackM: number;
  /** Blend of cross-lap corner consistency vs within-drift steadiness when laps are available. */
  crossLapWeight: number;
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
  /** Style: non-initiation callouts per drift needed for full "flair" credit. */
  styleCalloutsPerDrift: number;
  /** style = variety × w.variety + transitions × w.transitions + flair × w.flair (normalised). */
  styleWeights: { variety: number; transitions: number; flair: number };
  /** Component weights for the combined score. */
  weights: { angle: number; consistency: number; quality: number; speed: number; style: number };
  gradeThresholds: { S: number; A: number; B: number; C: number };
  /** Drifts shorter than this (s) get proportionally less weight in duration-weighted means (never zero). */
  minWeightS: number;
}

export const DEFAULT_SCORE_OPTIONS: ScoreOptions = {
  basePointsPerSecond: 100,
  angleFloorDeg: 8,
  angleFullDeg: 35,
  angleCapDeg: 50,
  angleCapFactor: 1.3,
  speedCurve: [
    [20, 0.5],
    [60, 1.0],
    [100, 1.5],
  ],
  speedZeroKmh: 10,

  multiplierStart: 1.0,
  multiplierPerTransition: 0.5,
  multiplierCap: 5.0,
  multiplierPerSustained: 0.25,
  sustainedStepS: 3,
  transitionHysteresisDeg: 8,

  chainGapS: 3,
  bankDelayS: 2,
  spinAngleDeg: 85,

  calloutPoints: {
    initiation: 50,
    transition: 200,
    'extreme-angle': 300,
    'long-drift': 250,
    smooth: 200,
    'high-speed': 300,
    manji: 500,
    link: 400,
    'perfect-exit': 100,
    'clean-lap': 500,
  },
  extremeAngleDeg: 45,
  longDriftS: 5,
  smoothWindowS: 3,
  smoothMaxStdDevDeg: 3,
  highSpeedKmh: 90,
  highSpeedMinS: 1.5,
  manjiTransitions: 3,
  linkDrifts: 3,
  perfectExitMaxRateDegS: 75,
  exitWindowS: 0.5,
  cleanLapMinDrifts: 3,

  smoothingS: 0.1,
  peakHoldS: 1.5,
  extremeAngleHoldS: 0.5,
  jitterWindowS: 4.0,
  jitterErodeS: 2.0,
  jitterNoiseCorrection: true,
  levelChangeDeg: 8,
  levelChangeSpanS: 3,
  maxDtS: 0.1,

  angleCurve: [
    [15, 20],
    [30, 60],
    [45, 100],
  ],
  speedScoreCurve: [
    [16, 0],
    [40, 30],
    [80, 80],
    [100, 100],
  ],
  jitterCurve: [
    [0.15, 100],
    [0.4, 90],
    [0.7, 75],
    [1.0, 55],
    [1.4, 30],
    [1.8, 15],
    [2.4, 5],
    [3.0, 0],
  ],
  cvScale: 3,
  initiationSdFullM: 10,
  crossLapAngleWeight: 0.6,
  initiationLookbackM: 40,
  crossLapWeight: 0.5,
  cornerLeadMarginM: 15,
  cornerTrailMarginM: 5,
  qualityAngleDeg: 15,
  timeAtAngleCurve: [
    [0.4, 0],
    [0.85, 100],
  ],
  qualityWeights: { steadiness: 0.55, timeAtAngle: 0.45 },
  exitPenalty: 0.4,
  spinPenalty: 1.5,
  styleVarietyTarget: 6,
  styleTransitionsPerDrift: 1.0,
  styleCalloutsPerDrift: 4,
  styleWeights: { variety: 0.4, transitions: 0.3, flair: 0.3 },
  weights: { angle: 0.3, consistency: 0.25, quality: 0.25, speed: 0.1, style: 0.1 },
  gradeThresholds: { S: 90, A: 75, B: 60, C: 45 },
  minWeightS: 1.0,
};

export function resolveOptions(opts?: Partial<ScoreOptions>): ScoreOptions {
  if (!opts) return DEFAULT_SCORE_OPTIONS;
  return {
    ...DEFAULT_SCORE_OPTIONS,
    ...opts,
    calloutPoints: { ...DEFAULT_SCORE_OPTIONS.calloutPoints, ...(opts.calloutPoints ?? {}) },
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

export function angleScore(peakDeg: number, o: ScoreOptions): number {
  return clamp(curve(o.angleCurve, peakDeg), 0, 100);
}

export function speedScore(meanKmh: number, o: ScoreOptions): number {
  return clamp(curve(o.speedScoreCurve, meanKmh), 0, 100);
}

export function steadinessScore(jitterDeg: number, o: ScoreOptions): number {
  return clamp(curve(o.jitterCurve, jitterDeg), 0, 100);
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
