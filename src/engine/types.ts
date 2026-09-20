/**
 * Drift-O-Meter engine — shared types.
 *
 * CONVENTIONS (every engine module must follow these):
 *  - SI units everywhere: seconds, metres, m/s, m/s², radians, rad/s.
 *    Degrees appear only in fields explicitly suffixed `Deg`, and in raw GPS
 *    `course` / `lat` / `lon` which mirror the platform API.
 *  - Time `t` is a monotonic clock in seconds shared by every stream in a run.
 *  - PHONE frame: the platform's device axes (x right, y up/top of screen, z out of the screen).
 *  - VEHICLE frame (ISO 8855): x forward, y left, z up. Yaw rate is positive
 *    counter-clockwise seen from above (a LEFT turn has positive yaw rate).
 *  - Headings / courses inside the engine use the MATH convention: radians,
 *    counter-clockwise positive, 0 = +x (east) of the local ENU frame.
 *    `wrapAngle` keeps them in (-π, π].
 *  - Slip angle β = course − heading, i.e. the angle from the car's nose to the
 *    direction it is actually travelling. β > 0: velocity points LEFT of the
 *    nose (a right-hand drift, nose pointed right/inside of a right corner).
 *    β < 0: left-hand drift. Display code shows |β| plus an L/R indicator.
 *  - The engine is pure TypeScript: no React, no React Native, no Expo imports.
 *    It runs identically in the app, in vitest on Linux, and in the harness.
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Quaternion {
  w: number;
  x: number;
  y: number;
  z: number;
}

/** One device-motion sample in the PHONE frame, as produced by a sensor adapter. */
export interface MotionSample {
  /** Monotonic seconds. */
  t: number;
  /** User acceleration (gravity removed), m/s², phone frame. */
  accel: Vec3;
  /** Gravity vector as sensed in the phone frame, m/s² (|gravity| ≈ 9.81, points DOWN). */
  gravity: Vec3;
  /** Angular velocity, rad/s, phone frame, right-hand rule about each axis. */
  rotationRate: Vec3;
  /** Optional device attitude (phone → reference frame). */
  attitude?: Quaternion;
}

/** One GPS fix. On iPhone these arrive at ~1 Hz with ~0.3–1 s latency. */
export interface GpsSample {
  /** Monotonic seconds at which the fix was RECEIVED (same clock as MotionSample.t). */
  t: number;
  /** Degrees. */
  lat: number;
  /** Degrees. */
  lon: number;
  /** Ground speed in m/s. NaN or negative when unavailable. */
  speed: number;
  /** Course over ground, degrees clockwise from true north. NaN or negative when unavailable. */
  course: number;
  /** Horizontal accuracy radius in metres (68 %). */
  hAcc: number;
  /** Optional altitude in metres. */
  alt?: number;
}

/**
 * Motion resolved into the VEHICLE frame by the mount calibrator.
 *
 * LEVER ARM — read before changing anything here. The phone sits at a point d ahead of
 * (and above) the centre of gravity, so it genuinely measures a_y(CG) + ṙ·d_x, and the GPS
 * antenna inside it reports the PHONE's course, not the car's. Exactly one module may
 * remove that, or it gets removed twice and the estimate is worse than doing nothing.
 *
 * The owner is the slip estimator, for two reasons: its propagation is exact when run at
 * the phone, so no lever term appears in it at all; and it is the only module that also
 * sees the GPS course offset and the zero-slip prior, which need d_x too and which the
 * calibrator cannot reach.
 *
 * Therefore ax/ay/az here are AT THE PHONE, as measured. The calibrator estimates its own
 * d̂_x to keep the lever arm from rotating its axis estimate, and exposes it as a
 * diagnostic, but must not subtract it from this output.
 */
export interface VehicleMotionSample {
  t: number;
  /** Longitudinal acceleration AT THE PHONE, m/s² (+ = accelerating forward). */
  ax: number;
  /** Lateral acceleration AT THE PHONE, m/s² (+ = to the LEFT, i.e. a left turn pushes + ). */
  ay: number;
  /** Vertical acceleration (gravity removed), m/s². */
  az: number;
  /** Yaw rate, rad/s, + = counter-clockwise from above (left turn). */
  yawRate: number;
  /** Roll rate about the forward axis, rad/s. */
  rollRate: number;
  /** Pitch rate about the lateral axis, rad/s. */
  pitchRate: number;
  /** 0..1 quality estimate of the calibration in effect for this sample. */
  calibrationQuality: number;
}

/** The estimator's belief at one instant. Produced at motion rate (~100 Hz). */
export interface SlipState {
  t: number;
  /** Slip angle β in radians (course − heading). */
  beta: number;
  /** 1σ uncertainty on β in radians. */
  betaSigma: number;
  /** Vehicle heading, math convention radians. */
  heading: number;
  /** Direction of travel (course), math convention radians. */
  course: number;
  /** Ground speed m/s (fused from GPS + longitudinal accel). */
  speed: number;
  /** Bias-corrected yaw rate, rad/s. */
  yawRate: number;
  /** Lateral acceleration, m/s² (vehicle frame, +left). */
  ay: number;
  /** Longitudinal acceleration, m/s². */
  ax: number;
  /** Position in the local ENU frame, metres (east, north). */
  x: number;
  y: number;
  /** True while the filter has a usable GPS course lock and speed above the floor. */
  valid: boolean;
}

export type DriftPhase = 'idle' | 'entry' | 'drifting' | 'transition' | 'exit';

/** A single sustained drift, possibly containing linked transitions (direction changes). */
export interface DriftEvent {
  id: number;
  /** Seconds. */
  startT: number;
  endT: number;
  durationS: number;
  /** Peak |β| in radians and when it happened. */
  peakAngle: number;
  peakAngleT: number;
  /** Mean |β| over the drift, radians. */
  meanAngle: number;
  /** Standard deviation of |β| over the sustained portion, radians (lower = steadier). */
  angleStdDev: number;
  /** Number of direction changes (left↔right) inside this one linked drift. */
  transitions: number;
  /** Speeds in m/s. */
  entrySpeed: number;
  meanSpeed: number;
  minSpeed: number;
  /** Ground distance covered while drifting, metres. */
  distanceM: number;
  /** Peak |yawRate|, rad/s. */
  peakYawRate: number;
  /** Peak |ay| in m/s², NOT in g. Divide by G to display a g-force. */
  peakLateralAccel: number;
  /** +1 when the drift starts as a right-hand drift (β>0), −1 for left. */
  initialDirection: 1 | -1;
  /**
   * Seconds of this drift the integrity monitor refused to believe, which therefore earned
   * nothing. 0 on a clean run.
   *
   * REQUIRED, for the same reason as `spin`. A stored session re-scored later cannot see the
   * live per-sample verdict — the mask that carries it is meaningful only against `states` at
   * exactly the rate they were recorded, and `motion` is already decimated for storage, so the
   * day anyone decimates `states` a mask would silently suppress the WRONG samples while still
   * looking plausible. A duration cannot misalign. Measured over 194 drifts spanning every
   * looseness, suppression is all-or-nothing on 89.7 % of them, so scaling by the believed
   * fraction reproduces the live points exactly there and errs by a few percent on the rest —
   * all of which are already refusing to publish a score.
   *
   * It is also the only form a driver can be shown: "6.1 s of this slide did not count,
   * because the phone was moving in its mount."
   */
  suppressedS: number;
  /**
   * True when the drift ended in a spin rather than a controlled exit. REQUIRED, and
   * required for a reason: a spin must reach the scorer and the results screen, or the
   * HUD says "CHAIN LOST" while the results screen congratulates the driver on a clean
   * exit. Every producer of a DriftEvent must set it explicitly.
   */
  spin: boolean;
  /** Index range into the run's SlipState array for replay/scrubbing. */
  sampleStart: number;
  sampleEnd: number;
}

/** Style callouts the scorer fires, NFS-style, so the HUD can flash them. */
export type StyleCalloutKind =
  | 'initiation'
  | 'transition'
  | 'extreme-angle'
  | 'long-drift'
  | 'smooth'
  | 'high-speed'
  | 'manji'
  | 'link'
  | 'perfect-exit'
  | 'clean-lap';

export interface StyleCallout {
  t: number;
  kind: StyleCalloutKind;
  /** Short uppercase label for the HUD, e.g. "TRANSITION x3". */
  label: string;
  /** Points awarded by this callout (already included in the running score). */
  points: number;
}

export interface DriftScore {
  /** Base points from angle × duration × speed. */
  base: number;
  /** Multiplier applied (1.0 .. 5.0). */
  multiplier: number;
  /** Bonus points from callouts. */
  bonus: number;
  /** base × multiplier + bonus. */
  total: number;
  /** 0..100 component scores used for the results breakdown. */
  angle: number;
  consistency: number;
  speed: number;
  style: number;
  callouts: StyleCallout[];
}

export type Grade = 'S' | 'A' | 'B' | 'C' | 'D';

/**
 * How much of a run the integrity monitor was willing to believe.
 *
 * This exists because a run can be perfectly well FORMED and still be meaningless: a phone
 * waved in a parked car produces large angles, high yaw rates and a rising score. The monitor
 * knows; before this block existed it had no way to say so, and a hand-held run published a
 * grade like any other.
 */
export interface SessionIntegrity {
  mount: 'rigid' | 'suspect' | 'loose';
  physics: 'ok' | 'implausible';
  gps: 'good' | 'poor' | 'none';
  /** Fraction (0..1) of drifting time the monitor refused to believe. */
  implausibleDriftFraction: number;
  /** Drifting seconds that earned nothing because they were not believed. */
  suppressedS: number;
  /**
   * False when too much of the run was not believed for its total and grade to mean anything.
   *
   * A consumer MUST NOT present the total or the grade as an achievement when this is false:
   * no grade letter, no leaderboard entry, no share card. Show `message` instead and offer the
   * run as a recording. `SessionScore.trusted` carries the same flag so a scored object is
   * never separated from the verdict on whether it may be shown.
   */
  scoreTrusted: boolean;
  /** Driver-facing reason, in plain words. Empty when trusted. */
  message: string;
}

export interface SessionScore {
  total: number;
  grade: Grade;
  /** 0..100 aggregate components. */
  angle: number;
  consistency: number;
  quality: number;
  speed: number;
  style: number;
  bestDriftId: number | null;
  longestChainPoints: number;
  perDrift: Record<number, DriftScore>;
  /**
   * Mirrors `SessionIntegrity.scoreTrusted`. Required, not optional: every producer of a score
   * has to answer whether it may be shown, and every consumer has to look. See the doc on
   * `SessionIntegrity.scoreTrusted` for what false obliges.
   */
  trusted: boolean;
}

/** A corner found on the track, in local ENU metres. */
export interface TrackCorner {
  id: number;
  /** Arc-length position of the apex along the reference lap, metres. */
  apexS: number;
  /** Arc-length span, metres. */
  startS: number;
  endS: number;
  /** Apex position. */
  x: number;
  y: number;
  /** +1 = left-hander (CCW), −1 = right-hander. */
  direction: 1 | -1;
  /** Mean radius of curvature, metres. */
  radiusM: number;
}

export interface Lap {
  index: number;
  startT: number;
  endT: number;
  durationS: number;
  /** Index range into the SlipState array. */
  sampleStart: number;
  sampleEnd: number;
}

export interface TrackModel {
  /** Local ENU origin. */
  originLat: number;
  originLon: number;
  /** Reference lap centre-line, resampled at ~1 m, closed if `closed`. */
  refPath: Array<{ x: number; y: number; s: number }>;
  closed: boolean;
  lengthM: number;
  corners: TrackCorner[];
  laps: Lap[];
  /** Start/finish gate (two points in metres), if the track is a closed circuit. */
  gate?: { ax: number; ay: number; bx: number; by: number };
}

/** Everything a run produces. Serialisable as JSON; this is the on-disk session format. */
export interface Session {
  version: 1;
  id: string;
  name: string;
  /** Wall-clock start, ms since epoch. */
  startedAt: number;
  /** Seconds. */
  durationS: number;
  /** Raw inputs kept for re-analysis (motion may be decimated to 50 Hz for storage). */
  motion: MotionSample[];
  gps: GpsSample[];
  /** Estimator output at motion rate. */
  states: SlipState[];
  drifts: DriftEvent[];
  score: SessionScore;
  track: TrackModel | null;
  calibration: MountCalibration;
  /** What the integrity monitor made of the run, and whether its score may be published. */
  integrity: SessionIntegrity;
  /** Optional simulator ground truth, present only for simulated runs. */
  truth?: TruthSample[];
  /** Free-form: sim track id, phone model, app version… */
  meta: Record<string, string | number | boolean>;
}

/** Rotation that maps PHONE-frame vectors into the VEHICLE frame, plus provenance. */
export interface MountCalibration {
  /** Row-major 3×3 rotation matrix R such that v_vehicle = R · v_phone. */
  r: [number, number, number, number, number, number, number, number, number];
  /** 0..1: 0 = identity / uncalibrated, 1 = both axes confidently resolved. */
  quality: number;
  /** Whether the forward axis has been resolved (gravity alone only fixes 'up'). */
  forwardResolved: boolean;
  /** When the calibration was last updated, seconds. */
  t: number;
}

/** Simulator ground truth, aligned to motion samples by `t`. */
export interface TruthSample {
  t: number;
  x: number;
  y: number;
  heading: number;
  course: number;
  speed: number;
  beta: number;
  yawRate: number;
  ay: number;
  ax: number;
  /** True while the scripted driver intends to be drifting. */
  drifting: boolean;
}

export const G = 9.80665;

export const TAU = Math.PI * 2;

/** Wrap an angle to (-π, π]. */
export function wrapAngle(a: number): number {
  let r = a % TAU;
  if (r > Math.PI) r -= TAU;
  else if (r <= -Math.PI) r += TAU;
  return r;
}

export function degToRad(d: number): number {
  return (d * Math.PI) / 180;
}

export function radToDeg(r: number): number {
  return (r * 180) / Math.PI;
}

/** GPS course (deg clockwise from north) → math heading (rad CCW from east). */
export function courseDegToMath(courseDeg: number): number {
  return wrapAngle(Math.PI / 2 - degToRad(courseDeg));
}

/** Math heading (rad CCW from east) → GPS course (deg clockwise from north, 0..360). */
export function mathToCourseDeg(rad: number): number {
  let d = 90 - radToDeg(rad);
  d %= 360;
  if (d < 0) d += 360;
  return d;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
