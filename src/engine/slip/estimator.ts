/**
 * Slip-angle estimator: fuses the 100 Hz vehicle-frame IMU with ~1 Hz, ~0.5 s-late GPS.
 *
 * ── Physics ────────────────────────────────────────────────────────────────────────────
 *  ψ   heading (nose direction)      ψ̇ = r             (r = true yaw rate)
 *  χ   course  (velocity direction)  χ̇ = (a_y cos β − a_x sin β) / v   (lateral accel ⟂ velocity)
 *  β   slip angle = χ − ψ            β̇ = χ̇ − r
 *  v   ground speed                  v̇ = a_x cos β + a_y sin β          (accel ∥ velocity)
 * (both accel identities follow from a = d(v_b)/dt + ω × v_b with v_b = v·(cos β, sin β)).
 *
 * ── The phone is not the centre of gravity ─────────────────────────────────────────────
 * The IMU, and the GPS antenna, sit at the phone: a point d = (d_x, 0) ahead of the CG.
 * Every measurement therefore describes the PHONE's motion — a_y(phone) = a_y + ṙ·d_x,
 * v(phone) = v + r × d, and the reported course is the direction the PHONE travels, which
 * during a fast yaw differs from the CG's by atan(r·d_x / v) (several degrees in a hairpin).
 * Because the phone is rigidly attached to the body, its own (a, v, r) satisfy exactly the
 * same kinematic identities as the CG's, so the whole filter simply runs AT THE PHONE and
 * `compose()` maps the result back to the CG: v_cg = v_phone − r × d, which also un-does
 * the course offset. Nothing in the propagation has to know d_x; only the output map, the
 * zero-slip prior (a gripping car has β(CG) ≈ 0, hence β(phone) ≈ atan(r·d_x/v), NOT 0)
 * and the reported position do. A wrong d_x therefore degrades gracefully: the error it
 * leaves behind is (d_x,assumed − d_x,true)·r/v.
 *
 * ── Filters ────────────────────────────────────────────────────────────────────────────
 *  1. Heading/slip EKF, state x = [β, ψ_off, b, s], P 4×4, all at the phone.
 *     The gyro measures r_m = r + b (b = slowly wandering bias). Integrating r_m gives a raw
 *     heading ψ_g; the true heading is ψ = ψ_g + ψ_off with ψ̇_off = −b. GPS course observes
 *     χ = ψ_g + ψ_off + β, i.e. only the SUM ψ_off + β. Note θ = ψ_off + β evolves as
 *     θ̇ = χ̇ − r_m, which is fully known from the accelerometer, speed and raw gyro — so the
 *     course-vs-gyro relation is tracked very tightly; what is NOT observable from GPS is
 *     how θ splits into "gyro offset/bias" and "actual slip". The split comes from a weak
 *     prior: in steady straight driving (low |a_y|, low |r|, low |β̇| for a while) the tyres
 *     are not sliding. With standstill detected, r_m directly measures b.
 *     s is a lateral specific-force SCALE error: the accelerometer sits in the car body,
 *     which rolls into the corner (≈3°/g) and may sit on a banked road, so the measured
 *     lateral specific force is (1 − G·k_roll)·a_y — several percent low, and the roll
 *     gradient is a property of the car nobody told us. Left uncorrected that is a few
 *     percent of EVERY degree of course change, i.e. ~1° of β per 90° corner: the largest
 *     single error in the whole filter. It is observable because its regressor (Δχ) and the
 *     gyro bias's (Δt) differ sharply inside a corner.
 *     Prediction (v > minSpeed): β̇ = χ̇ − r_m + b, ψ̇_off = −b, ḃ = ṡ = 0 (+ random walks).
 *     Measurements: GPS course (H=[1, 1, 0, −Δ∂χ/∂s], latency-compensated through a history
 *     ring buffer), zero-slip prior (H=[1 0 0 0]), standstill gyro bias (H=[0 0 1 0]).
 *  2. Speed KF, state [v, b_x]: v̇ = (a_x − b_x) cos β + a_y(1+s) sin β; GPS speed measurement
 *     (latency-compensated). b_x is the longitudinal specific-force bias — accelerometer bias
 *     plus, dominantly, the road GRADE, which tilts gravity into the car's x axis (a 6 %
 *     descent = 0.59 m/s²). It is fed back into χ̇, where it matters whenever β ≠ 0: on a
 *     touge descent an uncorrected grade is ~1.5°/s of course-rate error at 40° of slip.
 *     Innovation-consistency boost so a speed the accelerometer cannot explain (GPS
 *     returning after a dropout) is caught within one or two fixes.
 *  3. Position: ENU dead reckoning along the estimated course at the fused speed; GPS
 *     position (latency-compensated) yields a Kalman-weighted correction that is applied
 *     smoothly (exponential blend, ~0.5 s) so a 100 Hz trail never teleports.
 *  4. Online GPS-latency adaptation: a bank of candidate latencies is scored by course/speed
 *     innovation consistency whenever the course or speed is changing. The receiver also
 *     LOW-PASSES course and speed (τ ≈ 0.3 s) before reporting them, which is a lag on top
 *     of the delivery latency and is modelled explicitly: the history keeps low-passed
 *     copies of the dead-reckoning integrals and the delayed measurement is compared
 *     against those, so only the residual timing jitter has to be paid for in extra noise.
 */
import {
  G,
  type GpsSample,
  type SlipState,
  type Vec3,
  type VehicleMotionSample,
  clamp,
  courseDegToMath,
  degToRad,
  wrapAngle,
} from '../types';
import { History } from './history';

/**
 * Motion input. `gravity` is the OS gravity estimate rotated into the vehicle frame (m/s²,
 * ≈ (0, 0, −9.81) at rest). When present the estimator works from the TOTAL specific force
 * (user accel + reported gravity) projected onto the vehicle's horizontal plane, which is
 * immune to the OS gravity estimate leaning into sustained cornering/braking — the dominant
 * accelerometer error in a car. Without it the estimator falls back to ax/ay as given.
 */
export type SlipMotionInput = VehicleMotionSample & { gravity?: Vec3 };

export interface SlipOptions {
  /** Assumed GPS delivery latency (s): a fix received at t describes the state at t − gpsLatencyS. */
  gpsLatencyS: number;
  /** Adapt the latency online from course/speed innovation consistency. */
  adaptLatency: boolean;
  latencyMinS: number;
  latencyMaxS: number;
  /** 1σ residual latency uncertainty (s); inflates GPS noise while the course/speed is changing. */
  latencyJitterS: number;
  /** Speed floor (m/s) below which the course — and therefore β — is meaningless. */
  minSpeed: number;
  /** The β kinematics (which divide by v) only run while the fused speed 1σ is below this (m/s). */
  speedKnownSigma: number;
  /** GPS course 1σ noise model: sigmaDeg = courseSigmaDeg + courseSigmaDegOverV / v. */
  courseSigmaDeg: number;
  courseSigmaDegOverV: number;
  /** GPS speed 1σ (m/s). */
  gpsSpeedSigma: number;
  /** Position measurement 1σ = max(posSigmaMin, hAccScale · hAcc) metres. */
  posSigmaMin: number;
  hAccScale: number;
  /** Position dead-reckoning noise density (m²/s) = posDriftPerS + posDriftPerV2 · v². */
  posDriftPerS: number;
  posDriftPerV2: number;
  /** Accelerometer noise (m/s², 1σ) reaching the β kinematics (χ̇ = a/v) after vibration. */
  accelSigma: number;
  /** Process noise of the speed KF (m/s² 1σ): accel bias drift, projection error through β̂, bumps. */
  speedAccelSigma: number;
  /** Fractional uncertainty of the χ̇ = a/v term (speed error, scale, misalignment). */
  accelScaleSigma: number;
  /** Longitudinal accel bias random walk (m/s²/√s) and initial 1σ (m/s²). */
  accelBiasWalk: number;
  accelBiasSigma0: number;
  /**
   * Lateral specific-force scale error s (a_y,true ≈ (1+s)·a_y,measured): initial 1σ, random
   * walk (per √s — banking changes corner by corner) and the clamp on |s|. 0.06 covers a
   * roll gradient anywhere in 2–6 °/g.
   */
  ayScaleSigma0: number;
  ayScaleWalk: number;
  ayScaleMax: number;
  /** Gyro white noise (rad/s), bias random walk (rad/s/√s) and initial bias 1σ (rad/s). */
  gyroSigma: number;
  gyroBiasWalk: number;
  gyroBiasSigma0: number;
  /**
   * "Not sliding" prior: the CG's slip is ≈ 0 ± (priorSigmaDeg + priorSigmaDegPerAy · |a_y|),
   * i.e. the PHONE's β ≈ atan(r·d_x / v), applied at priorHz once the car has been either
   *   - calm for priorHoldS: |β̇| < priorBetaDotMax (rad/s) and |β̂ − β_grip| < priorBetaMaxDeg, or
   *   - straight for straightHoldS: |a_y| < straightAyMax, |r| < straightYawMax, |β̇| small.
   * The calm branch covers straights and grip cornering (weakly: real cars run a degree or two
   * of slip at 0.5 g) and pins the heading-offset / slip split. The straight branch ignores β̂
   * so a wrong β̂ can never lock itself in — but it needs a long hold, because a yaw reversal
   * mid-drift passes through r ≈ 0, a_y ≈ 0 for up to a second with β far from zero.
   * Prior innovations are gated like GPS ones (soft-rejected unless they persist).
   */
  priorSigmaDeg: number;
  priorSigmaDegPerAy: number;
  priorHz: number;
  priorBetaDotMax: number;
  priorBetaMaxDeg: number;
  priorHoldS: number;
  straightAyMax: number;
  straightYawMax: number;
  straightHoldS: number;
  /** Standstill gyro-bias measurement 1σ (rad/s) per sample. */
  standstillGyroSigma: number;
  /** Position correction blend time constant (s): ~63 % applied after this, ~80 % after 0.5 s. */
  positionBlendS: number;
  /** β decay time constant toward 0 below minSpeed (s). */
  lowSpeedDecayS: number;
  /** Seconds without a usable GPS course after which `valid` drops. */
  courseTimeoutS: number;
  /** `valid` requires betaSigma below this (rad). */
  validSigmaMax: number;
  /** Innovation gate (in σ) beyond which a GPS course/speed is down-weighted. */
  gateSigma: number;
  /** Receiver-side low-pass on reported GPS course/speed (s); 0 = none. Position is not filtered. */
  gpsFilterS: number;
  /** Phone position ahead of the CG along x (m): GPS velocity and IMU are taken there, outputs refer to the CG. */
  leverArmX: number;
  /** Body roll per lateral accel (rad per m/s²) and pitch per longitudinal accel, used with `gravity`. */
  bodyRollPerAy: number;
  bodyPitchPerAx: number;
  /** Ring-buffer capacity in samples (must cover latencyMaxS + jitter at the motion rate). */
  historySamples: number;
}

export const DEFAULT_SLIP_OPTIONS: SlipOptions = {
  gpsLatencyS: 0.45,
  adaptLatency: true,
  latencyMinS: 0.1,
  latencyMaxS: 1.2,
  latencyJitterS: 0.08,
  minSpeed: 2,
  speedKnownSigma: 2,
  courseSigmaDeg: 1.5,
  courseSigmaDegOverV: 6,
  gpsSpeedSigma: 0.3,
  posSigmaMin: 1.5,
  hAccScale: 0.4,
  posDriftPerS: 0.15,
  posDriftPerV2: 0.004,
  accelSigma: 0.25,
  speedAccelSigma: 0.12,
  accelScaleSigma: 0.02,
  accelBiasWalk: 0.05,
  accelBiasSigma0: 0.15,
  ayScaleSigma0: 0.06,
  ayScaleWalk: 0.02,
  ayScaleMax: 0.25,
  gyroSigma: 0.003,
  gyroBiasWalk: 0.0002,
  gyroBiasSigma0: 0.03,
  priorSigmaDeg: 1.0,
  priorSigmaDegPerAy: 0.6,
  priorHz: 5,
  priorBetaDotMax: 0.05,
  priorBetaMaxDeg: 6,
  priorHoldS: 0.6,
  straightAyMax: 1.2,
  straightYawMax: 0.06,
  straightHoldS: 2.5,
  standstillGyroSigma: 0.01,
  positionBlendS: 0.3,
  lowSpeedDecayS: 0.4,
  courseTimeoutS: 8,
  validSigmaMax: 0.35,
  gateSigma: 4,
  gpsFilterS: 0.3,
  leverArmX: 0.9,
  bodyRollPerAy: 0.004,
  bodyPitchPerAx: 0.003,
  historySamples: 512,
};

const M_PER_DEG_LAT = 111132.954;
const BETA_LIMIT = 1.45; // ~83°: keeps cos β away from 0 in the kinematics

/** Sum of squared residuals after a least-squares line fit y = a + b·(t − t0). */
function detrendedSumSq(pts: Array<{ t: number }>, t0: number, y: Float64Array): number {
  const m = pts.length;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < m; i++) {
    const x = pts[i].t - t0;
    sx += x;
    sy += y[i];
    sxx += x * x;
    sxy += x * y[i];
  }
  const den = m * sxx - sx * sx;
  const b = Math.abs(den) > 1e-9 ? (m * sxy - sx * sy) / den : 0;
  const a = (sy - b * sx) / m;
  let acc = 0;
  for (let i = 0; i < m; i++) {
    const r = y[i] - (a + b * (pts[i].t - t0));
    acc += r * r;
  }
  return acc;
}

function finite(...xs: number[]): boolean {
  for (const x of xs) if (!Number.isFinite(x)) return false;
  return true;
}

/** Heading/slip EKF state indices: x = [β, ψ_off, b, s]. */
const N = 4;
const IB = 0;
const IO = 1;
const IG = 2;
const IS = 3;

export class SlipEstimator {
  readonly opts: SlipOptions;

  // ── heading / slip EKF ─────────────────────────────────────────────
  private beta = 0;
  private psiOff = 0;
  private bias = 0;
  private ayScale = 0;
  private P = new Float64Array(N * N);
  private psiG = 0; // raw ∫ r_m dt, wrapped
  // scratch space for the EKF (no per-sample allocation)
  private readonly Phi = new Float64Array(N * N);
  private readonly tmp = new Float64Array(N * N);
  private readonly hRow = new Float64Array(N);
  private readonly ph = new Float64Array(N);

  // ── speed KF ───────────────────────────────────────────────────────
  private vel = 0;
  private aBias = 0;
  private Pv = new Float64Array(4);

  // ── dead-reckoning integrals + history for latency compensation ────
  private cInt = 0;
  private vInt = 0;
  private xInt = 0;
  private yInt = 0;
  private sInt = 0;
  private cLp = 0;
  private vLp = 0;
  private sLp = 0;
  private hist: History;

  // ── position ───────────────────────────────────────────────────────
  private posX = 0;
  private posY = 0;
  private pendX = 0;
  private pendY = 0;
  private Ppos = 0;
  private originLat = NaN;
  private originLon = NaN;
  private mPerDegLon = M_PER_DEG_LAT;

  // ── bookkeeping ────────────────────────────────────────────────────
  private lastT = NaN;
  private lastAx = 0;
  private lastAy = 0;
  private lastRawYaw = 0;
  private lastBetaDot = 0;
  private courseLocked = false;
  private lastCourseT = -Infinity;
  private lastGpsT = -Infinity;
  private lastGpsSpeed = NaN;
  private lastFixX = NaN;
  private lastFixY = NaN;
  private lastFixT = NaN;
  private calmSince = NaN;
  private straightSince = NaN;
  private priorGateRun = 0;
  private betaDotFiltered = 0;
  private priorStride = 20;
  private stepCounter = 0;
  private courseGateRun = 0;
  private latency: number;
  private latencyBank: Float64Array;
  /** Sliding window of fixes for latency estimation: GPS course/speed + DR integrals at each candidate latency. */
  private latFixes: Array<{ t: number; chi: number; v: number; c: Float64Array; vi: Float64Array; tk: Float64Array }> = [];
  private latencyUpdates = 0;
  private currentState: SlipState;
  /** Test-only: receives a snapshot of the internal state every motion sample. */
  debugSink?: (d: Record<string, number>) => void;

  constructor(opts: Partial<SlipOptions> = {}) {
    const given = Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined)) as Partial<SlipOptions>;
    this.opts = { ...DEFAULT_SLIP_OPTIONS, ...given };
    this.hist = new History(Math.max(64, Math.round(this.opts.historySamples)));
    this.latency = this.opts.gpsLatencyS;
    const nBank = Math.max(3, Math.round((this.opts.latencyMaxS - this.opts.latencyMinS) / 0.1) + 1);
    this.latencyBank = new Float64Array(nBank);
    for (let i = 0; i < nBank; i++) this.latencyBank[i] = this.opts.latencyMinS + (i * (this.opts.latencyMaxS - this.opts.latencyMinS)) / (nBank - 1);
    this.currentState = this.emptyState(0);
    this.reset();
  }

  /** Local ENU origin (first usable fix), or null before any fix. */
  get origin(): { lat: number; lon: number } | null {
    return Number.isFinite(this.originLat) ? { lat: this.originLat, lon: this.originLon } : null;
  }

  /** GPS latency currently assumed (s) — equals gpsLatencyS unless adaptLatency moved it. */
  get gpsLatency(): number {
    return this.latency;
  }

  /** Current gyro-bias estimate (rad/s) and its 1σ. */
  get gyroBias(): { value: number; sigma: number } {
    return { value: this.bias, sigma: Math.sqrt(Math.max(this.P[IG * N + IG], 0)) };
  }

  /**
   * Estimated lateral specific-force scale error and its 1σ: a_y,true ≈ (1+s)·a_y,measured.
   * Physically ≈ G·(roll gradient) + G·(mean banking per unit a_y); ~5 % on a stiff car.
   */
  get ayScaleError(): { value: number; sigma: number } {
    return { value: this.ayScale, sigma: Math.sqrt(Math.max(this.P[IS * N + IS], 0)) };
  }

  /** Estimated longitudinal specific-force bias (m/s²) — accelerometer bias plus road grade. */
  get axBias(): number {
    return this.aBias;
  }

  get state(): SlipState {
    return this.currentState;
  }

  /** Convert a lat/lon to this estimator's local ENU frame (metres). NaN before the origin exists. */
  toLocal(lat: number, lon: number): { x: number; y: number } {
    if (!Number.isFinite(this.originLat)) return { x: NaN, y: NaN };
    return { x: (lon - this.originLon) * this.mPerDegLon, y: (lat - this.originLat) * M_PER_DEG_LAT };
  }

  reset(): void {
    const o = this.opts;
    this.beta = 0;
    this.psiOff = 0;
    this.bias = 0;
    this.ayScale = 0;
    this.P.fill(0);
    this.P[IB * N + IB] = degToRad(5) ** 2;
    this.P[IO * N + IO] = Math.PI ** 2;
    this.P[IG * N + IG] = o.gyroBiasSigma0 ** 2;
    this.P[IS * N + IS] = o.ayScaleSigma0 ** 2;
    this.psiG = 0;
    this.vel = 0;
    this.aBias = 0;
    this.Pv.fill(0);
    this.Pv[0] = 30 ** 2;
    this.Pv[3] = o.accelBiasSigma0 ** 2;
    this.cInt = 0;
    this.vInt = 0;
    this.xInt = 0;
    this.yInt = 0;
    this.sInt = 0;
    this.cLp = 0;
    this.vLp = 0;
    this.sLp = 0;
    this.hist.clear();
    this.posX = 0;
    this.posY = 0;
    this.pendX = 0;
    this.pendY = 0;
    this.Ppos = 0;
    this.originLat = NaN;
    this.originLon = NaN;
    this.mPerDegLon = M_PER_DEG_LAT;
    this.lastT = NaN;
    this.lastAx = 0;
    this.lastAy = 0;
    this.lastRawYaw = 0;
    this.lastBetaDot = 0;
    this.courseLocked = false;
    this.lastCourseT = -Infinity;
    this.lastGpsT = -Infinity;
    this.lastGpsSpeed = NaN;
    this.lastFixX = NaN;
    this.lastFixY = NaN;
    this.lastFixT = NaN;
    this.calmSince = NaN;
    this.straightSince = NaN;
    this.priorGateRun = 0;
    this.betaDotFiltered = 0;
    this.stepCounter = 0;
    this.courseGateRun = 0;
    this.latency = o.gpsLatencyS;
    this.latFixes = [];
    this.latencyUpdates = 0;
    this.priorStride = Math.max(1, Math.round(100 / Math.max(0.5, o.priorHz)));
    this.currentState = this.emptyState(0);
  }

  private emptyState(t: number): SlipState {
    return {
      t,
      beta: 0,
      betaSigma: Math.PI / 2,
      heading: 0,
      course: 0,
      speed: 0,
      yawRate: 0,
      ay: 0,
      ax: 0,
      x: 0,
      y: 0,
      valid: false,
    };
  }

  // ═══════════════════════════════════════════════════════════════════
  //  Motion (100 Hz)
  // ═══════════════════════════════════════════════════════════════════
  pushMotion(m: SlipMotionInput): SlipState {
    if (!finite(m.t, m.ax, m.ay, m.yawRate)) return this.currentState;
    const o = this.opts;
    let dt = Number.isFinite(this.lastT) ? m.t - this.lastT : 0;
    let gap = 0;
    if (dt < 0) dt = 0; // out-of-order sample: do not integrate backwards
    if (dt > 0.25) {
      // a sample gap: integrate one nominal step, but grow uncertainty for the whole gap
      gap = dt;
      dt = 0.01;
    }
    this.lastT = m.t;
    this.stepCounter++;
    const r = m.yawRate;
    let ax = m.ax;
    let ay = m.ay;
    if (m.gravity && finite(m.gravity.x, m.gravity.y, m.gravity.z)) {
      // total specific force, horizontal components; then undo the body roll/pitch gravity leak
      ax = (m.ax + m.gravity.x) / (1 - G * o.bodyPitchPerAx);
      ay = (m.ay + m.gravity.y) / (1 - G * o.bodyRollPerAy);
    }
    const qCal = Number.isFinite(m.calibrationQuality) ? clamp(m.calibrationQuality, 0, 1) : 1;
    const calInflate = 1 + 3 * (1 - qCal);
    // calibrated specific force: lateral scale (body roll / banking) and longitudinal bias
    // (accelerometer bias + road grade) both come from filter states.
    const ayC = ay * (1 + this.ayScale);
    const axC = ax - this.aBias;

    // ── speed KF prediction ─────────────────────────────────────────
    const cb = Math.cos(this.beta);
    const sb = Math.sin(this.beta);
    const aLong = axC * cb + ayC * sb;
    this.vInt += (ax * cb + ayC * sb) * dt; // raw (un-debiased) integral: see pushGps
    this.vel += aLong * dt;
    if (this.vel < 0) this.vel = 0;
    {
      // F = [[1, -cosβ·dt],[0, 1]]; P = F P Fᵀ + Q
      const fb = cb * dt;
      const p0 = this.Pv[0];
      const p1 = this.Pv[1];
      const p3 = this.Pv[3];
      const n0 = p0 - 2 * fb * p1 + fb * fb * p3;
      const n1 = p1 - fb * p3;
      const qv = (o.speedAccelSigma * calInflate) ** 2 + (0.02 * Math.abs(aLong)) ** 2;
      this.Pv[0] = n0 + qv * (dt + gap);
      this.Pv[1] = n1;
      this.Pv[2] = n1;
      this.Pv[3] = p3 + o.accelBiasWalk ** 2 * (dt + gap);
    }

    // ── raw gyro heading ────────────────────────────────────────────
    this.psiG = wrapAngle(this.psiG + r * dt);

    // ── heading / slip EKF prediction ───────────────────────────────
    let chiDot: number; // course rate actually propagated this step
    let betaDot: number;
    let dSdt = 0; // ∂χ̇/∂s, the scale state's regressor
    // the β kinematics divide by v: only run them once the speed is actually known
    const speedKnown = this.Pv[0] < o.speedKnownSigma * o.speedKnownSigma;
    const moving = speedKnown && this.vel > o.minSpeed;
    const P = this.P;
    const qt = dt + gap;
    if (moving) {
      const vEff = Math.max(this.vel, o.minSpeed);
      const g = (ayC * cb - axC * sb) / vEff; // χ̇
      betaDot = g - r + this.bias;
      chiDot = g;
      dSdt = (ay * cb) / vEff;
      const dgdb = (-ayC * sb - axC * cb) / vEff; // ∂χ̇/∂β
      // x ← f(x)
      this.beta = clamp(this.beta + betaDot * dt, -BETA_LIMIT, BETA_LIMIT);
      this.psiOff = wrapAngle(this.psiOff - this.bias * dt);
      // Φ = I + F dt, F = [[∂χ̇/∂β, 0, 1, ∂χ̇/∂s], [0, 0, −1, 0], [0 0 0 0], [0 0 0 0]]
      const Phi = this.Phi;
      Phi.fill(0);
      Phi[IB * N + IB] = 1 + dgdb * dt;
      Phi[IB * N + IG] = dt;
      Phi[IB * N + IS] = dSdt * dt;
      Phi[IO * N + IO] = 1;
      Phi[IO * N + IG] = -dt;
      Phi[IG * N + IG] = 1;
      Phi[IS * N + IS] = 1;
      this.propagate(Phi);
      // Q: the accelerometer noise that survives into χ̇, gyro white noise (shared by β and
      // ψ_off with a negative cross-term, since both integrate the same r_m), and the two
      // parameter random walks.
      const sigG2 = ((o.accelSigma * calInflate) / vEff) ** 2 + (o.accelScaleSigma * calInflate * Math.abs(g)) ** 2;
      const sigR2 = (o.gyroSigma * calInflate) ** 2;
      P[IB * N + IB] += (sigG2 + sigR2) * qt;
      P[IB * N + IO] -= sigR2 * qt;
      P[IO * N + IB] = P[IB * N + IO];
      P[IO * N + IO] += sigR2 * qt;
    } else {
      // too slow for a course: hold β decaying toward 0, keep integrating the bias into ψ_off
      const k = dt > 0 ? Math.min(1, dt / o.lowSpeedDecayS) : 0;
      const dBeta = -this.beta * k;
      this.beta += dBeta;
      betaDot = dt > 0 ? dBeta / dt : 0;
      this.psiOff = wrapAngle(this.psiOff - this.bias * dt);
      chiDot = r - this.bias + betaDot;
      const restVar = degToRad(3) ** 2;
      P[IB * N + IB] += (restVar - P[IB * N + IB]) * k;
      for (let j = 0; j < N; j++) {
        if (j === IB) continue;
        P[IB * N + j] *= 1 - k;
        P[j * N + IB] = P[IB * N + j];
      }
      // ψ_off uncertainty grows with bias uncertainty; bias random-walks
      P[IO * N + IO] += (P[IG * N + IG] + o.gyroSigma ** 2) * qt;
      P[IO * N + IG] -= P[IG * N + IG] * qt;
      P[IG * N + IO] = P[IO * N + IG];
    }
    P[IG * N + IG] += o.gyroBiasWalk ** 2 * qt;
    P[IS * N + IS] += o.ayScaleWalk ** 2 * qt;
    this.cInt += chiDot * dt;
    this.sInt += dSdt * dt;
    this.lastBetaDot = betaDot;
    if (o.gpsFilterS > 0 && dt > 0) {
      const kf = Math.min(1, dt / o.gpsFilterS);
      this.cLp += (this.cInt - this.cLp) * kf;
      this.vLp += (this.vInt - this.vLp) * kf;
      this.sLp += (this.sInt - this.sLp) * kf;
    } else {
      this.cLp = this.cInt;
      this.vLp = this.vInt;
      this.sLp = this.sInt;
    }

    // ── position dead reckoning + smooth application of pending corrections ──
    if (this.courseLocked && this.vel > 0.05) {
      const chi = this.psiG + this.psiOff + this.beta;
      const dx = this.vel * Math.cos(chi) * dt;
      const dy = this.vel * Math.sin(chi) * dt;
      this.xInt += dx;
      this.yInt += dy;
      this.posX += dx;
      this.posY += dy;
    }
    if (dt > 0 && (this.pendX !== 0 || this.pendY !== 0)) {
      const kb = Math.min(1, dt / o.positionBlendS);
      const sx = this.pendX * kb;
      const sy = this.pendY * kb;
      this.posX += sx;
      this.posY += sy;
      this.pendX -= sx;
      this.pendY -= sy;
      if (Math.abs(this.pendX) < 1e-4 && Math.abs(this.pendY) < 1e-4) {
        this.posX += this.pendX;
        this.posY += this.pendY;
        this.pendX = 0;
        this.pendY = 0;
      }
    }
    if (Number.isFinite(this.originLat)) {
      this.Ppos += (o.posDriftPerS + o.posDriftPerV2 * this.vel * this.vel) * (dt + gap);
    }

    this.hist.push({ t: m.t, c: this.cInt, v: this.vInt, x: this.xInt, y: this.yInt, cl: this.cLp, vl: this.vLp, s: this.sInt, sl: this.sLp });

    // ── "not sliding" prior: the CG is not sliding while calm ──────
    // The phone runs ahead of the CG, so a gripping car still shows the phone a slip angle
    // of atan(r·d_x/v) — up to a couple of degrees in a tight corner. Pinning the phone's β
    // to zero instead would inject exactly that error into every corner.
    if (dt > 0) this.betaDotFiltered += (betaDot - this.betaDotFiltered) * Math.min(1, dt / 0.2);
    const betaGrip = moving ? Math.atan2((r - this.bias) * o.leverArmX, Math.max(this.vel, o.minSpeed)) : 0;
    const settled = moving && this.courseLocked && Math.abs(this.betaDotFiltered) < o.priorBetaDotMax;
    const straight = settled && Math.abs(ayC) < o.straightAyMax && Math.abs(r - this.bias) < o.straightYawMax;
    const calm = settled && Math.abs(this.beta - betaGrip) < degToRad(o.priorBetaMaxDeg);
    if (calm) {
      if (!Number.isFinite(this.calmSince)) this.calmSince = m.t;
    } else this.calmSince = NaN;
    if (straight) {
      if (!Number.isFinite(this.straightSince)) this.straightSince = m.t;
    } else this.straightSince = NaN;
    const calmReady = calm && m.t - this.calmSince >= o.priorHoldS;
    const straightReady = straight && m.t - this.straightSince >= o.straightHoldS;
    if ((calmReady || straightReady) && this.stepCounter % this.priorStride === 0) {
      const sig = degToRad(o.priorSigmaDeg + o.priorSigmaDegPerAy * Math.abs(ayC));
      let R = sig * sig;
      const nu = betaGrip - this.beta;
      const S = P[IB * N + IB] + R;
      if (nu * nu > o.gateSigma ** 2 * S) {
        // a β far from the grip value that the filter is confident about: distrust the prior
        // unless it persists
        this.priorGateRun++;
        if (this.priorGateRun < 3) R *= (nu * nu) / (o.gateSigma ** 2 * S);
      } else this.priorGateRun = 0;
      this.hRow.fill(0);
      this.hRow[IB] = 1;
      this.ekfUpdate(nu, this.hRow, R);
    }

    // ── standstill: the gyro reads its bias ───────────────────────────
    // GPS must agree that we are parked (reported speed, or — when the platform reports no
    // speed while parked — the displacement between the last fixes); the IMU must be quiet.
    const gpsSaysStill = Number.isFinite(this.lastGpsSpeed) && this.lastGpsSpeed < 0.8 && m.t - this.lastGpsT < 3;
    if (gpsSaysStill && this.vel < 0.5 && Math.abs(r) < 0.05 && Math.abs(ax) < 0.6 && Math.abs(ay) < 0.6) {
      this.hRow.fill(0);
      this.hRow[IG] = 1;
      this.ekfUpdate(r - this.bias, this.hRow, o.standstillGyroSigma ** 2);
    }

    this.lastAx = axC;
    this.lastAy = ayC;
    this.lastRawYaw = r;
    if (this.debugSink) {
      this.debugSink({
        t: m.t, beta: this.beta, psiOff: this.psiOff, bias: this.bias, s: this.ayScale, aBias: this.aBias,
        P00: P[0], P11: P[N + 1], P22: P[2 * N + 2], P33: P[3 * N + 3], Pv0: this.Pv[0],
        prior: calmReady || straightReady ? 1 : 0, ay: ayC, ax: axC, r, vel: this.vel, betaDotF: this.betaDotFiltered,
        chiDot: chiDot, moving: moving ? 1 : 0,
      });
    }
    this.compose(m.t);
    return this.currentState;
  }

  // ═══════════════════════════════════════════════════════════════════
  //  GPS (~1 Hz, delivered late)
  // ═══════════════════════════════════════════════════════════════════
  pushGps(g: GpsSample): void {
    if (!Number.isFinite(g.t)) return;
    const o = this.opts;
    const tNow = Number.isFinite(this.lastT) ? this.lastT : g.t;
    const tRx = Math.min(g.t, tNow + 0.05);
    const tFix = tRx - this.latency;
    const speedOk = Number.isFinite(g.speed) && g.speed >= 0;
    const courseOk = Number.isFinite(g.course) && g.course >= 0 && g.course <= 360;
    const posOk = Number.isFinite(g.lat) && Number.isFinite(g.lon) && Math.abs(g.lat) <= 90 && Math.abs(g.lon) <= 180;
    const hAcc = Number.isFinite(g.hAcc) && g.hAcc > 0 ? g.hAcc : 10;
    const jit = o.latencyJitterS;

    // dead-reckoned changes since the fix's true time (zero if no history yet)
    const h = this.hist.at(tFix);
    const hNow = this.hist.at(tNow);
    // the receiver reports low-passed course/speed: compare against the low-passed DR integrals
    const dC = h && hNow ? hNow.c - h.cl : 0;
    const dV = h && hNow ? hNow.v - h.vl : 0;
    const dX = h && hNow ? hNow.x - h.x : 0;
    const dY = h && hNow ? hNow.y - h.y : 0;
    // how much of that course change came from the (uncertain) lateral-accel scale
    const dS = h && hNow ? hNow.s - h.sl : 0;
    const clampedS = h ? h.clamped : 0;
    // local course / speed change across the latency jitter window → extra measurement noise
    const hA = this.hist.at(tFix - jit);
    const hB = this.hist.at(tFix + jit);
    const chiJit = hA && hB ? 0.5 * Math.abs(hB.cl - hA.cl) : 0;
    const vJit = hA && hB ? 0.5 * Math.abs(hB.vl - hA.vl) : 0;

    // latency adaptation uses the state BEFORE this fix's updates
    if (o.adaptLatency && h && hNow) this.scoreLatency(g, tRx, speedOk, courseOk);

    // ── speed ──────────────────────────────────────────────────────
    if (speedOk) {
      const vFixEst = this.vel - dV + this.aBias * (tNow - tFix);
      const nu = g.speed - vFixEst;
      const R = o.gpsSpeedSigma ** 2 + vJit * vJit + (0.5 * clampedS) ** 2;
      let S = this.Pv[0] + R;
      if (nu * nu > o.gateSigma ** 2 * S) {
        // the accelerometer cannot explain this speed (e.g. GPS back after a dropout, or a
        // speed step): trust the measurement more by inflating our own uncertainty
        this.Pv[0] = Math.max(this.Pv[0], nu * nu * 0.5);
        S = this.Pv[0] + R;
        if (Math.abs(nu) > 5) {
          // β was integrated as a_y / v with a badly wrong v — that estimate is void
          this.beta = 0;
          const P = this.P;
          P[IB * N + IB] = degToRad(5) ** 2;
          for (let j = 0; j < N; j++) {
            if (j === IB) continue;
            P[IB * N + j] = 0;
            P[j * N + IB] = 0;
          }
          this.calmSince = NaN;
        }
      }
      const k0 = this.Pv[0] / S;
      const k1 = this.Pv[1] / S;
      this.vel += k0 * nu;
      this.aBias += k1 * nu;
      if (this.vel < 0) this.vel = 0;
      this.aBias = clamp(this.aBias, -1.5, 1.5);
      const p0 = this.Pv[0];
      const p1 = this.Pv[1];
      const p3 = this.Pv[3];
      this.Pv[0] = (1 - k0) * p0;
      this.Pv[1] = (1 - k0) * p1;
      this.Pv[2] = this.Pv[1];
      this.Pv[3] = p3 - k1 * p1;
      this.lastGpsSpeed = g.speed;
    }

    if (!speedOk && posOk && Number.isFinite(this.originLat) && Number.isFinite(this.lastFixT) && tRx - this.lastFixT > 0.5) {
      // no reported speed: use speed-over-ground from the fix displacement as a coarse proxy
      // (only ever used for the standstill test, never fed to the speed filter)
      const p = this.toLocal(g.lat, g.lon);
      const sog = Math.hypot(p.x - this.lastFixX, p.y - this.lastFixY) / (tRx - this.lastFixT);
      this.lastGpsSpeed = Number.isFinite(sog) ? sog : NaN;
    }

    // ── course ─────────────────────────────────────────────────────
    const vForCourse = speedOk ? g.speed : this.vel;
    if (courseOk && vForCourse > o.minSpeed && this.vel > o.minSpeed * 0.75) {
      const chiMeas = courseDegToMath(g.course);
      const chiNow = this.psiG + this.psiOff + this.beta;
      const nu = wrapAngle(chiMeas - (chiNow - dC));
      const sigDeg = o.courseSigmaDeg + o.courseSigmaDegOverV / Math.max(vForCourse, 1);
      let R = degToRad(sigDeg) ** 2 + chiJit * chiJit + (0.3 * clampedS) ** 2;
      const P = this.P;
      if (!this.courseLocked) {
        // first lock: ψ_off absorbs the whole innovation (β keeps its prior)
        this.psiOff = wrapAngle(this.psiOff + nu);
        P[IO * N + IO] = R + P[IB * N + IB];
        P[IB * N + IO] = -P[IB * N + IB];
        P[IO * N + IB] = P[IB * N + IO];
        for (const j of [IG, IS]) {
          P[IO * N + j] = -P[IB * N + j];
          P[j * N + IO] = P[IO * N + j];
        }
        this.courseLocked = true;
        this.courseGateRun = 0;
      } else {
        // the measurement is the course at the fix time = χ_now − (DR change since then), and
        // that DR change carries the scale state, hence the −dS entry in H.
        this.hRow[IB] = 1;
        this.hRow[IO] = 1;
        this.hRow[IG] = 0;
        this.hRow[IS] = -dS;
        const S = this.innovationVar(this.hRow) + R;
        if (nu * nu > o.gateSigma ** 2 * S) {
          this.courseGateRun++;
          if (this.courseGateRun < 3) {
            R *= (nu * nu) / (o.gateSigma ** 2 * S); // soft rejection: down-weight the outlier
          } else {
            // three wild fixes in a row: it is us who are wrong — let the sum re-lock
            P[IO * N + IO] += nu * nu;
          }
        } else {
          this.courseGateRun = 0;
        }
        this.ekfUpdate(nu, this.hRow, R);
      }
      this.lastCourseT = tNow;
    }

    // ── position ───────────────────────────────────────────────────
    if (posOk) {
      if (!Number.isFinite(this.originLat)) {
        this.originLat = g.lat;
        this.originLon = g.lon;
        this.mPerDegLon = M_PER_DEG_LAT * Math.cos(degToRad(g.lat));
        this.posX = 0;
        this.posY = 0;
        this.pendX = 0;
        this.pendY = 0;
        this.Ppos = Math.max(o.posSigmaMin, o.hAccScale * hAcc) ** 2;
      } else {
        const p = this.toLocal(g.lat, g.lon);
        const estX = this.posX + this.pendX - dX;
        const estY = this.posY + this.pendY - dY;
        const ex = p.x - estX;
        const ey = p.y - estY;
        const R = Math.max(o.posSigmaMin, o.hAccScale * hAcc) ** 2 + (this.vel * clampedS) ** 2;
        let Pp = this.Ppos;
        const e2 = ex * ex + ey * ey;
        if (e2 > (o.gateSigma * 1.5) ** 2 * (Pp + R)) Pp = Math.max(Pp, e2 * 0.5); // teleport-sized error: re-anchor
        const k = Pp / (Pp + R);
        this.pendX += k * ex;
        this.pendY += k * ey;
        this.Ppos = (1 - k) * Pp;
      }
      const p = this.toLocal(g.lat, g.lon);
      this.lastFixX = p.x;
      this.lastFixY = p.y;
      this.lastFixT = tRx;
    }

    this.lastGpsT = tNow;
    if (Number.isFinite(this.lastT)) this.compose(this.lastT);
  }

  // ═══════════════════════════════════════════════════════════════════
  //  Internals
  // ═══════════════════════════════════════════════════════════════════

  /** P ← Φ P Φᵀ, symmetrised. Φ is `this.Phi`; `this.tmp` is scratch. */
  private propagate(Phi: Float64Array): void {
    const P = this.P;
    const T = this.tmp;
    // T = Φ P
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) {
        let s = 0;
        for (let k = 0; k < N; k++) s += Phi[i * N + k] * P[k * N + j];
        T[i * N + j] = s;
      }
    }
    // P = T Φᵀ
    for (let i = 0; i < N; i++) {
      for (let j = i; j < N; j++) {
        let s = 0;
        for (let k = 0; k < N; k++) s += T[i * N + k] * Phi[j * N + k];
        P[i * N + j] = s;
        P[j * N + i] = s;
      }
    }
  }

  /** H P Hᵀ for a row vector H (without the measurement noise). */
  private innovationVar(h: Float64Array): number {
    const P = this.P;
    let s = 0;
    for (let i = 0; i < N; i++) {
      if (h[i] === 0) continue;
      for (let j = 0; j < N; j++) {
        if (h[j] === 0) continue;
        s += h[i] * P[i * N + j] * h[j];
      }
    }
    return s;
  }

  /** Scalar EKF update on x = [β, ψ_off, b, s] with row vector H, innovation nu, noise R. */
  private ekfUpdate(nu: number, h: Float64Array, R: number): void {
    const P = this.P;
    const ph = this.ph;
    let S = R;
    for (let i = 0; i < N; i++) {
      let s = 0;
      for (let j = 0; j < N; j++) s += P[i * N + j] * h[j];
      ph[i] = s;
      S += h[i] * s;
    }
    if (!(S > 0) || !Number.isFinite(S)) return;
    const o = this.opts;
    this.beta = clamp(this.beta + (ph[IB] / S) * nu, -BETA_LIMIT, BETA_LIMIT);
    this.psiOff = wrapAngle(this.psiOff + (ph[IO] / S) * nu);
    this.bias = clamp(this.bias + (ph[IG] / S) * nu, -0.2, 0.2);
    this.ayScale = clamp(this.ayScale + (ph[IS] / S) * nu, -o.ayScaleMax, o.ayScaleMax);
    // P ← P − K (H P)  (Joseph form not needed for these well-conditioned scalar updates)
    for (let i = 0; i < N; i++) {
      for (let j = i; j < N; j++) {
        const v = P[i * N + j] - (ph[i] * ph[j]) / S;
        P[i * N + j] = v;
        P[j * N + i] = v;
      }
    }
    // guard against negative variances from round-off
    if (P[IB * N + IB] < 1e-8) P[IB * N + IB] = 1e-8;
    if (P[IO * N + IO] < 1e-8) P[IO * N + IO] = 1e-8;
    if (P[IG * N + IG] < 1e-12) P[IG * N + IG] = 1e-12;
    if (P[IS * N + IS] < 1e-8) P[IS * N + IS] = 1e-8;
  }

  /**
   * GPS latency estimation. For a sliding window of fixes we keep the GPS course/speed and the
   * dead-reckoned course/speed integrals evaluated at every candidate latency. For each
   * candidate, GPS − DR should be constant (the unknown heading offset / speed origin) up to
   * a slow DR drift (gyro/accel bias, a/v scale error) — so the cost is the residual after
   * fitting a straight line through that difference over the window. Using the raw integrals,
   * not the filter state, keeps the score independent of what the filter has already
   * absorbed under the currently assumed latency. Only a significant, well-formed minimum
   * moves the estimate.
   */
  private scoreLatency(g: GpsSample, tRx: number, speedOk: boolean, courseOk: boolean): void {
    const o = this.opts;
    const n = this.latencyBank.length;
    if (!courseOk || !speedOk || !this.courseLocked || g.speed < 4 || this.vel < 4) return;
    const oldest = this.hist.at(tRx - o.latencyMaxS);
    if (!oldest || oldest.clamped > 0.05) return; // history must cover the whole bank
    const c = new Float64Array(n);
    const vi = new Float64Array(n);
    const tk = new Float64Array(n);
    for (let k = 0; k < n; k++) {
      const hp = this.hist.at(tRx - this.latencyBank[k]);
      if (!hp) return;
      c[k] = hp.cl;
      vi[k] = hp.vl;
      tk[k] = tRx - this.latencyBank[k];
    }
    this.latFixes.push({ t: tRx, chi: courseDegToMath(g.course), v: g.speed, c, vi, tk });
    const WINDOW = 24;
    if (this.latFixes.length > WINDOW) this.latFixes.shift();
    const m = this.latFixes.length;
    if (m < 5) return;
    const sigC = degToRad(o.courseSigmaDeg + o.courseSigmaDegOverV / Math.max(g.speed, 1));
    const wC = 1 / (sigC * sigC);
    const wV = 1 / (o.gpsSpeedSigma * o.gpsSpeedSigma);
    const cost = new Float64Array(n);
    const e = new Float64Array(m);
    const f = new Float64Array(m);
    const t0 = this.latFixes[0].t;
    for (let k = 0; k < n; k++) {
      const f0 = this.latFixes[0];
      const ref = f0.chi - f0.c[k];
      for (let i = 0; i < m; i++) {
        const fx = this.latFixes[i];
        e[i] = wrapAngle(fx.chi - fx.c[k] - ref);
        f[i] = fx.v - (fx.vi[k] - this.aBias * fx.tk[k]);
      }
      cost[k] = wC * detrendedSumSq(this.latFixes, t0, e) + wV * detrendedSumSq(this.latFixes, t0, f);
    }
    let best = 0;
    for (let k = 1; k < n; k++) if (cost[k] < cost[best]) best = k;
    // significance: the neighbours must be clearly worse than the minimum (in σ² units)
    const left = best > 0 ? cost[best - 1] : Infinity;
    const right = best < n - 1 ? cost[best + 1] : Infinity;
    if (Math.min(left, right) - cost[best] < 8) return;
    let lHat = this.latencyBank[best];
    if (best > 0 && best < n - 1) {
      const den = left - 2 * cost[best] + right;
      if (den > 1e-9) lHat += (0.5 * (left - right) * (this.latencyBank[1] - this.latencyBank[0])) / den;
    }
    lHat = clamp(lHat, o.latencyMinS, o.latencyMaxS);
    this.latencyUpdates++;
    this.latency += (lHat - this.latency) * (this.latencyUpdates <= 4 ? 0.5 : 0.1);
  }

  private compose(t: number): void {
    const o = this.opts;
    const heading = wrapAngle(this.psiG + this.psiOff);
    // the filter state describes the phone position; refer β, speed and position to the CG
    const rYaw = this.lastRawYaw - this.bias;
    const vyCg = this.vel * Math.sin(this.beta) - rYaw * o.leverArmX;
    const vxCg = this.vel * Math.cos(this.beta);
    const betaCg = this.vel > o.minSpeed ? Math.atan2(vyCg, vxCg) : this.beta;
    const speedCg = Math.hypot(vxCg, vyCg);
    const course = wrapAngle(heading + betaCg);
    let sigma = Math.sqrt(Math.max(this.P[IB * N + IB], 0));
    if (!this.courseLocked) sigma = Math.max(sigma, degToRad(30));
    const courseFresh = t - this.lastCourseT < o.courseTimeoutS;
    const speedKnown = this.Pv[0] < o.speedKnownSigma * o.speedKnownSigma;
    const valid = this.courseLocked && courseFresh && speedKnown && this.vel > o.minSpeed && sigma < o.validSigmaMax;
    const st: SlipState = {
      t,
      beta: betaCg,
      betaSigma: sigma,
      heading,
      course,
      speed: speedCg,
      yawRate: rYaw,
      ay: this.lastAy,
      ax: this.lastAx,
      x: this.posX - o.leverArmX * Math.cos(heading),
      y: this.posY - o.leverArmX * Math.sin(heading),
      valid,
    };
    // every output must be finite — fall back to safe values if anything went wrong
    if (!finite(st.beta, st.betaSigma, st.heading, st.course, st.speed, st.yawRate, st.x, st.y)) {
      this.recoverFromNaN();
      st.beta = this.beta;
      st.betaSigma = Math.sqrt(this.P[0]);
      st.heading = wrapAngle(this.psiG + this.psiOff);
      st.course = wrapAngle(st.heading + this.beta);
      st.speed = this.vel;
      st.yawRate = this.lastRawYaw - this.bias;
      st.x = this.posX;
      st.y = this.posY;
      st.valid = false;
    }
    this.currentState = st;
  }

  private recoverFromNaN(): void {
    const o = this.opts;
    if (!Number.isFinite(this.beta)) this.beta = 0;
    if (!Number.isFinite(this.psiOff)) this.psiOff = 0;
    if (!Number.isFinite(this.bias)) this.bias = 0;
    if (!Number.isFinite(this.ayScale)) this.ayScale = 0;
    if (!Number.isFinite(this.psiG)) this.psiG = 0;
    if (!Number.isFinite(this.vel)) this.vel = 0;
    if (!Number.isFinite(this.aBias)) this.aBias = 0;
    if (!Number.isFinite(this.posX) || !Number.isFinite(this.posY)) {
      this.posX = 0;
      this.posY = 0;
    }
    if (!Number.isFinite(this.pendX) || !Number.isFinite(this.pendY)) {
      this.pendX = 0;
      this.pendY = 0;
    }
    let bad = false;
    for (let i = 0; i < N * N; i++) if (!Number.isFinite(this.P[i])) bad = true;
    if (bad) {
      this.P.fill(0);
      this.P[IB * N + IB] = degToRad(5) ** 2;
      this.P[IO * N + IO] = degToRad(10) ** 2;
      this.P[IG * N + IG] = o.gyroBiasSigma0 ** 2;
      this.P[IS * N + IS] = o.ayScaleSigma0 ** 2;
    }
    for (let i = 0; i < 4; i++) if (!Number.isFinite(this.Pv[i])) bad = true;
    if (bad) {
      this.Pv.fill(0);
      this.Pv[0] = 4;
      this.Pv[3] = o.accelBiasSigma0 ** 2;
    }
    if (!Number.isFinite(this.Ppos)) this.Ppos = 4;
    if (!finite(this.cInt, this.vInt, this.xInt, this.yInt, this.sInt, this.cLp, this.vLp, this.sLp)) {
      this.cInt = 0;
      this.vInt = 0;
      this.xInt = 0;
      this.yInt = 0;
      this.sInt = 0;
      this.cLp = 0;
      this.vLp = 0;
      this.sLp = 0;
      this.hist.clear();
    }
  }
}
