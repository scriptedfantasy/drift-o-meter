import { degToRad } from '../types';

/**
 * Tunables of the drift state machine. Angles in radians, times in seconds,
 * speeds in m/s, accelerations in m/s², yaw rates in rad/s.
 */
export interface DetectOptions {
  /** |β| that (together with the other entry gates) arms an entry. */
  entryAngle: number;
  /** Minimum ground speed for an entry. */
  entrySpeed: number;
  /** Entry requires |ay| above this OR |yawRate| above `entryYawRate`. */
  entryLateralAccel: number;
  entryYawRate: number;
  /** The entry gates must hold for this long before the drift is confirmed (phase 'entry' meanwhile). */
  entryHoldS: number;
  /** Entry additionally requires |β| > entryAngle + entrySigmaK · betaSigma (0 = ignore the estimator's uncertainty). */
  entrySigmaK: number;
  /** |β| below which the car counts as straight. Also the boundary used to place the start/end of an event. */
  exitAngle: number;
  /** |β| must stay below `exitAngle` for this long before the drift ends (phase 'exit' meanwhile). */
  exitHoldS: number;
  /** Speed below which the drift ends at once. */
  exitSpeed: number;
  /** When an entry is confirmed the start is backdated to the last upward crossing of `exitAngle`, at most this far. */
  onsetMaxLookbackS: number;
  /** Hysteresis under `exitAngle` before the onset crossing is forgotten (noise robustness). */
  onsetHysteresis: number;
  /** |β| that must be exceeded on both sides of a sign change for it to count as a transition. */
  transitionAngle: number;
  /** Maximum duration of the swing through zero for a transition. */
  transitionMaxSwingS: number;
  /** |yawRate| that must be reached somewhere in the swing. */
  transitionYawRate: number;
  /**
   * A swing only counts once the new side has been HELD this long. A shorter excursion that
   * falls back to the side it came from is a feint / flick, not a direction change, and is
   * never counted (see `feintAngle`).
   */
  transitionMinDwellS: number;
  /** How long the phase reads 'transition' after one is counted. */
  transitionPhaseHoldS: number;
  /** Two drifts whose gap (end of one to start of the next) is shorter than this become one linked event. */
  mergeGapS: number;
  /**
   * Initiation / Scandinavian flick ("feint"): |β| above this counts as having left straight
   * running. Used only to recognise the brief OPPOSITE excursion that a driver makes to load
   * the car before a fresh initiation, and to backdate the drift to where that flick began.
   */
  feintAngle: number;
  /** The opposite excursion may last at most this long and peak at most this high to be a feint. */
  feintMaxDurationS: number;
  feintMaxAngle: number;
  /** The real slide must start within this long after the flick falls back under `feintAngle`. */
  feintReverseGapS: number;
  /** Maximum backdating when a feint is recognised (replaces `onsetMaxLookbackS` for that case). */
  feintLookbackS: number;
  /** Events shorter than this are twitches and dropped (spins are always kept). */
  minDurationS: number;
  /** |β| above which the car is spinning. */
  spinAngle: number;
  /** Speed collapsing below `exitSpeed` while |β| is above this is a spin too. */
  spinMinAngle: number;
  /** `valid:false` samples freeze the machine for up to this long; then the drift exits. */
  invalidHoldS: number;
  /** Edge of the drift excluded from meanAngle / angleStdDev. */
  statsEdgeS: number;
  /** Time constant of the first-order filter applied to β, yaw rate and ay before any decision. */
  filterTauS: number;
  /** A gap of invalid samples longer than this re-seeds the filters. */
  filterResetGapS: number;
  /** Debounce timers unwind at this multiple of real time while their condition is false (noise tolerance). */
  timerDecayRatio: number;
  /** Sample gaps longer than this are clamped for integration (app suspended, clock jumps). */
  maxDtS: number;
}

export const DEFAULT_DETECT_OPTIONS: DetectOptions = {
  entryAngle: degToRad(8),
  entrySpeed: 5,
  entryLateralAccel: 1.5,
  entryYawRate: 0.15,
  entryHoldS: 0.15,
  entrySigmaK: 0,
  exitAngle: degToRad(4),
  exitHoldS: 0.6,
  exitSpeed: 3,
  onsetMaxLookbackS: 0.5,
  onsetHysteresis: degToRad(1),
  transitionAngle: degToRad(5),
  transitionMaxSwingS: 1.5,
  transitionYawRate: 0.15,
  transitionMinDwellS: 0.4,
  transitionPhaseHoldS: 0.4,
  mergeGapS: 1.0,
  feintAngle: degToRad(2.5),
  feintMaxDurationS: 0.6,
  feintMaxAngle: degToRad(9),
  feintReverseGapS: 0.35,
  feintLookbackS: 1.0,
  minDurationS: 0.7,
  spinAngle: degToRad(75),
  spinMinAngle: degToRad(30),
  invalidHoldS: 1.0,
  statsEdgeS: 0.3,
  filterTauS: 0.05,
  filterResetGapS: 0.15,
  timerDecayRatio: 2,
  maxDtS: 0.1,
};

export function resolveOptions(opts?: Partial<DetectOptions>): DetectOptions {
  const o: DetectOptions = { ...DEFAULT_DETECT_OPTIONS };
  if (opts) {
    for (const k of Object.keys(opts) as Array<keyof DetectOptions>) {
      const v = opts[k];
      if (typeof v === 'number' && Number.isFinite(v)) o[k] = v;
    }
  }
  return o;
}
