/**
 * IntegrityMonitor — decides whether the sensor data can be trusted, and says why in words
 * a driver understands.
 *
 * Four independent judgements are kept up to date at motion rate (O(1) per sample):
 *
 * 1. MOUNT — is the phone rigidly attached to the car, or shifting / hand-held?
 *    In a mounted phone the sensed gravity direction only changes with body roll/pitch
 *    (a few degrees, slowly), and the gyro sees almost nothing except yaw. Three cues,
 *    each band-limited to 0.3–3 Hz (the band where hands and loose cradles move, and below
 *    engine/road vibration) and averaged with an exponential ~2 s window:
 *      • gravityRateRms  — angular rate of the phone-frame gravity direction (rad/s).
 *                          Frame-invariant, so it does not depend on the calibration.
 *      • offYawRms       — gyro energy NOT explained by yaw: the smaller of (a) the roll +
 *                          pitch rates in the calibrated vehicle frame and (b) the raw gyro
 *                          component perpendicular to the sensed gravity direction. A car
 *                          yaws about the vertical, so (b) needs no calibration; taking the
 *                          minimum means neither a calibration error (leaks into a) nor road
 *                          banking (leaks into b) can inflate the cue. Cars: < ~0.2 rad/s peaks.
 *      • azBandRms       — vertical acceleration in band, beyond a speed-scaled vibration
 *                          allowance. Weak cue: alone it can only reach 'suspect'.
 *    looseScore = clamp(max(gravityRate/ref, offYaw/ref) + ½·azCue, 0, 1)
 *    Label with hysteresis + minimum dwell:  rigid ⇄ suspect ⇄ loose.
 *    'handheld' additionally needs a large gravity SWING (RMS deviation of the gravity
 *    direction > ~6°), which separates a hand from a rattling cradle.
 *
 * 2. PHYSICS — a real car cannot exceed |yaw| 4 rad/s, |ay| 2 g, |ax| 1.5 g. Any of these
 *    sustained > 100 ms latches 'implausible' until all are back in range for 0.5 s.
 *    The raw gyro magnitude is checked too, so a shaken phone counts even if the
 *    calibration puts the rotation on a non-yaw axis.
 *
 * 3. GPS — 'none' until a fix arrives or when the newest fix is older than 3 s,
 *    'poor' when hAcc > 15 m (back to 'good' below 12 m), else 'good'.
 *
 * 4. DRIFT PLAUSIBILITY — "could the car really be sliding right now?"
 *    Requires: state speed > 5 m/s, a fresh GPS fix (if any) not reporting < 2.5 m/s,
 *    mount not 'loose', physics 'ok', and — while a slide is claimed (|β| > 8°) — that the
 *    lateral g agrees with the kinematics. Rotating the body-frame accel into the velocity
 *    frame gives the centripetal acceleration a_n = ay·cosβ − ax·sinβ, which must equal
 *    v·(r + β̇) (course rate times speed). BOTH sides are smoothed with the same 1 Hz filter,
 *    so the lag β̇ needs cannot masquerade as a disagreement. We demand |a_n| ≥ 1 m/s² unless
 *    the nose is swinging faster than `slideSwingRateRadS` (mid-transition the lateral g
 *    honestly crosses zero), the signs to match when both are meaningfully non-zero, and the
 *    magnitudes to agree within a generous tolerance. Violations charge a timer (0.5 s
 *    continuous budget, so transitions through zero lateral g are tolerated) with hysteresis.
 *    A parked car being waved about fails the speed gate, so it can never count.
 *
 * All outputs are always defined and finite. See `IntegrityMetrics` for the raw cues.
 */
import { G, type GpsSample, type MotionSample, type SlipState, type VehicleMotionSample, clamp, degToRad } from '../types';
import { BandPass, BandPass3, ExpRms, Lp1, Lp3, finite } from './filters';

export type MountState = 'rigid' | 'suspect' | 'loose';
export type PhysicsState = 'ok' | 'implausible';
export type GpsState = 'good' | 'poor' | 'none';

export type IntegrityFlag =
  | 'loose-mount'
  | 'handheld'
  | 'uncalibrated'
  | 'yaw-rate-limit'
  | 'lateral-g-limit'
  | 'gps-poor'
  | 'gps-lost'
  | 'too-slow'
  | 'inconsistent-slip';

export interface IntegrityState {
  mount: MountState;
  /** 0..1, how strongly the phone appears to move relative to the car. */
  looseScore: number;
  physics: PhysicsState;
  gps: GpsState;
  /** Seconds since the newest fix was received (time since first motion sample while there is no fix). */
  gpsAgeS: number;
  /** Horizontal accuracy of the newest fix in metres; `UNKNOWN_HACC` (999) before the first fix. */
  hAcc: number;
  /** True when the current slide (or lack of one) is consistent with lateral g, yaw rate and speed. */
  driftPlausible: boolean;
  /**
   * True when the mount calibration is good enough to believe anything derived from it. A
   * calibration that cannot resolve which way the car points does not know which way the car is
   * sliding, so nothing downstream is trustworthy however clean the sway cue looks — at
   * simulator looseness 0.7 the sway signature falls between the loose-mount thresholds while
   * the calibrator itself reports 8 % confidence and an unresolved forward axis.
   */
  calibrationOk: boolean;
  /**
   * True when `mount` is a VERDICT rather than an absence of one.
   *
   * Every mount cue is an exponentially-weighted RMS that starts at zero, so before it has
   * filled it reads quiet whatever the mount is doing, and `rigid` is then "nothing found yet",
   * not "nothing to find". `suspect` and `loose` are always verdicts — they need a threshold
   * crossed by measured energy, which an empty average cannot do — so this is false only while
   * the label is `rigid` and the cues are still filling.
   *
   * Published because a screen was guessing at it: the calibration screen kept its own
   * `MOUNT_WARMUP_S = 2 × windowS` and reported the mount as unknown for four wall-clock
   * seconds. That doubling existed to outlast a startup transient that has since been fixed at
   * its source (`MountCalibrator` used to publish the first sample of every run in a frame it
   * had not built yet, and a 0.3 Hz high-pass rang on it into the 2 s RMS for ~4.6 s). What is
   * left is the honest wait: ONE window of evidence, counted in motion actually fed to the cues
   * rather than in seconds the screen has been open.
   *
   * It does NOT promise the verdict is final. A mount at the bottom of the sway band crosses
   * late or not at all — measured over 2 tracks × 4 seeds, the first `suspect` at simulator
   * looseness 0.25 lands at 0.45–3.0 s, at 0.2 at 0.89–10.6 s, and at 0.15 only 2 of 8 runs
   * ever cross (`npx tsx tools/analysis/calibration-sweep.ts warmup`). That band is the known
   * residual `docs/ARCHITECTURE.md` already names; no waiting fixes it.
   */
  mountConfident: boolean;
  flags: IntegrityFlag[];
  /** Plain-language, driver-facing, never empty. */
  message: string;
  /**
   * What the monitor has to say ABOUT THE MOUNT, and nothing else. `''` when it has nothing.
   *
   * `message` answers a different question: of everything wrong right now, what is the ROOT
   * CAUSE — a strict priority list in which an unresolved calibration and a lost GPS fix both
   * outrank a shifting cradle. That is the right answer for the HUD's single integrity line and
   * the wrong one for any caller that has already chosen to head a row "Mount": the calibration
   * screen drew `MOUNT LOOKS UNSTEADY` over `message` and printed a forward-axis sentence under
   * it on 105,439 of 105,439 caution frames, and a GPS sentence under `MOUNT SHAKING` on 2.7 %
   * of the rest. One string cannot both rank causes and answer per-topic, so the monitor
   * publishes both and the caller picks the one its own heading is asking for.
   */
  mountMessage: string;
  /** The same, for the GPS fix. `''` while it is good. */
  gpsMessage: string;
}

/** Raw cues behind the verdicts, for debug panels and tuning. All finite. */
export interface IntegrityMetrics {
  /** Band-limited (0.3–3 Hz) RMS angular rate of the gravity direction, rad/s. */
  gravityRateRms: number;
  /** Band-limited RMS deviation of the gravity direction from its slow mean, rad. */
  gravitySwingRms: number;
  /** Band-limited RMS gyro rate not explained by yaw (min of vehicle roll+pitch and gravity-perpendicular), rad/s. */
  offYawRms: number;
  /** Band-limited RMS yaw rate, rad/s. */
  yawRms: number;
  /** offYaw² / (offYaw² + yaw²) — fraction of band-limited gyro energy not explained by yaw. */
  offYawFraction: number;
  /** Band-limited RMS vertical acceleration, m/s², and the speed-scaled allowance. */
  azBandRms: number;
  azAllowance: number;
  /** Which limit tripped physics: bitmask 1 = yaw, 2 = lateral, 4 = longitudinal. */
  physicsReason: number;
  /** Seconds of accumulated slip-consistency violation (0.5 s trips 'inconsistent-slip'). */
  slipViolationS: number;
  /**
   * Centripetal acceleration measured (ay·cosβ − ax·sinβ) and predicted (v·(r + β̇)), m/s².
   * Both are smoothed with the same 1 Hz filter, so they are directly comparable.
   */
  lateralMeasured: number;
  lateralPredicted: number;
  /** Filtered slip-angle rate, rad/s. */
  betaDot: number;
  /** Speed reported by the newest usable fix, m/s; −1 when unknown. */
  gpsSpeed: number;
  /** Speed used for the vibration allowance and the speed gate, m/s. */
  speed: number;
}

export interface IntegrityOptions {
  /**
   * Minimum `MountCalibration.quality` (0..1) to believe the mount at all, and whether the
   * forward axis must be resolved. Either failing vetoes `driftPlausible` — independently of
   * the sway cues, which are tuned on a signature a mid-looseness mount can slip between.
   */
  minCalibrationQuality: number;
  requireForwardResolved: boolean;
  /** Exponential averaging window for all RMS cues, seconds. */
  windowS: number;
  /** Band in which mount motion is looked for, Hz. */
  bandLowHz: number;
  bandHighHz: number;
  /**
   * Cue normalisation: this much RMS gravity-direction rate (rad/s) scores 1.0, i.e. "as loose
   * as a phone held in a hand". Measured against the simulator: a rigid mount never exceeds
   * 0.07 rad/s (0.09 rad/s on the off-yaw cue) on any track, mount, vibration level, sample
   * rate or calibration error, a rattling cradle (looseness 0.25) sits at 0.37–0.53 and a
   * hand-held phone at 1.4–2.2 — so 1.0 puts a cradle mid-band and a hand at the ceiling.
   */
  gravityRateRef: number;
  /** This much RMS roll+pitch rate (rad/s) scores 1.0. */
  offYawRateRef: number;
  /** Vertical-accel allowance (m/s²) = base + perMs·speed; excess beyond it scores up to 0.5. */
  azAllowBase: number;
  azAllowPerMs: number;
  azExcessRef: number;
  /** looseScore hysteresis thresholds. */
  suspectEnter: number;
  suspectExit: number;
  looseEnter: number;
  looseExit: number;
  /** Minimum time a mount label is held before it may change, seconds. */
  mountDwellS: number;
  /** A loose phone is called hand-held when its gravity swing (rad RMS) or gravity rate (rad/s RMS) exceeds these. */
  handheldSwingRad: number;
  handheldRateRadS: number;
  /** Physics limits. */
  yawRateLimit: number;
  lateralAccelLimit: number;
  longitudinalAccelLimit: number;
  physicsSustainS: number;
  physicsRecoverS: number;
  /** GPS thresholds. */
  gpsMaxAgeS: number;
  gpsPoorHAcc: number;
  gpsGoodHAcc: number;
  /** Drift plausibility. */
  slipClaimRad: number;
  minDriftSpeed: number;
  minGpsSpeed: number;
  minLateralAccel: number;
  /**
   * While the nose is swinging this fast (rad/s) the lateral g genuinely passes through zero —
   * an initiation or a transition between linked corners — so `minLateralAccel` is not applied.
   */
  slideSwingRateRadS: number;
  lateralSignMin: number;
  lateralTolAbs: number;
  lateralTolRel: number;
  slipViolationTripS: number;
  slipViolationClearS: number;
  betaDotFilterHz: number;
}

export const DEFAULT_INTEGRITY_OPTIONS: Readonly<IntegrityOptions> = Object.freeze({
  minCalibrationQuality: 0.3,
  requireForwardResolved: true,
  windowS: 2,
  bandLowHz: 0.3,
  bandHighHz: 3,
  gravityRateRef: 1.0,
  offYawRateRef: 1.0,
  azAllowBase: 0.5,
  azAllowPerMs: 0.03,
  azExcessRef: 1.5,
  suspectEnter: 0.3,
  suspectExit: 0.18,
  looseEnter: 0.72,
  looseExit: 0.5,
  mountDwellS: 0.5,
  handheldSwingRad: 0.17,
  handheldRateRadS: 1.2,
  yawRateLimit: 4,
  lateralAccelLimit: 2 * G,
  longitudinalAccelLimit: 1.5 * G,
  physicsSustainS: 0.1,
  physicsRecoverS: 0.5,
  gpsMaxAgeS: 3,
  gpsPoorHAcc: 15,
  gpsGoodHAcc: 12,
  slipClaimRad: degToRad(8),
  minDriftSpeed: 5,
  minGpsSpeed: 2.5,
  minLateralAccel: 1,
  slideSwingRateRadS: 0.5,
  lateralSignMin: 2,
  lateralTolAbs: 4,
  lateralTolRel: 0.6,
  slipViolationTripS: 0.5,
  slipViolationClearS: 0.15,
  betaDotFilterHz: 1,
});

/** hAcc reported before the first fix (metres). */
export const UNKNOWN_HACC = 999;

const PHYS_YAW = 1;
const PHYS_LATERAL = 2;
const PHYS_LONGITUDINAL = 4;

const FLAG_ORDER: IntegrityFlag[] = [
  'loose-mount',
  'handheld',
  'uncalibrated',
  'yaw-rate-limit',
  'lateral-g-limit',
  'gps-poor',
  'gps-lost',
  'too-slow',
  'inconsistent-slip',
];

function clampDt(dt: number): number {
  if (!Number.isFinite(dt) || dt <= 0) return 1e-3;
  return dt > 0.25 ? 0.25 : dt;
}

export class IntegrityMonitor {
  readonly opts: IntegrityOptions;

  // ---- clocks
  private now = -Infinity; // newest timestamp seen on any stream
  private firstMotionT = NaN;
  private lastMotionT = NaN;
  private lastStateT = NaN;

  // ---- mount cues
  private gravLp: Lp3; // smoothed unit gravity (for the rate)
  private gravBp: BandPass3; // band-passed unit gravity (for the swing)
  private gravRateHp: BandPass3; // band-passed angular-rate vector of the gravity direction
  private gravPrev = { x: 0, y: 0, z: 0 };
  private gravPrimed = false;
  private gravRateRms: ExpRms;
  private gravSwingRms: ExpRms;
  private rollBp: BandPass;
  private pitchBp: BandPass;
  private yawBp: BandPass;
  private gyroBp: BandPass3; // raw gyro, for the calibration-free off-yaw estimate
  private offYawRms: ExpRms;
  private yawRms: ExpRms;
  private azBp: BandPass;
  private azRms: ExpRms;
  private looseScore = 0;
  private mount: MountState = 'rigid';
  private mountSince = -Infinity;
  private handheld = false;

  // ---- physics
  private yawOverS = 0;
  private ayOverS = 0;
  private axOverS = 0;
  private physicsOkS = 0;
  private physics: PhysicsState = 'ok';
  private physicsReason = 0;

  // ---- gps
  private hasFix = false;
  private lastFixT = NaN;
  private hAcc = UNKNOWN_HACC;
  private gpsSpeed = -1;
  private gpsPoorLatched = false;
  private gps: GpsState = 'none';
  private gpsAgeS = 0;

  // ---- slip plausibility
  private hasState = false;
  private speed = 0;
  private slideClaimed = false;
  private prevBeta = 0;
  private betaDotLp: Lp1;
  private betaDot = 0;
  /** Both sides of the lateral-g comparison, smoothed with the SAME filter (see pushState). */
  private lateralMeasLp: Lp1;
  private lateralPredLp: Lp1;
  private lateralMeasured = 0;
  private lateralPredicted = 0;
  private slipViolationS = 0;
  private slipInconsistent = false;
  private speedOk = false;
  private gpsVeto = false;
  private driftPlausible = false;
  private drivenNow = false;
  /** Latest mount calibration, NaN quality until one is pushed (then the veto is inactive). */
  private calQuality = NaN;
  private calForward = true;
  private calOk = true;

  // ---- outputs
  private flagMask = -1;
  private flags: IntegrityFlag[] = [];
  private message = '';
  private mountMessage = '';
  private gpsMessage = '';
  private mountConfident = false;

  constructor(opts: Partial<IntegrityOptions> = {}) {
    const given = Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined)) as Partial<IntegrityOptions>;
    this.opts = { ...DEFAULT_INTEGRITY_OPTIONS, ...given };
    const o = this.opts;
    this.gravLp = new Lp3(o.bandHighHz);
    this.gravBp = new BandPass3(o.bandLowHz, o.bandHighHz);
    this.gravRateHp = new BandPass3(o.bandLowHz, o.bandHighHz);
    this.gravRateRms = new ExpRms(o.windowS);
    this.gravSwingRms = new ExpRms(o.windowS);
    this.rollBp = new BandPass(o.bandLowHz, o.bandHighHz);
    this.pitchBp = new BandPass(o.bandLowHz, o.bandHighHz);
    this.yawBp = new BandPass(o.bandLowHz, o.bandHighHz);
    this.gyroBp = new BandPass3(o.bandLowHz, o.bandHighHz);
    this.offYawRms = new ExpRms(o.windowS);
    this.yawRms = new ExpRms(o.windowS);
    this.azBp = new BandPass(o.bandLowHz, o.bandHighHz);
    this.azRms = new ExpRms(o.windowS);
    const tauLat = 1 / (2 * Math.PI * o.betaDotFilterHz);
    this.betaDotLp = new Lp1(tauLat);
    this.lateralMeasLp = new Lp1(tauLat);
    this.lateralPredLp = new Lp1(tauLat);
    this.recompute();
  }

  reset(): void {
    this.now = -Infinity;
    this.firstMotionT = NaN;
    this.lastMotionT = NaN;
    this.lastStateT = NaN;
    this.gravLp.reset();
    this.gravBp.reset();
    this.gravRateHp.reset();
    this.gravPrimed = false;
    this.gravRateRms.reset();
    this.gravSwingRms.reset();
    this.rollBp.reset();
    this.pitchBp.reset();
    this.yawBp.reset();
    this.gyroBp.reset();
    this.offYawRms.reset();
    this.yawRms.reset();
    this.azBp.reset();
    this.azRms.reset();
    this.looseScore = 0;
    this.mount = 'rigid';
    this.mountSince = -Infinity;
    this.handheld = false;
    this.yawOverS = this.ayOverS = this.axOverS = this.physicsOkS = 0;
    this.physics = 'ok';
    this.physicsReason = 0;
    this.hasFix = false;
    this.lastFixT = NaN;
    this.hAcc = UNKNOWN_HACC;
    this.gpsSpeed = -1;
    this.gpsPoorLatched = false;
    this.gps = 'none';
    this.gpsAgeS = 0;
    this.hasState = false;
    this.speed = 0;
    this.slideClaimed = false;
    this.prevBeta = 0;
    this.betaDotLp.reset();
    this.lateralMeasLp.reset();
    this.lateralPredLp.reset();
    this.betaDot = 0;
    this.lateralMeasured = this.lateralPredicted = 0;
    this.slipViolationS = 0;
    this.slipInconsistent = false;
    this.speedOk = false;
    this.gpsVeto = false;
    this.driftPlausible = false;
    this.drivenNow = false;
    this.calQuality = NaN;
    this.calForward = true;
    this.calOk = true;
    this.flagMask = -1;
    this.mountConfident = false;
    this.recompute();
  }

  /**
   * The mount calibrator's own confidence. Cheap to call on every sample; only a change is
   * acted on. Until this is called the veto is inactive, so a caller that has no calibrator
   * (a unit test, a replay of raw states) behaves exactly as before.
   */
  pushCalibration(c: { quality: number; forwardResolved: boolean }): void {
    const q = Number.isFinite(c.quality) ? c.quality : NaN;
    if (q === this.calQuality && c.forwardResolved === this.calForward) return;
    this.calQuality = q;
    this.calForward = c.forwardResolved;
    this.recompute();
  }

  /**
   * The one verdict the scorer needs on EVERY sample: is this slide believable right now?
   * A plain boolean read, because `state` allocates a snapshot and this is called at 100 Hz.
   */
  get plausible(): boolean {
    return this.driftPlausible;
  }

  /**
   * Is the car being driven right now: a fresh GPS fix says it is moving, and the slip state is
   * above slide speed. A plain boolean read, like `plausible`.
   *
   * GPS is the half that cannot be faked from inside the car. The slip state's speed is carried
   * between fixes by the IMU, and a phone being lifted out of its cradle reads to the IMU as a car
   * pulling away hard — a parked harbor run sat above slide speed for most of the three seconds
   * it was being handled. That is precisely the moment this has to say no.
   */
  get driven(): boolean {
    return this.drivenNow;
  }

  /** Current verdicts. Every read returns a fresh, independent snapshot that is safe to keep or mutate. */
  get state(): IntegrityState {
    return {
      mount: this.mount,
      looseScore: this.looseScore,
      physics: this.physics,
      gps: this.gps,
      gpsAgeS: this.gpsAgeS,
      hAcc: this.hAcc,
      driftPlausible: this.driftPlausible,
      calibrationOk: this.calOk,
      mountConfident: this.mountConfident,
      flags: this.flags.slice(),
      message: this.message,
      mountMessage: this.mountMessage,
      gpsMessage: this.gpsMessage,
    };
  }

  /** Raw cues behind the verdicts. */
  get metrics(): IntegrityMetrics {
    const off = this.offYawRms.ms;
    const yaw = this.yawRms.ms;
    return {
      gravityRateRms: this.gravRateRms.rms,
      gravitySwingRms: this.gravSwingRms.rms,
      offYawRms: this.offYawRms.rms,
      yawRms: this.yawRms.rms,
      offYawFraction: off + yaw > 1e-6 ? off / (off + yaw) : 0,
      azBandRms: this.azRms.rms,
      azAllowance: this.azAllowance(),
      physicsReason: this.physicsReason,
      slipViolationS: this.slipViolationS,
      lateralMeasured: this.lateralMeasured,
      lateralPredicted: this.lateralPredicted,
      betaDot: this.betaDot,
      gpsSpeed: this.gpsSpeed,
      speed: this.speed,
    };
  }

  // ---------------------------------------------------------------------------------------
  // inputs

  pushMotion(raw: MotionSample, vehicle: VehicleMotionSample): void {
    const t = finite(raw.t, this.lastMotionT);
    if (!Number.isFinite(t)) return;
    const dt = clampDt(Number.isFinite(this.lastMotionT) ? t - this.lastMotionT : 0.01);
    if (!Number.isFinite(this.firstMotionT)) this.firstMotionT = t;
    this.lastMotionT = t;
    this.tick(t);

    this.updateMountCues(raw, vehicle, dt);
    this.updateMountLabel(t);
    this.updatePhysics(raw, vehicle, dt);
    this.recompute();
  }

  pushState(s: SlipState): void {
    const t = finite(s.t, this.lastStateT);
    if (!Number.isFinite(t)) return;
    const dt = clampDt(Number.isFinite(this.lastStateT) ? t - this.lastStateT : 0.01);
    this.lastStateT = t;
    this.tick(t);

    const beta = finite(s.beta);
    const speed = Math.max(0, finite(s.speed));
    const r = finite(s.yawRate);
    const ay = finite(s.ay);
    const ax = finite(s.ax);
    this.speed = speed;

    // filtered slip-angle rate (primed on the first state so a large initial β is not a spike)
    if (!this.hasState) this.prevBeta = beta;
    const rawBetaDot = (beta - this.prevBeta) / dt;
    this.prevBeta = beta;
    this.betaDot = this.betaDotLp.step(rawBetaDot, dt);

    // kinematic consistency of a claimed slide
    const o = this.opts;
    const cosB = Math.cos(beta);
    const sinB = Math.sin(beta);
    // β̇ has to be smoothed to be usable, and smoothing lags. Run BOTH sides of the comparison
    // through the SAME filter, so the lag cancels and only a real disagreement is left: during
    // an initiation or a transition β̇ swings by radians per second, and comparing a smoothed
    // prediction against an unsmoothed measurement would flag every one of them.
    this.lateralMeasured = this.lateralMeasLp.step(ay * cosB - ax * sinB, dt); // from the accelerometer
    this.lateralPredicted = this.lateralPredLp.step(speed * (r + rawBetaDot), dt); // v · course rate
    this.slideClaimed = Math.abs(beta) > o.slipClaimRad;
    this.speedOk = speed > o.minDriftSpeed;

    let violated = false;
    if (this.slideClaimed) {
      const m = this.lateralMeasured;
      const p = this.lateralPredicted;
      // a car mid-swing really does pass through zero lateral g; a car that is not rotating
      // and claims a slide with no lateral g at all is not sliding
      const swinging = Math.abs(this.betaDot) > o.slideSwingRateRadS;
      const small = o.lateralSignMin;
      if (Math.abs(m) < o.minLateralAccel && !swinging) violated = true; // sliding with no lateral g
      else if (Math.abs(p) > small && Math.abs(m) > small && Math.sign(m) !== Math.sign(p)) violated = true; // wrong way
      else if (Math.abs(m - p) > Math.max(o.lateralTolAbs, o.lateralTolRel * Math.max(Math.abs(m), Math.abs(p)))) violated = true;
    }
    // charge while violated (capped so recovery never takes longer than ~½ s), discharge twice as fast
    if (violated) this.slipViolationS = Math.min(2 * o.slipViolationTripS, this.slipViolationS + dt);
    else this.slipViolationS = Math.max(0, this.slipViolationS - 2 * dt);
    if (this.slipViolationS > o.slipViolationTripS) this.slipInconsistent = true;
    else if (this.slipViolationS < o.slipViolationClearS) this.slipInconsistent = false;
    this.hasState = true;

    this.recompute();
  }

  pushGps(g: GpsSample): void {
    const t = finite(g.t, NaN);
    if (!Number.isFinite(t)) return;
    this.hasFix = true;
    this.lastFixT = Number.isFinite(this.lastFixT) ? Math.max(this.lastFixT, t) : t;
    const hAcc = finite(g.hAcc, NaN);
    this.hAcc = Number.isFinite(hAcc) && hAcc >= 0 ? hAcc : UNKNOWN_HACC;
    const sp = finite(g.speed, NaN);
    this.gpsSpeed = Number.isFinite(sp) && sp >= 0 ? sp : -1;
    this.tick(t);
    this.recompute();
  }

  // ---------------------------------------------------------------------------------------
  // internals

  private tick(t: number): void {
    if (t > this.now) this.now = t;
  }

  private azAllowance(): number {
    return this.opts.azAllowBase + this.opts.azAllowPerMs * Math.min(40, this.speed);
  }

  private updateMountCues(raw: MotionSample, v: VehicleMotionSample, dt: number): void {
    const o = this.opts;
    // --- gravity direction: rate and swing
    const gx = finite(raw.gravity?.x);
    const gy = finite(raw.gravity?.y);
    const gz = finite(raw.gravity?.z);
    const n = Math.hypot(gx, gy, gz);
    if (n > 1) {
      const u = { x: gx / n, y: gy / n, z: gz / n };
      const s = this.gravLp.step(u, dt);
      const bp = this.gravBp.step(u, dt);
      this.gravSwingRms.stepSquared(bp.x * bp.x + bp.y * bp.y + bp.z * bp.z, dt);
      if (this.gravPrimed) {
        // angular velocity of a unit vector: ω = (u_prev × u_now) / (|u|² dt)
        const p = this.gravPrev;
        const m2 = Math.max(1e-6, s.x * s.x + s.y * s.y + s.z * s.z);
        const w = {
          x: (p.y * s.z - p.z * s.y) / (m2 * dt),
          y: (p.z * s.x - p.x * s.z) / (m2 * dt),
          z: (p.x * s.y - p.y * s.x) / (m2 * dt),
        };
        const wb = this.gravRateHp.step(w, dt);
        this.gravRateRms.stepSquared(wb.x * wb.x + wb.y * wb.y + wb.z * wb.z, dt);
      }
      this.gravPrev.x = s.x;
      this.gravPrev.y = s.y;
      this.gravPrev.z = s.z;
      this.gravPrimed = true;
    }
    // --- gyro energy not explained by yaw
    // (a) roll + pitch rates in the calibrated vehicle frame
    const rb = this.rollBp.step(finite(v.rollRate), dt);
    const pb = this.pitchBp.step(finite(v.pitchRate), dt);
    const yb = this.yawBp.step(finite(v.yawRate), dt);
    let offYawSq = rb * rb + pb * pb;
    // (b) raw gyro component perpendicular to the sensed gravity direction (calibration-free)
    const rr = raw.rotationRate;
    const wb = this.gyroBp.step({ x: finite(rr?.x), y: finite(rr?.y), z: finite(rr?.z) }, dt);
    if (this.gravPrimed) {
      const g = this.gravPrev;
      const gm2 = Math.max(1e-6, g.x * g.x + g.y * g.y + g.z * g.z);
      const along = (wb.x * g.x + wb.y * g.y + wb.z * g.z) / gm2;
      const px = wb.x - along * g.x;
      const py = wb.y - along * g.y;
      const pz = wb.z - along * g.z;
      offYawSq = Math.min(offYawSq, px * px + py * py + pz * pz);
    }
    this.offYawRms.stepSquared(offYawSq, dt);
    this.yawRms.step(yb, dt);
    // --- vertical acceleration in band
    const ab = this.azBp.step(finite(v.az), dt);
    this.azRms.step(ab, dt);

    const rotCue = Math.max(this.gravRateRms.rms / o.gravityRateRef, this.offYawRms.rms / o.offYawRateRef);
    const azCue = clamp((this.azRms.rms - this.azAllowance()) / o.azExcessRef, 0, 1);
    this.looseScore = clamp(rotCue + 0.5 * azCue, 0, 1);
  }

  private updateMountLabel(t: number): void {
    const o = this.opts;
    const s = this.looseScore;
    const held = t - this.mountSince;
    let next = this.mount;
    if (this.mount === 'rigid') {
      if (s > o.looseEnter) next = 'loose';
      else if (s > o.suspectEnter) next = 'suspect';
    } else if (this.mount === 'suspect') {
      if (s > o.looseEnter) next = 'loose';
      else if (s < o.suspectExit) next = 'rigid';
    } else if (s < o.looseExit) {
      next = s < o.suspectExit ? 'rigid' : 'suspect';
    }
    if (next !== this.mount && (held >= o.mountDwellS || !Number.isFinite(held))) {
      this.mount = next;
      this.mountSince = t;
    }
    this.handheld = this.mount === 'loose' && (this.gravSwingRms.rms > o.handheldSwingRad || this.gravRateRms.rms > o.handheldRateRadS);
  }

  private updatePhysics(raw: MotionSample, v: VehicleMotionSample, dt: number): void {
    const o = this.opts;
    const rr = raw.rotationRate;
    const rawMag = rr ? Math.hypot(finite(rr.x), finite(rr.y), finite(rr.z)) : 0;
    const yawOver = Math.abs(finite(v.yawRate)) > o.yawRateLimit || rawMag > o.yawRateLimit;
    const ayOver = Math.abs(finite(v.ay)) > o.lateralAccelLimit;
    const axOver = Math.abs(finite(v.ax)) > o.longitudinalAccelLimit;
    this.yawOverS = yawOver ? this.yawOverS + dt : 0;
    this.ayOverS = ayOver ? this.ayOverS + dt : 0;
    this.axOverS = axOver ? this.axOverS + dt : 0;
    let reason = 0;
    if (this.yawOverS > o.physicsSustainS) reason |= PHYS_YAW;
    if (this.ayOverS > o.physicsSustainS) reason |= PHYS_LATERAL;
    if (this.axOverS > o.physicsSustainS) reason |= PHYS_LONGITUDINAL;
    if (reason) {
      this.physics = 'implausible';
      this.physicsReason |= reason;
      this.physicsOkS = 0;
    } else if (this.physics === 'implausible') {
      if (!yawOver && !ayOver && !axOver) this.physicsOkS += dt;
      else this.physicsOkS = 0;
      if (this.physicsOkS >= o.physicsRecoverS) {
        this.physics = 'ok';
        this.physicsReason = 0;
      }
    }
  }

  private updateGps(): void {
    const o = this.opts;
    if (!this.hasFix) {
      this.gps = 'none';
      this.gpsAgeS = Number.isFinite(this.firstMotionT) && Number.isFinite(this.now) ? Math.max(0, this.now - this.firstMotionT) : 0;
      this.gpsPoorLatched = false;
      return;
    }
    this.gpsAgeS = Number.isFinite(this.now) ? Math.max(0, this.now - this.lastFixT) : 0;
    if (this.gpsAgeS > o.gpsMaxAgeS) {
      this.gps = 'none';
      return;
    }
    if (this.hAcc > o.gpsPoorHAcc) this.gpsPoorLatched = true;
    else if (this.hAcc <= o.gpsGoodHAcc) this.gpsPoorLatched = false;
    this.gps = this.gpsPoorLatched ? 'poor' : 'good';
  }

  private recompute(): void {
    this.updateGps();
    const o = this.opts;
    const gpsFresh = this.hasFix && this.gpsAgeS <= o.gpsMaxAgeS;
    this.gpsVeto = gpsFresh && this.gpsSpeed >= 0 && this.gpsSpeed < o.minGpsSpeed;
    this.drivenNow = gpsFresh && this.gpsSpeed >= o.minGpsSpeed && this.speedOk;
    // The calibrator's own verdict is an INDEPENDENT veto: the sway cues are tuned on a
    // signature, and a mount can sit in a gap between their thresholds while the calibration
    // behind every angle in the run has already fallen apart.
    this.calOk = !Number.isFinite(this.calQuality) || (this.calQuality >= o.minCalibrationQuality && (this.calForward || !o.requireForwardResolved));
    this.driftPlausible =
      this.hasState && this.speedOk && !this.gpsVeto && this.mount !== 'loose' && this.physics === 'ok' && !this.slipInconsistent && this.calOk;

    let mask = 0;
    if (this.mount === 'loose') mask |= 1 << 0;
    if (this.handheld) mask |= 1 << 1;
    if (!this.calOk) mask |= 1 << 2;
    if (this.physicsReason & PHYS_YAW) mask |= 1 << 3;
    if (this.physicsReason & (PHYS_LATERAL | PHYS_LONGITUDINAL)) mask |= 1 << 4;
    if (this.gps === 'poor') mask |= 1 << 5;
    if (this.gps === 'none') mask |= 1 << 6;
    if (this.slideClaimed && (!this.speedOk || this.gpsVeto)) mask |= 1 << 7;
    if (this.slideClaimed && this.slipInconsistent) mask |= 1 << 8;
    if (mask !== this.flagMask) {
      this.flagMask = mask;
      this.flags = FLAG_ORDER.filter((_, i) => mask & (1 << i));
    }
    // `suspect` and `loose` need a threshold crossed by measured energy, so an average that is
    // still filling cannot reach them; `rigid` is what an empty average reads whatever the
    // mount is doing, so that one — and only that one — waits for a full window.
    this.mountConfident = this.mount !== 'rigid' || this.mountCueEvidenceS() >= o.windowS;
    const mountMsg = this.mountSentence();
    if (mountMsg !== this.mountMessage) this.mountMessage = mountMsg;
    // "Waiting for a GPS fix" is not NEWS until a fix has had as long to arrive as one is
    // allowed to be stale — before that it is just the normal first seconds of every session.
    // `message` still says it, because that line is never empty and there is nothing better to
    // say; `gpsMessage` is a row a caller draws, so it stays empty until there is one to draw.
    const gpsMsg = this.gps === 'poor' || this.hasFix || this.gpsAgeS >= o.gpsMaxAgeS ? this.gpsSentence() : '';
    if (gpsMsg !== this.gpsMessage) this.gpsMessage = gpsMsg;
    const msg = this.composeMessage();
    if (msg !== this.message) this.message = msg;
  }

  /** The least evidence any mount cue is running on, seconds of motion. */
  private mountCueEvidenceS(): number {
    return Math.min(this.gravRateRms.evidenceS, this.gravSwingRms.evidenceS, this.offYawRms.evidenceS, this.azRms.evidenceS);
  }

  /** What the monitor has to say about the MOUNT, whatever else is also wrong. */
  private mountSentence(): string {
    if (this.handheld) return 'Phone looks hand-held — clip it into a rigid mount';
    if (this.mount === 'loose') return 'Phone is moving in its mount — tighten it';
    if (this.mount === 'suspect') return 'Phone may be shifting in its mount — check it is tight';
    return '';
  }

  /** What the monitor has to say about the GPS FIX, whatever else is also wrong. */
  private gpsSentence(): string {
    if (this.gps === 'none') {
      return this.hasFix ? `GPS signal lost ${this.gpsAgeS.toFixed(0)} s ago — waiting for it to come back` : 'Waiting for a GPS fix — drift angles need it';
    }
    if (this.gps === 'poor') return `GPS accuracy is poor (±${Math.round(this.hAcc)} m) — drift angles may be off`;
    return '';
  }

  /**
   * The ONE thing to say: of everything wrong at this instant, the root cause.
   *
   * The order is the point, and it is not the order the conditions are measured in — a
   * hand-held phone explains most implausible readings, and a calibration that cannot say which
   * way the car points explains a slide that does not match its g-forces. Each sentence comes
   * from the same function that answers about that topic on its own, so a caller quoting
   * `mountMessage` and a caller quoting `message` can never describe one condition in two
   * different ways.
   */
  private composeMessage(): string {
    const o = this.opts;
    // root causes first: a hand-held / loose phone explains most implausible readings
    if (this.handheld || this.mount === 'loose') return this.mountSentence();
    if (!this.calOk) {
      return this.calForward
        ? 'Still working out how the phone sits in the car — drive straight for a few seconds'
        : "Can't tell which way the car points — mount the phone firmly and drive straight for a few seconds";
    }
    if (this.physics === 'implausible') {
      const r = this.physicsReason;
      const what =
        r & PHYS_YAW ? 'spinning faster than any car can turn' : r & PHYS_LATERAL ? 'showing more sideways g than tyres can make' : 'showing more braking/launch g than a car can make';
      return `Sensor readings are ${what} — check the phone is fixed to the car`;
    }
    if (this.gps !== 'good') return this.gpsSentence();
    // A shifting cradle outranks the speed gate and the slip-consistency gate: both of those are
    // symptoms a moving phone produces, and telling a driver to go FASTER because the mount is
    // rattling sends them at the problem with more speed.
    if (this.mount === 'suspect') return this.mountSentence();
    if (this.slideClaimed && (!this.speedOk || this.gpsVeto)) {
      return `Too slow to count as a drift — get above ${Math.round(o.minDriftSpeed * 3.6)} km/h`;
    }
    if (this.slideClaimed && this.slipInconsistent) return "Slide doesn't match the g-forces — not counting it";
    if (!this.hasState) return 'Sensors look good — waiting for the first estimate';
    return 'Sensors look good — phone is solid and GPS is locked';
  }
}
