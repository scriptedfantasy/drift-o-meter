import { type GpsSample, type MotionSample, type MountCalibration, type VehicleMotionSample, clamp } from '../types';

/**
 * Mount calibration: phone frame → vehicle frame, with no user gesture.
 *
 *   UP       The OS gravity vector is NOT trusted as such: Core Motion's gravity leans into any
 *            acceleration sustained for a few seconds (the simulator models up to 10°), and its
 *            "user acceleration" loses the same amount.  But gravity + userAcceleration is the
 *            true specific force f, so the calibrator separates gravity itself:
 *              stage 1  inertial up û in the phone frame, propagated with the gyro (bias
 *                       estimated) and corrected toward −f̂ only when the accelerometer is
 *                       trustworthy: |f|≈g, small OS acceleration, small expected acceleration
 *                       from GPS (|Δv/Δt| and v·r) and small own separated acceleration;
 *              stage 2  body up = slow low-pass of û (τ≈2.5 s, slowed further under hard
 *                       acceleration so it does not chase body roll/pitch or banking).
 *            Own user acceleration a = f + g·û feeds everything downstream.  When û and the
 *            slow up disagree by more than `gravityJumpDeg` for `gravityJumpHoldS` the phone
 *            was knocked: the slow up snaps to û and every forward estimate is discarded.
 *
 *   FORWARD  the principal axis of the horizontal user acceleration, accumulated only during
 *            sustained events (|a_h| > 1.2 m/s² for > 0.4 s).  On a drift track most
 *            acceleration is cornering, and cornering acceleration is not along the body axis,
 *            so each sample is weighted by two "was this longitudinal?" gates:
 *              - lateral gate exp(−(v·r/σ)²) on the lateral acceleration implied by the yaw
 *                            rate about gravity-up and the last GPS speed (assumed speed
 *                            without GPS): at 26 m/s a yaw rate of 0.03 rad/s is already
 *                            1 m/s² of lateral acceleration;
 *              - GPS gate    per GPS interval, ρ = |Δv_gps| / |∫a_h dt|: a purely longitudinal
 *                            interval has ρ≈1, a drift transition (yaw rate ≈ 0 but large
 *                            lateral acceleration) has ρ≪1.  The verdict arrives with the next
 *                            fix, so contributions are parked in 0.1 s slices and committed
 *                            once the fix is in (or after 3.5 s without GPS, unweighted).
 *            A drift car can also slide sideways at 40° with zero yaw rate while GPS speed rises
 *            consistently with |∫a| (a straight powerslide between corners); nothing in the raw
 *            signals separates that from straight-line driving except time.  So slices whose
 *            energy lies > `outlierDeg` off the established line go to a CHALLENGER
 *            accumulator; it replaces the line only once it holds ≥ `challengerMinEvidence` of
 *            evidence in one consistent direction (anisotropy ≥ `challengerAnisotropy`).
 *            Transient slides point in varying directions and decay away; a phone rotated about
 *            the vertical (gravity untouched) makes every later event agree with the challenger.
 *            Independently, a GPS sign vote that stops correlating with the line marks it stale.
 *
 *   SIGN     two independent votes, both accumulated as phone-frame vectors so they do not
 *            depend on the axis line being stable:
 *              GPS   V += Δv_gps · ∫a_h dt over the fix interval (latency-shifted)
 *              GYRO  W += r · a_h dt while both |r| and |a_h| are significant (a_y ≈ v·r, so
 *                    Σ r·a_h points LEFT; a negative correlation means forward is flipped)
 *            forward = sign(V·d̂ + W·(u×d̂)) · d̂ with hysteresis.
 *
 *   R        rows = [forward; left = up × forward; up]  (v_vehicle = R · v_phone).
 *
 * All state lives in scalar fields and two preallocated Float64Arrays: the only allocation per
 * push() is the returned sample.
 */
export interface MountOptions {
  /** Body-up filter time constant (slow low-pass of the inertial up), seconds. */
  gravityTau: number;
  /** Low-pass on the specific force before it corrects the inertial up, seconds. */
  forceTau: number;
  /** Inertial-up correction time constant at full trust, seconds. */
  upCorrectionTau: number;
  /** Gyro bias estimator gain, 1/s. */
  upBiasGain: number;
  /** Trust widths: acceleration (m/s²) and |f|−g (m/s²). */
  trustAccel: number;
  trustForce: number;
  /** User acceleration at which the body-up filter runs at half speed (1/(1+(|a|/a0)²)). */
  gravitySlowdownAccel: number;
  /** Fast-vs-slow gravity disagreement that counts as a knock, degrees. */
  gravityJumpDeg: number;
  /** ...held for this long, seconds. */
  gravityJumpHoldS: number;
  /** Low-pass on the acceleration before event detection, seconds. */
  accelTau: number;
  /** Sustained-event threshold, m/s². */
  eventThreshold: number;
  /** Sustained-event minimum duration, seconds. */
  eventMinDuration: number;
  /**
   * Soft gate on the expected lateral acceleration v·r (m/s²) for longitudinal events:
   * weight = exp(−(v·r/lateralGate)²). v = max(last GPS speed, assumedSpeed).
   */
  lateralGate: number;
  assumedSpeed: number;
  /** GPS gate: ρ at which an interval is fully rejected / fully accepted. */
  gpsGateLow: number;
  gpsGateHigh: number;
  /** Seconds after which parked contributions are committed without a GPS verdict. */
  sliceExpiry: number;
  /** Memory of the axis accumulator, seconds of gated event evidence. */
  lineTau: number;
  /** Evidence (gated event seconds) needed before the axis line counts as known. */
  lineMinEvidence: number;
  /** Slices whose energy lies further than this from the line go to the challenger, degrees. */
  outlierDeg: number;
  /** Challenger memory (evidence seconds), evidence and anisotropy needed to replace the line. */
  challengerTau: number;
  challengerMinEvidence: number;
  challengerAnisotropy: number;
  /** Yaw-rate / lateral-accel vote: minimum |yaw rate| (rad/s) and |a_h| (m/s²). */
  yawVoteMinRate: number;
  yawVoteMinAccel: number;
  /** Yaw vote memory (evidence units: rad/s · m/s² · s) and evidence needed for confidence. */
  yawVoteTau: number;
  yawVoteMinEvidence: number;
  /** Assumed GPS latency, seconds (fix time = receive time − latency). */
  gpsLatency: number;
  /** Ignore GPS speed deltas smaller than this, m/s (speed noise). */
  gpsMinDeltaV: number;
  /** GPS vote memory (evidence units: m/s · m/s) and evidence needed for confidence. */
  gpsVoteTau: number;
  gpsVoteMinEvidence: number;
  /** Correlation score at which the forward sign is accepted / flipped. */
  signAcceptScore: number;
  /**
   * Tilt the UP axis so that it is perpendicular to the 3-D acceleration axis (the road
   * surface) instead of exactly anti-parallel to gravity. Corrects the pitch component of a
   * road grade (on a −6 % grade gravity-up is 3.4° off the body's up) at the cost of coupling
   * the up axis to the noisier acceleration estimate; blended in by the line quality.
   */
  gradeCompensation: boolean;
  /** Largest dt accepted between motion samples, seconds (gaps are clamped). */
  maxDt: number;
}

export const DEFAULT_MOUNT_OPTIONS: MountOptions = {
  gravityTau: 2.5,
  forceTau: 0.25,
  upCorrectionTau: 2,
  upBiasGain: 0.05,
  trustAccel: 0.8,
  trustForce: 0.4,
  gravitySlowdownAccel: 3,
  gravityJumpDeg: 12,
  gravityJumpHoldS: 0.3,
  accelTau: 0.1,
  eventThreshold: 1.2,
  eventMinDuration: 0.4,
  lateralGate: 0.7,
  assumedSpeed: 15,
  gpsGateLow: 0.5,
  gpsGateHigh: 0.85,
  sliceExpiry: 3.5,
  lineTau: 8,
  lineMinEvidence: 0.8,
  outlierDeg: 20,
  challengerTau: 3,
  challengerMinEvidence: 1.5,
  challengerAnisotropy: 0.8,
  yawVoteMinRate: 0.1,
  yawVoteMinAccel: 1.0,
  yawVoteTau: 6,
  yawVoteMinEvidence: 1.0,
  gpsLatency: 0.5,
  gpsMinDeltaV: 0.5,
  gpsVoteTau: 12,
  gpsVoteMinEvidence: 3,
  signAcceptScore: 0.5,
  gradeCompensation: true,
  maxDt: 0.1,
};

/** Diagnostic snapshot (allocates; not for the hot path). */
export interface MountDiagnostics {
  /** Estimated up axis (unit, phone frame). */
  up: [number, number, number];
  /** Estimated forward axis (unit, phone frame). */
  forward: [number, number, number];
  /** Up-axis steadiness: EMA of the inertial-up / body-up disagreement, degrees. */
  gravityDeviationDeg: number;
  /** Estimated gyro bias (phone frame, rad/s) and the mean accelerometer trust since reset. */
  gyroBias: [number, number, number];
  meanTrust: number;
  upQuality: number;
  /** Long-term axis line: anisotropy (0..1), evidence seconds, quality. */
  lineAnisotropy: number;
  lineEvidence: number;
  lineQuality: number;
  /** Challenger line evidence seconds. */
  challengerEvidence: number;
  /** Signed sign votes in −1..1 and their evidence. */
  gpsVote: number;
  gpsEvidence: number;
  yawVote: number;
  yawEvidence: number;
  /** Combined sign score (−2..2); forward sign is its sign once |score| ≥ signAcceptScore. */
  signScore: number;
  forwardSign: 1 | -1;
  /** Number of knocks (gravity jumps) detected since reset. */
  knocks: number;
  /** Number of challenger take-overs since reset. */
  innovations: number;
  /** Number of stale-line resets (sign votes uncorrelated with the line) since reset. */
  staleResets: number;
  /** Number of GPS intervals used to verify parked contributions / committed by expiry. */
  gpsVerified: number;
  expired: number;
  /** Time at which forward was last resolved, or NaN. */
  forwardResolvedAt: number;
  forwardResolved: boolean;
  quality: number;
  /** Road-forward tilt against the gravity horizon actually applied, degrees (grade compensation). */
  gradeTiltDeg: number;
}

// Ring of 0.1 s slices. Each slice: [t0, Cx, Cy, Cz, m00, m01, m02, m11, m12, m22, w]
// where C is the running integral of the horizontal acceleration at the slice start and
// m../w the yaw-gated event second moments accumulated inside the slice.
const G_ACC = 9.80665;
const SLICE_DT = 0.1;
const NS = 64; // 6.4 s of history; slices are committed after at most `sliceExpiry` s
const SL = 11;
const EPS = 1e-9;

export class MountCalibrator {
  readonly opts: MountOptions;

  // ---- time
  private started = false;
  private lastT = 0;

  // ---- stage 1: inertial up (unit, phone frame), gyro bias, low-passed specific force
  private gravInit = false;
  private ix = 0;
  private iy = 0;
  private iz = 1;
  private gbx = 0;
  private gby = 0;
  private gbz = 0;
  private flx = 0;
  private fly = 0;
  private flz = -9.81;
  private aosLp = 0; // low-passed |OS user acceleration|
  private trustSum = 0;
  private trustN = 0;
  // ---- stage 2: body up = slow low-pass of the inertial up (unnormalised gs, unit u)
  private gsx = 0;
  private gsy = 0;
  private gsz = 1;
  private ux = 0;
  private uy = 0;
  private uz = 1;
  private bx = 0;
  private by = 0;
  private bz = 1; // grade-compensated up actually used for R (unit)
  private devEma = 0; // rad
  private upAge = 0; // seconds of gravity data since (re)start
  private jumpSince = -1;
  private stationaryUntil = -1;
  private knocks = 0;

  // ---- acceleration (phone frame, low-passed) and yaw rate
  private ahx = 0;
  private ahy = 0;
  private ahz = 0;
  private aUpLp = 0;
  private rLp = 0;
  private inEvent = false;
  private evStart = 0;

  // ---- running integral of the horizontal acceleration + slice ring
  private cx = 0;
  private cy = 0;
  private cz = 0;
  private slices = new Float64Array(NS * SL);
  private sliceHead = -1; // index of the slice being filled
  private sliceCount = 0;
  private sliceStartT = -Infinity;
  private uncommitted = 0; // number of slices (oldest first, ending before sliceHead+1) awaiting commit
  private gpsVerified = 0;
  private expired = 0;

  // ---- axis line accumulators (second moments in the phone frame): line (m) and challenger (q)
  private m00 = 0;
  private m01 = 0;
  private m02 = 0;
  private m11 = 0;
  private m12 = 0;
  private m22 = 0;
  private mE = 0;
  private q00 = 0;
  private q01 = 0;
  private q02 = 0;
  private q11 = 0;
  private q12 = 0;
  private q22 = 0;
  private qE = 0;
  private innovations = 0;
  private staleResets = 0;
  // line direction (unit, in the gravity-horizontal plane, sign kept continuous)
  private dx = 1;
  private dy = 0;
  private dz = 0;
  private lineValid = false;
  private lineAniso = 0;
  // 3-D principal axis (for grade compensation), unit
  private px = 1;
  private py = 0;
  private pz = 0;
  private gradeTilt = 0;

  // ---- sign votes (phone-frame vectors) with evidence
  private wx = 0;
  private wy = 0;
  private wz = 0;
  private wE = 0;
  private vx = 0;
  private vy = 0;
  private vz = 0;
  private vE = 0;
  private signScore = 0;
  private fwdSign: 1 | -1 = 1;

  // ---- GPS bookkeeping
  private gpsSpeed = NaN;
  private gpsSpeedT = -Infinity;
  private gpsAccel = 0; // |Δv/Δt| of the last fix pair (expected longitudinal acceleration)
  private gpsAccelT = -Infinity;
  private hasPrevFix = false;
  private prevFixT = 0;
  private prevFixSpeed = 0;
  private prevCx = 0;
  private prevCy = 0;
  private prevCz = 0;

  // ---- output frame
  private fx = 1;
  private fy = 0;
  private fz = 0;
  private lx = 0;
  private ly = 1;
  private lz = 0;
  private r: [number, number, number, number, number, number, number, number, number] = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  private quality = 0;
  private upQuality = 0;
  private lineQuality = 0;
  private forwardResolved = false;
  private forwardResolvedAt = NaN;
  private calT = 0;

  // scratch (scalars, no allocation)
  private lookX = 0;
  private lookY = 0;
  private lookZ = 0;
  private e1x = 0;
  private e1y = 0;
  private e1z = 0;
  private e2x = 0;
  private e2y = 0;
  private e2z = 0;
  private outX = 0;
  private outY = 0;
  private outZ = 0;
  private outAniso = 0;

  constructor(opts?: Partial<MountOptions>) {
    this.opts = { ...DEFAULT_MOUNT_OPTIONS, ...(opts ?? {}) };
    this.reset();
  }

  /** Snapshot of the current calibration (a fresh object each call). */
  get calibration(): MountCalibration {
    return {
      r: [this.r[0], this.r[1], this.r[2], this.r[3], this.r[4], this.r[5], this.r[6], this.r[7], this.r[8]],
      quality: this.quality,
      forwardResolved: this.forwardResolved,
      t: this.calT,
    };
  }

  /** Diagnostics for tests / the calibration screen (allocates). */
  diagnostics(): MountDiagnostics {
    return {
      up: [this.bx, this.by, this.bz],
      forward: [this.fx, this.fy, this.fz],
      gravityDeviationDeg: (this.devEma * 180) / Math.PI,
      gyroBias: [this.gbx, this.gby, this.gbz],
      meanTrust: this.trustN > 0 ? this.trustSum / this.trustN : 0,
      upQuality: this.upQuality,
      lineAnisotropy: this.lineAniso,
      lineEvidence: this.mE,
      lineQuality: this.lineQuality,
      challengerEvidence: this.qE,
      gpsVote: this.vE > EPS ? clamp((this.vx * this.dx + this.vy * this.dy + this.vz * this.dz) / this.vE, -1, 1) : 0,
      gpsEvidence: this.vE,
      yawVote: this.wE > EPS ? this.yawCorrelation() : 0,
      yawEvidence: this.wE,
      signScore: this.signScore,
      forwardSign: this.fwdSign,
      knocks: this.knocks,
      innovations: this.innovations,
      staleResets: this.staleResets,
      gpsVerified: this.gpsVerified,
      expired: this.expired,
      forwardResolvedAt: this.forwardResolvedAt,
      forwardResolved: this.forwardResolved,
      quality: this.quality,
      gradeTiltDeg: (Math.asin(clamp(this.gradeTilt * this.lineQuality, -1, 1)) * 180) / Math.PI,
    };
  }

  reset(): void {
    this.started = false;
    this.lastT = 0;
    this.gravInit = false;
    this.ix = 0;
    this.iy = 0;
    this.iz = 1;
    this.gbx = this.gby = this.gbz = 0;
    this.flx = 0;
    this.fly = 0;
    this.flz = -9.81;
    this.aosLp = 0;
    this.trustSum = 0;
    this.trustN = 0;
    this.gsx = 0;
    this.gsy = 0;
    this.gsz = 1;
    this.ux = 0;
    this.uy = 0;
    this.uz = 1;
    this.bx = 0;
    this.by = 0;
    this.bz = 1;
    this.devEma = 0;
    this.upAge = 0;
    this.jumpSince = -1;
    this.stationaryUntil = -1;
    this.knocks = 0;
    this.innovations = 0;
    this.staleResets = 0;
    this.gpsVerified = 0;
    this.expired = 0;
    this.ahx = this.ahy = this.ahz = 0;
    this.aUpLp = 0;
    this.rLp = 0;
    this.inEvent = false;
    this.cx = this.cy = this.cz = 0;
    this.sliceHead = -1;
    this.sliceCount = 0;
    this.sliceStartT = -Infinity;
    this.uncommitted = 0;
    this.hasPrevFix = false;
    this.gpsSpeed = NaN;
    this.gpsSpeedT = -Infinity;
    this.gpsAccel = 0;
    this.gpsAccelT = -Infinity;
    this.resetForward();
    this.fx = 1;
    this.fy = 0;
    this.fz = 0;
    this.lx = 0;
    this.ly = 1;
    this.lz = 0;
    this.r[0] = 1; this.r[1] = 0; this.r[2] = 0;
    this.r[3] = 0; this.r[4] = 1; this.r[5] = 0;
    this.r[6] = 0; this.r[7] = 0; this.r[8] = 1;
    this.quality = 0;
    this.upQuality = 0;
    this.lineQuality = 0;
    this.forwardResolved = false;
    this.forwardResolvedAt = NaN;
    this.calT = 0;
  }

  /**
   * The user says the car is standing still with the phone in its final position: the slow
   * gravity filter snaps to the current gravity and runs fast for the next two seconds, so the
   * up axis is exact immediately. If the phone has clearly moved since the last estimate the
   * forward evidence is discarded too (it belongs to the old mount). Forward is NOT assumed
   * from this gesture: cars leave parking spots in reverse as often as forward.
   */
  markStationary(): void {
    this.stationaryUntil = this.lastT + 2;
    if (!this.gravInit) return;
    // parked: the specific force IS gravity — re-seed the inertial up from it
    const fn = Math.sqrt(this.flx * this.flx + this.fly * this.fly + this.flz * this.flz);
    if (fn > 1) {
      this.ix = -this.flx / fn;
      this.iy = -this.fly / fn;
      this.iz = -this.flz / fn;
    }
    const before = this.angleBetween(this.gsx, this.gsy, this.gsz, this.ix, this.iy, this.iz);
    this.gsx = this.ix;
    this.gsy = this.iy;
    this.gsz = this.iz;
    this.updateUpFromSlow();
    this.devEma = 0;
    this.upAge = Math.max(this.upAge, 1.5);
    this.jumpSince = -1;
    if (before > (this.opts.gravityJumpDeg * Math.PI) / 180) {
      this.knocks++;
      this.resetForward();
    }
    this.rebuildFrame();
  }

  pushGps(g: GpsSample): void {
    const o = this.opts;
    const speed = g.speed;
    const t = g.t;
    if (!Number.isFinite(t) || !Number.isFinite(speed) || speed < 0 || this.sliceCount === 0) {
      this.hasPrevFix = false;
      return;
    }
    const tFix = t - o.gpsLatency;
    if (!this.lookupIntegral(tFix)) {
      this.hasPrevFix = false;
      return;
    }
    const cxNow = this.lookX;
    const cyNow = this.lookY;
    const czNow = this.lookZ;
    if (this.hasPrevFix && t > this.prevFixT && t - this.prevFixT < 3.5) {
      const tA = this.prevFixT - o.gpsLatency;
      const dv = speed - this.prevFixSpeed;
      const ix = cxNow - this.prevCx;
      const iy = cyNow - this.prevCy;
      const iz = czNow - this.prevCz;
      const im = Math.sqrt(ix * ix + iy * iy + iz * iz);
      // GPS gate: how much of the integrated horizontal acceleration shows up as a speed change
      let gate = 1;
      if (im > 0.3) {
        const rho = Math.abs(dv) / im;
        gate = clamp((rho - o.gpsGateLow) / (o.gpsGateHigh - o.gpsGateLow), 0, 1);
        // |Δv| cannot exceed ∫|a| dt: ρ well above 1 means the two streams disagree
        if (rho > 1.25) gate *= clamp((1.6 - rho) / 0.35, 0, 1);
      } else if (Math.abs(dv) > 1.5) {
        gate = 0; // the accelerometer saw nothing but GPS says the speed changed: inconsistent
      }
      this.commitSlices(tA, tFix, gate);
      this.gpsVerified++;
      if (Math.abs(dv) >= o.gpsMinDeltaV && im > 0.2 && gate > 0) {
        const ev = Math.abs(dv) * im * gate;
        const decay = Math.exp(-ev / o.gpsVoteTau);
        const k = dv * gate;
        this.vx = this.vx * decay + k * ix;
        this.vy = this.vy * decay + k * iy;
        this.vz = this.vz * decay + k * iz;
        this.vE = this.vE * decay + ev;
      }
      this.solveLine();
      this.updateSign();
      this.rebuildFrame();
    }
    if (this.hasPrevFix && t > this.prevFixT && t - this.prevFixT < 3.5) {
      this.gpsAccel = Math.abs(speed - this.prevFixSpeed) / (t - this.prevFixT);
      this.gpsAccelT = t;
    }
    this.hasPrevFix = true;
    this.gpsSpeed = speed;
    this.gpsSpeedT = t;
    this.prevFixT = t;
    this.prevFixSpeed = speed;
    this.prevCx = cxNow;
    this.prevCy = cyNow;
    this.prevCz = czNow;
  }

  push(m: MotionSample): VehicleMotionSample {
    const o = this.opts;
    const t = Number.isFinite(m.t) ? m.t : this.lastT;
    let dt = 0;
    if (this.started) {
      dt = t - this.lastT;
      if (!(dt > 0)) dt = 0;
      else if (dt > o.maxDt) dt = o.maxDt;
    }
    this.started = true;
    this.lastT = t;

    // ---- sanitised inputs
    const aox = fin(m.accel.x);
    const aoy = fin(m.accel.y);
    const aoz = fin(m.accel.z);
    const wx = fin(m.rotationRate.x);
    const wy = fin(m.rotationRate.y);
    const wz = fin(m.rotationRate.z);
    const gx = fin(m.gravity.x);
    const gy = fin(m.gravity.y);
    const gz = fin(m.gravity.z);
    // specific force (what the accelerometer really measures)
    const fx = gx + aox;
    const fy = gy + aoy;
    const fz = gz + aoz;
    const gMag = Math.sqrt(gx * gx + gy * gy + gz * gz);

    // ---- stage 1: inertial up
    if (gMag > 1 || Math.sqrt(fx * fx + fy * fy + fz * fz) > 1) {
      if (!this.gravInit) {
        this.gravInit = true;
        // seed from the OS gravity (exact while parked, which is how sessions start)
        const sx = gMag > 1 ? gx : fx;
        const sy = gMag > 1 ? gy : fy;
        const sz = gMag > 1 ? gz : fz;
        const n = Math.sqrt(sx * sx + sy * sy + sz * sz);
        this.ix = -sx / n;
        this.iy = -sy / n;
        this.iz = -sz / n;
        this.flx = fx;
        this.fly = fy;
        this.flz = fz;
        this.gsx = this.ix;
        this.gsy = this.iy;
        this.gsz = this.iz;
        this.updateUpFromSlow();
      } else if (dt > 0) {
        // gyro propagation of a fixed inertial vector in the rotating phone frame: u̇ = −ω × u
        const cx = wx - this.gbx;
        const cy = wy - this.gby;
        const cz = wz - this.gbz;
        let ix = this.ix - dt * (cy * this.iz - cz * this.iy);
        let iy = this.iy - dt * (cz * this.ix - cx * this.iz);
        let iz = this.iz - dt * (cx * this.iy - cy * this.ix);
        let n = Math.sqrt(ix * ix + iy * iy + iz * iz);
        if (n > EPS) {
          ix /= n;
          iy /= n;
          iz /= n;
        } else {
          ix = this.ix;
          iy = this.iy;
          iz = this.iz;
        }
        // low-passed specific force and OS acceleration magnitude
        const kf = dt / (o.forceTau + dt);
        this.flx += (fx - this.flx) * kf;
        this.fly += (fy - this.fly) * kf;
        this.flz += (fz - this.flz) * kf;
        const aos = Math.sqrt(aox * aox + aoy * aoy + aoz * aoz);
        this.aosLp += (aos - this.aosLp) * kf;
        const flx = this.flx;
        const fly = this.fly;
        const flz = this.flz;
        const fn = Math.sqrt(flx * flx + fly * fly + flz * flz);
        if (fn > 1) {
          // trust: |f| ≈ g, small OS acceleration, small expected acceleration (GPS), small own acceleration
          const ta = o.trustAccel;
          const dF = (fn - G_ACC) / o.trustForce;
          let trust = Math.exp(-dF * dF);
          const tOs = this.aosLp / ta;
          trust *= Math.exp(-tOs * tOs);
          const v = t - this.gpsSpeedT < 3 ? Math.max(this.gpsSpeed, 3) : o.assumedSpeed;
          const rNow = cx * ix + cy * iy + cz * iz;
          let aExp = v * Math.abs(rNow);
          if (t - this.gpsAccelT < 2.5 && this.gpsAccel > aExp) aExp = this.gpsAccel;
          const tExp = aExp / ta;
          trust *= Math.exp(-tExp * tExp);
          // own separated acceleration; floored so a wrong û can still be pulled back
          const mx = flx + G_ACC * ix;
          const my = fly + G_ACC * iy;
          const mz = flz + G_ACC * iz;
          const tMine = Math.sqrt(mx * mx + my * my + mz * mz) / ta;
          trust *= Math.max(0.1, Math.exp(-tMine * tMine));
          if (t < this.stationaryUntil) trust = 1;
          this.trustSum += trust;
          this.trustN++;
          // correction toward −f̂ and gyro-bias update (Mahony-style, up vector only)
          const ux0 = -flx / fn;
          const uy0 = -fly / fn;
          const uz0 = -flz / fn;
          const k = (trust * dt) / (t < this.stationaryUntil ? 0.3 : o.upCorrectionTau);
          const ex = iy * uz0 - iz * uy0;
          const ey = iz * ux0 - ix * uz0;
          const ez = ix * uy0 - iy * ux0;
          const kb = o.upBiasGain * trust * dt;
          this.gbx = clamp(this.gbx + kb * ex, -0.05, 0.05);
          this.gby = clamp(this.gby + kb * ey, -0.05, 0.05);
          this.gbz = clamp(this.gbz + kb * ez, -0.05, 0.05);
          ix += k * (ux0 - ix);
          iy += k * (uy0 - iy);
          iz += k * (uz0 - iz);
          n = Math.sqrt(ix * ix + iy * iy + iz * iz);
          ix /= n;
          iy /= n;
          iz /= n;
        }
        this.ix = ix;
        this.iy = iy;
        this.iz = iz;

        // ---- stage 2: body up = slow low-pass of the inertial up
        const tau = t < this.stationaryUntil ? 0.3 : o.gravityTau;
        // hard acceleration = body roll/pitch: slow the filter down rather than chase it
        const amx = fx + G_ACC * ix;
        const amy = fy + G_ACC * iy;
        const amz = fz + G_ACC * iz;
        const aw = Math.sqrt(amx * amx + amy * amy + amz * amz) / o.gravitySlowdownAccel;
        const ks = dt / (tau + dt) / (1 + aw * aw);
        this.gsx += (ix - this.gsx) * ks;
        this.gsy += (iy - this.gsy) * ks;
        this.gsz += (iz - this.gsz) * ks;
        this.updateUpFromSlow();
        this.upAge += dt;
        // steadiness + knock detection: inertial vs body up disagreement
        const dev = this.angleBetween(this.gsx, this.gsy, this.gsz, ix, iy, iz);
        this.devEma += (dev - this.devEma) * (dt / (1 + dt));
        if (dev > (o.gravityJumpDeg * Math.PI) / 180) {
          if (this.jumpSince < 0) this.jumpSince = t;
          else if (t - this.jumpSince >= o.gravityJumpHoldS) this.knock(dev);
        } else {
          this.jumpSince = -1;
        }
      }
    }
    const ux = this.ux;
    const uy = this.uy;
    const uz = this.uz;
    // own user acceleration: specific force minus the separated gravity
    const ax = fx + G_ACC * this.ix;
    const ay = fy + G_ACC * this.iy;
    const az = fz + G_ACC * this.iz;

    // ---- yaw rate about the inertial up, horizontal acceleration (low-passed)
    const r = (wx - this.gbx) * this.ix + (wy - this.gby) * this.iy + (wz - this.gbz) * this.iz;
    const aUp = ax * this.ix + ay * this.iy + az * this.iz;
    const hx = ax - aUp * this.ix;
    const hy = ay - aUp * this.iy;
    const hz = az - aUp * this.iz;
    if (dt > 0) {
      const ka = dt / (o.accelTau + dt);
      this.ahx += (hx - this.ahx) * ka;
      this.ahy += (hy - this.ahy) * ka;
      this.ahz += (hz - this.ahz) * ka;
      this.rLp += (r - this.rLp) * ka;
      this.aUpLp += (aUp - this.aUpLp) * ka;
    } else {
      this.ahx = hx;
      this.ahy = hy;
      this.ahz = hz;
      this.rLp = r;
      this.aUpLp = aUp;
    }
    const ahx = this.ahx;
    const ahy = this.ahy;
    const ahz = this.ahz;
    const hMag = Math.sqrt(ahx * ahx + ahy * ahy + ahz * ahz);

    if (dt > 0 && this.gravInit) {
      // running integral of the horizontal acceleration (GPS gate + GPS sign vote)
      this.cx += ahx * dt;
      this.cy += ahy * dt;
      this.cz += ahz * dt;
      if (t >= this.sliceStartT + SLICE_DT) {
        // commit whatever has waited too long for a GPS verdict, then open a new slice
        this.expireSlices(t);
        this.openSlice(t);
      }

      // sustained horizontal acceleration events → parked second moments (yaw-gated)
      if (hMag > o.eventThreshold) {
        if (!this.inEvent) {
          this.inEvent = true;
          this.evStart = t;
        }
        if (t - this.evStart >= o.eventMinDuration) {
          // never looser than the assumed-speed gate: GPS speed lags by up to 1.5 s and a
          // launch from standstill gains 3–4 m/s per second
          const v = t - this.gpsSpeedT < 3 ? Math.max(this.gpsSpeed, o.assumedSpeed) : o.assumedSpeed;
          const rg = (v * this.rLp) / o.lateralGate;
          const yawWeight = Math.exp(-rg * rg);
          if (yawWeight > 1e-3) {
            const w = dt * yawWeight;
            // with grade compensation the (low-passed) 3-D acceleration is accumulated: its
            // principal axis lies in the road plane; otherwise only the horizontal part
            let sx = ahx;
            let sy = ahy;
            let sz = ahz;
            if (o.gradeCompensation) {
              const av = this.aUpLp;
              sx += av * ux;
              sy += av * uy;
              sz += av * uz;
            }
            const b = this.sliceHead * SL;
            const s = this.slices;
            s[b + 4] += w * sx * sx;
            s[b + 5] += w * sx * sy;
            s[b + 6] += w * sx * sz;
            s[b + 7] += w * sy * sy;
            s[b + 8] += w * sy * sz;
            s[b + 9] += w * sz * sz;
            s[b + 10] += w;
          }
        }
      } else {
        this.inEvent = false;
      }

      // yaw-rate / lateral-acceleration consistency vote: a_y ≈ v·r  ⇒  Σ r·a_h ∥ +left
      const rAbs = Math.abs(this.rLp);
      if (rAbs > o.yawVoteMinRate && hMag > o.yawVoteMinAccel) {
        const ev = dt * rAbs * hMag;
        const dw = Math.exp(-ev / o.yawVoteTau);
        const rw = dt * this.rLp;
        this.wx = this.wx * dw + rw * ahx;
        this.wy = this.wy * dw + rw * ahy;
        this.wz = this.wz * dw + rw * ahz;
        this.wE = this.wE * dw + ev;
        this.updateSign();
      }
      this.rebuildFrame(); // up moves every sample; cheap (≈80 flops)
    } else if (this.gravInit) {
      this.rebuildFrame();
    }

    this.calT = t;
    const R = this.r;
    return {
      t,
      ax: R[0] * ax + R[1] * ay + R[2] * az,
      ay: R[3] * ax + R[4] * ay + R[5] * az,
      az: R[6] * ax + R[7] * ay + R[8] * az,
      yawRate: R[6] * wx + R[7] * wy + R[8] * wz,
      rollRate: R[0] * wx + R[1] * wy + R[2] * wz,
      pitchRate: R[3] * wx + R[4] * wy + R[5] * wz,
      calibrationQuality: this.quality,
    };
  }

  // ------------------------------------------------------------------ slices

  private openSlice(t: number): void {
    if (this.uncommitted >= NS - 1) {
      // cannot happen while expiry works (sliceExpiry < NS·SLICE_DT); be safe anyway
      this.commitOne(1);
    }
    this.sliceHead = (this.sliceHead + 1) % NS;
    if (this.sliceCount < NS) this.sliceCount++;
    const b = this.sliceHead * SL;
    const s = this.slices;
    s[b] = t;
    s[b + 1] = this.cx;
    s[b + 2] = this.cy;
    s[b + 3] = this.cz;
    s[b + 4] = s[b + 5] = s[b + 6] = s[b + 7] = s[b + 8] = s[b + 9] = s[b + 10] = 0;
    this.sliceStartT = t;
    this.uncommitted++;
  }

  private oldestUncommitted(): number {
    // slices are committed FIFO; the uncommitted ones are the newest `uncommitted` slices
    return (this.sliceHead - this.uncommitted + 1 + NS) % NS;
  }

  /** Commit the oldest uncommitted slice with the given gate weight (the slice may still be open). */
  private commitOne(gate: number): void {
    const o = this.opts;
    const idx = this.oldestUncommitted();
    const b = idx * SL;
    const s = this.slices;
    const w = s[b + 10] * gate;
    if (w > 0) {
      const a00 = s[b + 4];
      const a01 = s[b + 5];
      const a02 = s[b + 6];
      const a11 = s[b + 7];
      const a12 = s[b + 8];
      const a22 = s[b + 9];
      // route: does this slice's horizontal energy lie along the established line?
      let toLine = true;
      if (this.lineValid && this.mE >= o.lineMinEvidence) {
        const dx = this.dx;
        const dy = this.dy;
        const dz = this.dz;
        const ux = this.ux;
        const uy = this.uy;
        const uz = this.uz;
        const along = a00 * dx * dx + a11 * dy * dy + a22 * dz * dz + 2 * (a01 * dx * dy + a02 * dx * dz + a12 * dy * dz);
        const vert = a00 * ux * ux + a11 * uy * uy + a22 * uz * uz + 2 * (a01 * ux * uy + a02 * ux * uz + a12 * uy * uz);
        const planar = a00 + a11 + a22 - vert;
        const c = Math.cos((o.outlierDeg * Math.PI) / 180);
        toLine = planar <= EPS || along >= c * c * planar;
      }
      if (toLine) {
        const ds = Math.exp(-w / o.lineTau);
        this.m00 = this.m00 * ds + gate * a00;
        this.m01 = this.m01 * ds + gate * a01;
        this.m02 = this.m02 * ds + gate * a02;
        this.m11 = this.m11 * ds + gate * a11;
        this.m12 = this.m12 * ds + gate * a12;
        this.m22 = this.m22 * ds + gate * a22;
        this.mE = this.mE * ds + w;
      } else {
        const df = Math.exp(-w / o.challengerTau);
        this.q00 = this.q00 * df + gate * a00;
        this.q01 = this.q01 * df + gate * a01;
        this.q02 = this.q02 * df + gate * a02;
        this.q11 = this.q11 * df + gate * a11;
        this.q12 = this.q12 * df + gate * a12;
        this.q22 = this.q22 * df + gate * a22;
        this.qE = this.qE * df + w;
      }
    }
    // the open slice is never committed here except in the overflow guard; mark it consumed
    s[b + 4] = s[b + 5] = s[b + 6] = s[b + 7] = s[b + 8] = s[b + 9] = s[b + 10] = 0;
    this.uncommitted--;
  }

  /** Commit closed slices that ended before tB: those starting at/after tA get `gate`, older ones 1. */
  private commitSlices(tA: number, tB: number, gate: number): void {
    const s = this.slices;
    while (this.uncommitted > 1) {
      // keep the open slice (index sliceHead) uncommitted
      const idx = this.oldestUncommitted();
      const centre = s[idx * SL] + SLICE_DT / 2;
      if (centre >= tB) break;
      this.commitOne(centre >= tA ? gate : 1);
    }
  }

  /** Commit closed slices older than `sliceExpiry` without a GPS verdict. */
  private expireSlices(now: number): void {
    const s = this.slices;
    let any = false;
    while (this.uncommitted > 1) {
      const idx = this.oldestUncommitted();
      if (now - s[idx * SL] < this.opts.sliceExpiry) break;
      this.commitOne(1);
      this.expired++;
      any = true;
    }
    if (any) {
      this.solveLine();
      this.updateSign();
    }
  }

  /** Interpolate the running horizontal-acceleration integral at time t from the slice ring. */
  private lookupIntegral(t: number): boolean {
    if (this.sliceCount === 0) return false;
    const s = this.slices;
    // newer bracket starts as "now"
    let newerT = this.lastT;
    let newerX = this.cx;
    let newerY = this.cy;
    let newerZ = this.cz;
    if (t >= newerT) {
      this.lookX = newerX;
      this.lookY = newerY;
      this.lookZ = newerZ;
      return true;
    }
    let idx = this.sliceHead;
    for (let n = 0; n < this.sliceCount; n++) {
      const b = idx * SL;
      const et = s[b];
      if (et <= t) {
        const f = newerT > et ? clamp((t - et) / (newerT - et), 0, 1) : 0;
        this.lookX = s[b + 1] + (newerX - s[b + 1]) * f;
        this.lookY = s[b + 2] + (newerY - s[b + 2]) * f;
        this.lookZ = s[b + 3] + (newerZ - s[b + 3]) * f;
        return true;
      }
      newerT = et;
      newerX = s[b + 1];
      newerY = s[b + 2];
      newerZ = s[b + 3];
      idx = (idx - 1 + NS) % NS;
    }
    // older than the whole ring: accept the oldest entry if it is not absurdly far
    if (t > newerT - 2) {
      this.lookX = newerX;
      this.lookY = newerY;
      this.lookZ = newerZ;
      return true;
    }
    return false;
  }

  // ------------------------------------------------------------------ internals

  private resetForward(): void {
    this.m00 = this.m01 = this.m02 = this.m11 = this.m12 = this.m22 = this.mE = 0;
    this.q00 = this.q01 = this.q02 = this.q11 = this.q12 = this.q22 = this.qE = 0;
    this.lineValid = false;
    this.lineAniso = 0;
    this.gradeTilt = 0;
    this.wx = this.wy = this.wz = this.wE = 0;
    this.vx = this.vy = this.vz = this.vE = 0;
    this.signScore = 0;
    this.fwdSign = 1;
    this.inEvent = false;
    this.hasPrevFix = false;
    // drop parked contributions (they belong to the old orientation), keep the open slice
    while (this.uncommitted > 1) this.commitOne(0);
    if (this.uncommitted === 1) {
      const b = this.sliceHead * SL;
      const s = this.slices;
      s[b + 4] = s[b + 5] = s[b + 6] = s[b + 7] = s[b + 8] = s[b + 9] = s[b + 10] = 0;
    }
    this.forwardResolved = false;
    this.forwardResolvedAt = NaN;
    this.lineQuality = 0;
    this.priorLine();
  }

  /** The phone was knocked: gravity direction jumped. Snap up, discard forward. */
  private knock(dev: number): void {
    this.knocks++;
    this.gsx = this.ix;
    this.gsy = this.iy;
    this.gsz = this.iz;
    this.updateUpFromSlow();
    this.devEma = dev;
    this.upAge = 0;
    this.jumpSince = -1;
    this.resetForward();
  }

  private updateUpFromSlow(): void {
    const n = Math.sqrt(this.gsx * this.gsx + this.gsy * this.gsy + this.gsz * this.gsz);
    if (n > EPS) {
      this.ux = this.gsx / n;
      this.uy = this.gsy / n;
      this.uz = this.gsz / n;
    }
  }

  private angleBetween(ax: number, ay: number, az: number, bx: number, by: number, bz: number): number {
    const na = Math.sqrt(ax * ax + ay * ay + az * az);
    const nb = Math.sqrt(bx * bx + by * by + bz * bz);
    if (na < EPS || nb < EPS) return 0;
    return Math.acos(clamp((ax * bx + ay * by + az * bz) / (na * nb), -1, 1));
  }

  /** No evidence yet: pick a plausible horizontal axis (screen normal, else top of the phone). */
  private priorLine(): void {
    const ux = this.ux;
    const uy = this.uy;
    const uz = this.uz;
    // −z_p (the screen faces the driver on a vent/dash mount) projected to the horizontal
    let px = 0 - -uz * ux;
    let py = 0 - -uz * uy;
    let pz = -1 - -uz * uz;
    let n = Math.sqrt(px * px + py * py + pz * pz);
    if (n < 0.3) {
      // phone lying flat: top of the screen (+y_p) points forward
      px = 0 - uy * ux;
      py = 1 - uy * uy;
      pz = 0 - uy * uz;
      n = Math.sqrt(px * px + py * py + pz * pz);
    }
    if (n < 0.3) {
      px = 1 - ux * ux;
      py = 0 - ux * uy;
      pz = 0 - ux * uz;
      n = Math.sqrt(px * px + py * py + pz * pz);
    }
    if (n < EPS) {
      this.dx = 1;
      this.dy = 0;
      this.dz = 0;
    } else {
      this.dx = px / n;
      this.dy = py / n;
      this.dz = pz / n;
    }
    this.px = this.dx;
    this.py = this.dy;
    this.pz = this.dz;
  }

  private makeBasis(): void {
    const ux = this.ux;
    const uy = this.uy;
    const uz = this.uz;
    // k = the phone axis least aligned with up; e1 = u × k; e2 = u × e1
    const axs = Math.abs(ux);
    const ays = Math.abs(uy);
    const azs = Math.abs(uz);
    let kx = 0;
    let ky = 0;
    let kz = 0;
    if (axs <= ays && axs <= azs) kx = 1;
    else if (ays <= azs) ky = 1;
    else kz = 1;
    let ex = uy * kz - uz * ky;
    let ey = uz * kx - ux * kz;
    let ez = ux * ky - uy * kx;
    const n = Math.sqrt(ex * ex + ey * ey + ez * ez);
    ex /= n;
    ey /= n;
    ez /= n;
    this.e1x = ex;
    this.e1y = ey;
    this.e1z = ez;
    this.e2x = uy * ez - uz * ey;
    this.e2y = uz * ex - ux * ez;
    this.e2z = ux * ey - uy * ex;
  }

  /** Principal in-plane axis of a symmetric 3×3 moment matrix (basis from makeBasis). */
  private planarPrincipal(a00: number, a01: number, a02: number, a11: number, a12: number, a22: number): boolean {
    const e1x = this.e1x;
    const e1y = this.e1y;
    const e1z = this.e1z;
    const e2x = this.e2x;
    const e2y = this.e2y;
    const e2z = this.e2z;
    const m1x = a00 * e1x + a01 * e1y + a02 * e1z;
    const m1y = a01 * e1x + a11 * e1y + a12 * e1z;
    const m1z = a02 * e1x + a12 * e1y + a22 * e1z;
    const m2x = a00 * e2x + a01 * e2y + a02 * e2z;
    const m2y = a01 * e2x + a11 * e2y + a12 * e2z;
    const m2z = a02 * e2x + a12 * e2y + a22 * e2z;
    const p11 = e1x * m1x + e1y * m1y + e1z * m1z;
    const p12 = e1x * m2x + e1y * m2y + e1z * m2z;
    const p22 = e2x * m2x + e2y * m2y + e2z * m2z;
    const tr = p11 + p22;
    if (!(tr > EPS)) return false;
    const half = (p11 - p22) / 2;
    const disc = Math.sqrt(half * half + p12 * p12);
    const l1 = tr / 2 + disc;
    const l2 = tr / 2 - disc;
    this.outAniso = clamp((l1 - l2) / (l1 + l2 + EPS), 0, 1);
    const th = 0.5 * Math.atan2(2 * p12, p11 - p22);
    const c = Math.cos(th);
    const s = Math.sin(th);
    this.outX = c * e1x + s * e2x;
    this.outY = c * e1y + s * e2y;
    this.outZ = c * e1z + s * e2z;
    return true;
  }

  private solveLine(): void {
    const o = this.opts;
    if (this.mE <= EPS) return;
    this.makeBasis();
    // challenger: a consistent body of evidence off the line replaces the line
    if (this.qE >= o.challengerMinEvidence && this.planarPrincipal(this.q00, this.q01, this.q02, this.q11, this.q12, this.q22) && this.outAniso >= o.challengerAnisotropy) {
      this.m00 = this.q00; this.m01 = this.q01; this.m02 = this.q02;
      this.m11 = this.q11; this.m12 = this.q12; this.m22 = this.q22;
      this.mE = this.qE;
      this.q00 = this.q01 = this.q02 = this.q11 = this.q12 = this.q22 = this.qE = 0;
      this.innovations++;
    }
    if (!this.planarPrincipal(this.m00, this.m01, this.m02, this.m11, this.m12, this.m22)) return;
    // keep the line direction continuous
    let nx = this.outX;
    let ny = this.outY;
    let nz = this.outZ;
    if (nx * this.dx + ny * this.dy + nz * this.dz < 0) {
      nx = -nx;
      ny = -ny;
      nz = -nz;
    }
    this.dx = nx;
    this.dy = ny;
    this.dz = nz;
    this.lineAniso = this.outAniso;
    this.lineValid = true;

    if (o.gradeCompensation) {
      // 3-D principal axis by a few power iterations seeded with the previous one
      let px = this.px;
      let py = this.py;
      let pz = this.pz;
      if (px * nx + py * ny + pz * nz < 0.3) {
        px = nx;
        py = ny;
        pz = nz;
      }
      for (let i = 0; i < 3; i++) {
        const tx = this.m00 * px + this.m01 * py + this.m02 * pz;
        const ty = this.m01 * px + this.m11 * py + this.m12 * pz;
        const tz = this.m02 * px + this.m12 * py + this.m22 * pz;
        const n = Math.sqrt(tx * tx + ty * ty + tz * tz);
        if (n < EPS) break;
        px = tx / n;
        py = ty / n;
        pz = tz / n;
      }
      if (px * nx + py * ny + pz * nz < 0) {
        px = -px;
        py = -py;
        pz = -pz;
      }
      this.px = px;
      this.py = py;
      this.pz = pz;
      // tilt of the road-forward axis against the gravity horizon (sin of the angle), capped at ~17°
      this.gradeTilt = clamp(px * this.ux + py * this.uy + pz * this.uz, -0.3, 0.3);
    }
  }

  private yawCorrelation(): number {
    // left axis for the current line direction: l = u × d
    const lx = this.uy * this.dz - this.uz * this.dy;
    const ly = this.uz * this.dx - this.ux * this.dz;
    const lz = this.ux * this.dy - this.uy * this.dx;
    return clamp((this.wx * lx + this.wy * ly + this.wz * lz) / (this.wE + EPS), -1, 1);
  }

  private updateSign(): void {
    const o = this.opts;
    if (!this.lineValid) {
      this.signScore = 0;
      return;
    }
    let score = 0;
    let gpsCorr = 0;
    if (this.vE > EPS) {
      gpsCorr = clamp((this.vx * this.dx + this.vy * this.dy + this.vz * this.dz) / this.vE, -1, 1);
      score += gpsCorr * Math.min(1, this.vE / o.gpsVoteMinEvidence);
    }
    let yawCorr = 0;
    if (this.wE > EPS) {
      yawCorr = this.yawCorrelation();
      score += yawCorr * Math.min(1, this.wE / o.yawVoteMinEvidence);
    }
    // Stale line: the GPS vote has plenty of evidence but is uncorrelated with the line, and the
    // gyro vote does not contradict that. The phone was rotated about the vertical (gravity did
    // not move) and the long-memory line still points along the old mount: adopt the short-memory
    // line if it has anything, otherwise start over.
    if (this.mE >= o.lineMinEvidence && this.vE >= 2 * o.gpsVoteMinEvidence && Math.abs(gpsCorr) < 0.25 && (this.wE < o.yawVoteMinEvidence || Math.abs(yawCorr) < 0.35)) {
      this.staleResets++;
      const adopt = this.qE >= 0.5 * o.lineMinEvidence;
      this.m00 = adopt ? this.q00 : 0; this.m01 = adopt ? this.q01 : 0; this.m02 = adopt ? this.q02 : 0;
      this.m11 = adopt ? this.q11 : 0; this.m12 = adopt ? this.q12 : 0; this.m22 = adopt ? this.q22 : 0;
      this.mE = adopt ? this.qE : 0;
      this.q00 = this.q01 = this.q02 = this.q11 = this.q12 = this.q22 = this.qE = 0;
      if (adopt) {
        this.solveLine();
        this.updateSign();
        return;
      }
      this.lineValid = false;
      this.lineAniso = 0;
      this.signScore = 0;
      return;
    }
    this.signScore = score;
    if (score >= o.signAcceptScore) this.fwdSign = 1;
    else if (score <= -o.signAcceptScore) this.fwdSign = -1;
  }

  /** Recompute up (with grade compensation), forward, left, R and the quality figures. */
  private rebuildFrame(): void {
    const o = this.opts;
    // ---- quality of the up axis: steadiness and age
    const steady = clamp(1 - this.devEma / 0.12, 0, 1); // 0 at ≈7° average disagreement
    const age = clamp(this.upAge / 1.5, 0, 1);
    this.upQuality = this.gravInit ? steady * (0.3 + 0.7 * age) : 0;

    // ---- line quality
    const lineQ = this.lineValid ? this.lineAniso * clamp(this.mE / o.lineMinEvidence, 0, 1) : 0;
    this.lineQuality = lineQ;

    // ---- up axis actually used: gravity-up, optionally tilted so it is ⟂ the road-forward axis
    let ux = this.ux;
    let uy = this.uy;
    let uz = this.uz;
    if (o.gradeCompensation && this.lineValid && lineQ > 0) {
      const k = this.gradeTilt * lineQ;
      const bx = ux - k * this.px;
      const by = uy - k * this.py;
      const bz = uz - k * this.pz;
      const n = Math.sqrt(bx * bx + by * by + bz * bz);
      if (n > EPS) {
        ux = bx / n;
        uy = by / n;
        uz = bz / n;
      }
    }
    this.bx = ux;
    this.by = uy;
    this.bz = uz;

    // ---- forward: signed line direction, re-projected ⟂ the used up axis
    let fx = this.fwdSign * this.dx;
    let fy = this.fwdSign * this.dy;
    let fz = this.fwdSign * this.dz;
    const fu = fx * ux + fy * uy + fz * uz;
    fx -= fu * ux;
    fy -= fu * uy;
    fz -= fu * uz;
    let n = Math.sqrt(fx * fx + fy * fy + fz * fz);
    if (n < 1e-6) {
      // degenerate (line parallel to up): fall back to any horizontal axis
      this.priorLine();
      const du = this.dx * ux + this.dy * uy + this.dz * uz;
      fx = this.dx - du * ux;
      fy = this.dy - du * uy;
      fz = this.dz - du * uz;
      n = Math.sqrt(fx * fx + fy * fy + fz * fz);
      if (n < 1e-6) {
        fx = 1;
        fy = 0;
        fz = 0;
        n = 1;
      }
    }
    fx /= n;
    fy /= n;
    fz /= n;
    // left = up × forward
    const lx = uy * fz - uz * fy;
    const ly = uz * fx - ux * fz;
    const lz = ux * fy - uy * fx;
    this.fx = fx;
    this.fy = fy;
    this.fz = fz;
    this.lx = lx;
    this.ly = ly;
    this.lz = lz;
    const R = this.r;
    R[0] = fx; R[1] = fy; R[2] = fz;
    R[3] = lx; R[4] = ly; R[5] = lz;
    R[6] = ux; R[7] = uy; R[8] = uz;

    // ---- forward resolution and overall quality
    const signQ = clamp(Math.abs(this.signScore), 0, 1);
    const resolved = this.lineValid && lineQ >= 0.5 && Math.abs(this.signScore) >= o.signAcceptScore;
    if (resolved && !this.forwardResolved) this.forwardResolvedAt = this.lastT;
    this.forwardResolved = resolved;
    let q: number;
    if (resolved) {
      q = this.upQuality * (0.4 + 0.6 * Math.min(lineQ, signQ));
    } else {
      q = 0.4 * this.upQuality * (0.5 + 0.5 * lineQ);
      if (q > 0.4) q = 0.4;
    }
    this.quality = Number.isFinite(q) ? clamp(q, 0, 1) : 0;
  }
}

function fin(v: number): number {
  return Number.isFinite(v) ? v : 0;
}
