import { degToRad } from '../types';

// ─────────────────────────────────────────────────────────────────────────────────────────
// SHARED DRIFT RULES — one definition, used by every module that needs it.
//
// The detector is the authority on what a spin and a direction change ARE; the scorer and
// anything else that has to agree with the HUD imports these instead of re-deriving them.
// Before this existed there were three transition definitions (detector: 5° + 0.4 s dwell +
// yaw gate; scorer: a bare 8° sign change; `countTransitions`: a bare 8° sign change) and two
// spin thresholds (detector 75°, scorer 85°), which left a 75–85° dead band in which the
// detector ended the drift and the scorer reported a clean exit.
// ─────────────────────────────────────────────────────────────────────────────────────────

/** |β| (degrees) at or above which the car is spinning, not drifting. ONE number, everywhere. */
export const SPIN_ANGLE_DEG = 75;

/** The one rule for "the car changed direction". Angles in radians, times in seconds. */
export interface TransitionRule {
  /** |β| that must be exceeded on both sides of the sign change. */
  angleRad: number;
  /** Both the side being left and the side being entered must be held this long. */
  minDwellS: number;
  /** Maximum duration of the swing through zero. */
  maxSwingS: number;
  /** |yawRate| that must be reached somewhere in the swing (rad/s). */
  yawRate: number;
  /** How long a UI may call the phase 'transition' after one is counted. */
  phaseHoldS: number;
}

export const TRANSITION_RULE: TransitionRule = {
  angleRad: degToRad(5),
  minDwellS: 0.4,
  maxSwingS: 1.5,
  yawRate: 0.15,
  phaseHoldS: 0.4,
};

/**
 * The transition rule as a small state machine, fed one sample at a time.
 *
 * Both sides of a swing must be held for `minDwellS`: the side being left has to have been
 * held, and the new side is only PROVISIONAL until it has been. An excursion that falls back
 * to the side it came from inside that window is a feint (or a twitch through zero), so it is
 * cancelled instead of counted — which is what stops a driver sawing the wheel from banking a
 * transition (and a multiplier bump) twice a second.
 */
export class TransitionCounter {
  /** Side the car is currently sliding on. */
  side: 1 | -1;
  /** Committed direction changes so far. */
  transitions = 0;
  /** A UI may show phase 'transition' until this time. */
  phaseUntil = -Infinity;
  /** When the newest committed transition happened (-Infinity before the first). */
  lastTransitionT = -Infinity;
  private sinceT: number;
  private lastT: number;
  private peakYaw: number;
  private pending: { from: 1 | -1; fromSinceT: number; at: number } | null = null;

  constructor(
    private readonly rule: TransitionRule,
    t: number,
    side: 1 | -1,
    yaw = 0,
  ) {
    this.side = side;
    this.sinceT = t;
    this.lastT = t;
    this.peakYaw = Math.abs(yaw);
  }

  /** Re-seed after an initiation (the samples before it are never a direction change). */
  /** When the side the car is on now began. */
  get sideSinceT(): number {
    return this.sinceT;
  }

  restart(t: number, sinceT: number, side: 1 | -1, yaw: number): void {
    this.side = side;
    this.sinceT = sinceT;
    this.lastT = t;
    this.peakYaw = Math.abs(yaw);
    this.pending = null;
  }

  /**
   * Feed one sample: `absBeta` and `yaw` in radians / rad·s⁻¹, `sign` the sign of β.
   * Returns true on the sample where a transition is COMMITTED (dwell satisfied).
   */
  push(t: number, absBeta: number, sign: 1 | -1, yaw: number): boolean {
    const r = this.rule;
    const ya = Math.abs(yaw);
    if (absBeta > r.angleRad) {
      if (sign !== this.side) {
        const swing = t - this.lastT;
        const peak = Math.max(this.peakYaw, ya);
        const p = this.pending;
        if (p && sign === p.from) {
          // back to where it came from before the dwell elapsed: a feint, not a transition
          this.pending = null;
          this.sinceT = p.fromSinceT;
        } else if (swing < r.maxSwingS && peak >= r.yawRate && this.lastT - this.sinceT >= r.minDwellS) {
          this.pending = { from: this.side, fromSinceT: this.sinceT, at: t };
          this.phaseUntil = t + r.phaseHoldS;
          this.sinceT = t;
        } else {
          // a slow wander or a swing with no yaw behind it: the side moves, nothing is counted
          this.pending = null;
          this.sinceT = t;
        }
        this.side = sign;
      }
      this.lastT = t;
      this.peakYaw = ya;
    } else if (ya > this.peakYaw) {
      this.peakYaw = ya;
    }
    const p = this.pending;
    if (p && this.lastT - p.at >= r.minDwellS) {
      this.transitions++;
      this.lastTransitionT = p.at;
      this.pending = null;
      return true;
    }
    return false;
  }
}

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
  /**
   * A linked drift may run `maxDurationS + chainBonusS × transitions` before it is cut in two.
   * A linked sequence is ONE drift because the transitions hold it together, so the allowance
   * scales with how many there are, rather than being unbounded on the first one: a 30 s slide
   * on a single flick is a section of road, not a drift, and gets cut, while a two-transition
   * manji may run 38 s. The cut is taken mid-lobe — never within `minLobeCutS` of a transition,
   * and only while the car is still past `entryAngle` — so it can never sever the flick that is
   * the best part of the sequence, and both halves stand on their own as drifts.
   *
   * CALIBRATION: 14 + 12 n is the tightest bound that cuts NOTHING an independent judge (the
   * simulator's commanded plan, which never looks at β) calls a single drift. Measured over 39
   * events on both tracks the longest commanded drifts are 8.1 s at 0 transitions, 23.1 s at 1,
   * 34.9 s at 2, 34.2 s at 3 and 56.8 s at 4. A tighter 10 + 8 n cuts 6 of those 39 and takes
   * detector precision against that judge from 100 % to 92 % (touge s1: 60 %), so it would be a
   * decision to disbelieve the fixture, not a bug fix. See the report.
   */
  maxDurationS: number;
  chainBonusS: number;
  minLobeCutS: number;
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
  transitionAngle: TRANSITION_RULE.angleRad,
  transitionMaxSwingS: TRANSITION_RULE.maxSwingS,
  transitionYawRate: TRANSITION_RULE.yawRate,
  transitionMinDwellS: TRANSITION_RULE.minDwellS,
  transitionPhaseHoldS: TRANSITION_RULE.phaseHoldS,
  mergeGapS: 1.0,
  feintAngle: degToRad(2.2),
  feintMaxDurationS: 0.6,
  feintMaxAngle: degToRad(9),
  feintReverseGapS: 0.35,
  feintLookbackS: 1.0,
  minDurationS: 0.7,
  maxDurationS: 14,
  chainBonusS: 12,
  minLobeCutS: 1.0,
  spinAngle: degToRad(SPIN_ANGLE_DEG),
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
