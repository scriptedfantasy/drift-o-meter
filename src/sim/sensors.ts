import { G, type GpsSample, type MotionSample, type Vec3, mathToCourseDeg, wrapAngle } from '../engine/types';
import { type Mat3, apply, mul, rotX, rotY, rotZ, transpose, fromColumns } from './mat3';
import { Prng } from './prng';

/**
 * Sensor imperfection model: mount orientation, cradle wobble and hand-held sway (with the
 * matching gyro rates), body roll/pitch with suspension lag, road grade and banking,
 * gyro bias/noise, accelerometer bias/noise, broadband road vibration + a speed-swept
 * engine-order tone + bumps (on accel AND rates), the phone's lever arm from the CG,
 * an OS-style gravity estimate that leans into sustained acceleration, and a GPS receiver
 * with per-seed latency, receiver-side course/speed filtering, correlated position error
 * with multipath steps, honest hAcc, monotonic delivery and optional dropouts.
 */
export type MountPreset = 'portrait-vent' | 'landscape-dash' | 'flat-console' | 'random';

export interface SensorModelOptions {
  mount: MountPreset;
  seed: number;
  /** Gyro bias magnitude scale (rad/s), default 0.006. */
  gyroBias?: number;
  /** GPS delivery latency in seconds; default: random per seed in 0.35..0.8. */
  gpsLatency?: number;
  gpsRateHz?: number;
  /** 1 = a typical dash mount on a track (≈0.8 m/s² RMS vertical at speed); 0 = none; 2 = rough. */
  vibration?: number;
  gpsDropouts?: boolean;
  /** 0 = rigid mount, 0.25 ≈ rattling cradle, 1 = hand-held: the phone sways on all axes. */
  looseness?: number;
  /** Phone position relative to the CG in the vehicle frame, metres (x forward, z up). */
  leverArm?: Vec3;
  /** 0..1 how far the OS gravity estimate leans into sustained acceleration (1 = τ 4 s, cap 10°). */
  gravityLean?: number;
}

export interface TrueState {
  t: number;
  x: number;
  y: number;
  heading: number;
  /** Direction of travel of the CG, math radians. */
  course: number;
  speed: number;
  ax: number;
  ay: number;
  yawRate: number;
  /** Yaw acceleration, rad/s². */
  yawAccel: number;
  beta: number;
}

/** Phone → vehicle rotation for a preset. Phone axes: x right, y top-of-screen, z out of screen. */
export function mountMatrix(preset: MountPreset, rng: Prng): Mat3 {
  // vehicle: x forward, y left, z up
  let R: Mat3;
  switch (preset) {
    case 'portrait-vent': {
      // upright, screen facing the driver (rearward), reclined 15° so the screen faces slightly UP
      // x_p → −y_v, y_p → +z_v, z_p → −x_v
      const base = fromColumns({ x: 0, y: -1, z: 0 }, { x: 0, y: 0, z: 1 }, { x: -1, y: 0, z: 0 });
      R = mul(rotY(0.26), base);
      break;
    }
    case 'landscape-dash': {
      // portrait-vent rotated 90° CCW about the screen normal (home side to the right), reclined 12°
      const base = fromColumns({ x: 0, y: -1, z: 0 }, { x: 0, y: 0, z: 1 }, { x: -1, y: 0, z: 0 });
      R = mul(rotY(0.2), mul(base, rotZ(Math.PI / 2)));
      break;
    }
    case 'flat-console': {
      // lying flat, screen up, top of the phone pointing forward: x_p → −y_v, y_p → +x_v, z_p → +z_v
      R = fromColumns({ x: 0, y: -1, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
      R = mul(rotX(0.05), R);
      break;
    }
    default: {
      R = mul(rotZ(rng.range(-Math.PI, Math.PI)), mul(rotY(rng.range(-1.2, 1.2)), rotX(rng.range(-Math.PI, Math.PI))));
    }
  }
  return R;
}

/** Two-pole resonator driven by white noise: shaped broadband vibration around f0. */
class Resonator {
  private y1 = 0;
  private y2 = 0;
  private norm = 1;
  constructor(private f0: number, private q: number, dtNominal = 0.01) {
    // calibrate: unit-variance white noise in → unit RMS out at the nominal rate
    let acc = 0;
    let x = 12345;
    for (let i = 0; i < 4000; i++) {
      x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
      const u = (x / 4294967296) * 2 - 1; // uniform −1..1, variance 1/3
      const y = this.step(u * Math.sqrt(3), dtNominal);
      if (i >= 500) acc += y * y;
    }
    this.norm = 1 / Math.sqrt(acc / 3500);
    this.y1 = 0;
    this.y2 = 0;
  }
  step(input: number, dt: number): number {
    const w = 2 * Math.PI * this.f0;
    const a = w * w * dt * dt;
    const b = (w / this.q) * dt;
    const y = (2 * this.y1 - this.y2 + a * input - b * (this.y1 - this.y2)) / (1 + b + a);
    this.y2 = this.y1;
    this.y1 = y;
    return y * this.norm;
  }
}

export class SensorModel {
  readonly mount: Mat3; // phone → vehicle (nominal)
  private readonly phoneFromVehicle: Mat3;
  private rng: Prng;
  private gyroBias: Vec3;
  private accelBias: Vec3;
  private res: Resonator[];
  private resDir: Vec3[];
  private resGain: number[];
  private enginePhase = 0;
  private bumpA = 0;
  private bumpT = -1;
  private bumpAxis: Vec3 = { x: 0, y: 0, z: 1 };
  private lastRoll = 0;
  private lastPitch = 0;
  private lean: Vec3 = { x: 0, y: 0, z: 0 }; // OS gravity lean offset (unit-vector space), vehicle frame
  private gNoise: Vec3 = { x: 0, y: 0, z: 0 }; // slow wander of the OS gravity estimate (OU process, σ 0.01, τ 0.5 s)
  private gpsPending: Array<{ deliverT: number; sample: GpsSample }> = [];
  private nextGpsT = 0;
  private lastDeliverT = -Infinity;
  private gpsWalk = { x: 0, y: 0 };
  private gpsStep = { x: 0, y: 0 };
  private gpsDropUntil = -1;
  private gpsCourseLp = { c: 0, s: 0, init: false };
  private gpsSpeedLp = 0;
  private mountWobblePhase: number;
  private swayFreq: number[] = [];
  private swayPhase: number[] = [];
  private swayDrift: number[] = [];
  readonly gpsLatency: number;
  readonly opt: Required<SensorModelOptions>;

  constructor(options: SensorModelOptions) {
    const given = Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined));
    this.rng = new Prng((options.seed ?? 1) * 13 + 101);
    this.opt = {
      gyroBias: 0.006,
      gpsLatency: -1,
      gpsRateHz: 1,
      vibration: 1,
      gpsDropouts: false,
      looseness: 0,
      leverArm: { x: 0.9, y: 0, z: 0.35 },
      gravityLean: 1,
      ...(given as SensorModelOptions),
    };
    this.gpsLatency = this.opt.gpsLatency >= 0 ? this.opt.gpsLatency : this.rng.range(0.35, 0.8);
    this.mount = mountMatrix(this.opt.mount, this.rng);
    this.phoneFromVehicle = transpose(this.mount);
    const b = this.opt.gyroBias;
    this.gyroBias = { x: b * this.rng.gauss(), y: b * this.rng.gauss(), z: b * this.rng.gauss() };
    this.accelBias = { x: 0.04 * this.rng.gauss(), y: 0.04 * this.rng.gauss(), z: 0.04 * this.rng.gauss() };
    // road/suspension vibration: wheel hop ~11 Hz, body/engine mount ~19 Hz, structure ~29 Hz (all broadband)
    this.res = [new Resonator(11 * this.rng.range(0.9, 1.1), 2.5), new Resonator(19 * this.rng.range(0.9, 1.1), 3), new Resonator(29 * this.rng.range(0.9, 1.1), 3.5)];
    this.resGain = [1.0, 0.6, 0.35];
    this.resDir = [0, 1, 2].map(() => {
      const v = { x: this.rng.gauss() * 0.5, y: this.rng.gauss() * 0.5, z: 1 + Math.abs(this.rng.gauss()) };
      const n = Math.hypot(v.x, v.y, v.z);
      return { x: v.x / n, y: v.y / n, z: v.z / n };
    });
    this.mountWobblePhase = this.rng.range(0, 6.28);
    for (let i = 0; i < 6; i++) {
      this.swayFreq.push(this.rng.range(0.4, 1.8));
      this.swayPhase.push(this.rng.range(0, 6.28));
      this.swayDrift.push(this.rng.range(-0.3, 0.3));
    }
    this.nextGpsT = this.rng.range(0, 1 / this.opt.gpsRateHz);
  }

  /** Body roll/pitch targets from lateral/longitudinal accel plus road banking and grade. */
  attitude(state: TrueState, grade: number, banking: number): { roll: number; pitch: number } {
    const roll = 0.0053 * state.ay + banking;
    const pitch = -0.004 * state.ax - Math.atan(grade); // downhill (grade<0) → nose down → +pitch
    return { roll, pitch };
  }

  /**
   * One motion sample. `dt` is the true interval since the previous call; `tStamp` is the
   * (possibly jittered) timestamp the OS reports for it.
   */
  motion(state: TrueState, dt: number, grade: number, banking: number, tStamp: number): MotionSample {
    const t = state.t;
    const target = this.attitude(state, grade, banking);
    // suspension: body roll/pitch follow the load with a ~0.15 s lag
    const k = dt > 0 ? Math.min(1, dt / 0.15) : 1;
    const roll = this.lastRoll + (target.roll - this.lastRoll) * k;
    const pitch = this.lastPitch + (target.pitch - this.lastPitch) * k;
    const rollRate = dt > 0 ? (roll - this.lastRoll) / dt : 0;
    const pitchRate = dt > 0 ? (pitch - this.lastPitch) / dt : 0;
    this.lastRoll = roll;
    this.lastPitch = pitch;

    // --- vehicle-frame quantities at the PHONE position (lever arm from the CG) ---
    const d = this.opt.leverArm;
    const r = state.yawRate;
    const accVehicle: Vec3 = {
      x: state.ax - r * r * d.x - state.yawAccel * d.y,
      y: state.ay + state.yawAccel * d.x - r * r * d.y,
      z: 0,
    };
    // attitude R_body←world = rotX(−roll)·rotY(−pitch) (yaw does not affect gravity). The gyro
    // measures the body-frame angular velocity: yaw is about the WORLD vertical, so with a rolled/
    // pitched body it has small x/y components; pitch rate is about the intermediate y axis.
    const Rbw = mul(rotX(-roll), rotY(-pitch));
    const gravityTrue = apply(Rbw, { x: 0, y: 0, z: -G });
    const yawBody = apply(Rbw, { x: 0, y: 0, z: r });
    const pitchBody = apply(rotX(-roll), { x: 0, y: pitchRate, z: 0 });
    const rateVehicle: Vec3 = { x: rollRate + yawBody.x + pitchBody.x, y: yawBody.y + pitchBody.y, z: yawBody.z + pitchBody.z };

    // --- vibration: broadband resonators (speed-scaled), engine-order tone, bumps ---
    const vib = this.opt.vibration;
    const speedScale = Math.min(1, state.speed / 22);
    const amp = vib * (0.08 + 0.55 * speedScale); // → ≈0.8 m/s² RMS vertical at speed for vib=1
    let vx = 0;
    let vy = 0;
    let vz = 0;
    for (let i = 0; i < 3; i++) {
      const e = this.res[i].step(this.rng.gauss(), dt) * this.resGain[i] * amp;
      vx += e * this.resDir[i].x;
      vy += e * this.resDir[i].y;
      vz += e * this.resDir[i].z;
    }
    // engine-order tone sweeping with speed (gear-ish): 18–75 Hz, small
    const fEng = 18 + 57 * (0.15 + 0.85 * ((state.speed / 32) % 1));
    this.enginePhase += 2 * Math.PI * fEng * dt;
    const tone = 0.08 * vib * (0.3 + speedScale) * Math.sin(this.enginePhase);
    vz += tone;
    vy += 0.4 * tone;
    // bumps: short impulses on accel and on roll/pitch rate
    if (this.rng.next() < dt * 0.25 * vib && state.speed > 3) {
      this.bumpA = this.rng.range(1.5, 4) * vib;
      this.bumpT = t;
      const bx = this.rng.gauss() * 0.4;
      const by = this.rng.gauss() * 0.4;
      const n = Math.hypot(bx, by, 1);
      this.bumpAxis = { x: bx / n, y: by / n, z: 1 / n };
    }
    let bump = 0;
    if (this.bumpT >= 0) {
      const age = t - this.bumpT;
      bump = this.bumpA * Math.exp(-age / 0.06) * Math.cos(2 * Math.PI * 12 * age);
    }
    accVehicle.x += vx + bump * this.bumpAxis.x;
    accVehicle.y += vy + bump * this.bumpAxis.y;
    accVehicle.z += vz + bump * this.bumpAxis.z;
    rateVehicle.x += 0.02 * bump * this.bumpAxis.y + 0.004 * vy;
    rateVehicle.y += 0.02 * bump * this.bumpAxis.x + 0.004 * vx;

    // --- OS gravity estimate: follows true attitude immediately (gyro-propagated) but LEANS
    // slowly (τ 4 s, capped at 10°) into sustained specific force, like CoreMotion under a long corner ---
    const total = { x: accVehicle.x + gravityTrue.x, y: accVehicle.y + gravityTrue.y, z: accVehicle.z + gravityTrue.z };
    const tn = Math.hypot(total.x, total.y, total.z) || G;
    const totalHat = { x: total.x / tn, y: total.y / tn, z: total.z / tn };
    const gTrueHat = { x: gravityTrue.x / G, y: gravityTrue.y / G, z: gravityTrue.z / G };
    const dot = Math.max(-1, Math.min(1, totalHat.x * gTrueHat.x + totalHat.y * gTrueHat.y + totalHat.z * gTrueHat.z));
    const full = Math.acos(dot);
    const leanCap = 0.175 * this.opt.gravityLean; // 10°
    const f = full > 1e-6 ? Math.min(full, leanCap) / full : 0;
    const leanTarget = { x: (totalHat.x - gTrueHat.x) * f, y: (totalHat.y - gTrueHat.y) * f, z: (totalHat.z - gTrueHat.z) * f };
    const kg = dt > 0 ? Math.min(1, dt / 4) : 1;
    this.lean.x += (leanTarget.x - this.lean.x) * kg;
    this.lean.y += (leanTarget.y - this.lean.y) * kg;
    this.lean.z += (leanTarget.z - this.lean.z) * kg;
    const gl = { x: gTrueHat.x + this.lean.x, y: gTrueHat.y + this.lean.y, z: gTrueHat.z + this.lean.z };
    const gn = Math.hypot(gl.x, gl.y, gl.z) || 1;
    const gravityRep = { x: (gl.x / gn) * G, y: (gl.y / gn) * G, z: (gl.z / gn) * G };
    // what the OS reports as user acceleration = total specific force − its gravity estimate
    const userRep = { x: total.x - gravityRep.x, y: total.y - gravityRep.y, z: total.z - gravityRep.z };

    // --- phone orientation relative to the nominal mount: cradle wobble + hand-held sway ---
    const wobA = 0.026 * (0.5 + vib * 0.5);
    const wobW = 2 * Math.PI * 0.2;
    const wob = wobA * Math.sin(wobW * t + this.mountWobblePhase);
    const wobRate = wobA * wobW * Math.cos(wobW * t + this.mountWobblePhase);
    const ang3 = [wob, 0.5 * wob, 0];
    const rate3 = [wobRate, 0.5 * wobRate, 0];
    if (this.opt.looseness > 0) {
      const A = 0.26 * this.opt.looseness;
      for (let i = 0; i < 6; i++) {
        this.swayPhase[i] += this.swayDrift[i] * dt; // aperiodic
        const w = 2 * Math.PI * this.swayFreq[i];
        const g = A / (1 + (i % 3));
        ang3[i % 3] += g * Math.sin(w * t + this.swayPhase[i]);
        rate3[i % 3] += g * w * Math.cos(w * t + this.swayPhase[i]);
      }
    }
    // W rotates vehicle vectors; the phone frame is rotated by W^T relative to the nominal mount,
    // so its angular velocity relative to the car is −(dang/dt) (small-angle composition).
    const W = mul(rotX(ang3[0]), mul(rotY(ang3[1]), rotZ(ang3[2])));
    const P = mul(this.phoneFromVehicle, W);
    const relRate: Vec3 = { x: -rate3[0], y: -rate3[1], z: -rate3[2] };
    const rateTotal = { x: rateVehicle.x + relRate.x, y: rateVehicle.y + relRate.y, z: rateVehicle.z + relRate.z };

    const noiseA = 0.04;
    const noiseG = 0.003;
    const accel = apply(P, userRep);
    const gravity = apply(P, gravityRep);
    const rate = apply(P, rateTotal);
    // the OS gravity estimate is a filtered quantity: its error wanders slowly rather than being white
    const kOU = dt / 0.5;
    const sOU = 0.01 * Math.sqrt(2 * kOU);
    this.gNoise.x += -kOU * this.gNoise.x + sOU * this.rng.gauss();
    this.gNoise.y += -kOU * this.gNoise.y + sOU * this.rng.gauss();
    this.gNoise.z += -kOU * this.gNoise.z + sOU * this.rng.gauss();
    // gyro bias random walk
    this.gyroBias.x += 0.0002 * this.rng.gauss() * Math.sqrt(dt);
    this.gyroBias.y += 0.0002 * this.rng.gauss() * Math.sqrt(dt);
    this.gyroBias.z += 0.0002 * this.rng.gauss() * Math.sqrt(dt);
    return {
      t: tStamp,
      accel: {
        x: accel.x + this.accelBias.x + noiseA * this.rng.gauss(),
        y: accel.y + this.accelBias.y + noiseA * this.rng.gauss(),
        z: accel.z + this.accelBias.z + noiseA * this.rng.gauss(),
      },
      gravity: { x: gravity.x + this.gNoise.x, y: gravity.y + this.gNoise.y, z: gravity.z + this.gNoise.z },
      rotationRate: {
        x: rate.x + this.gyroBias.x + noiseG * this.rng.gauss(),
        y: rate.y + this.gyroBias.y + noiseG * this.rng.gauss(),
        z: rate.z + this.gyroBias.z + noiseG * this.rng.gauss(),
      },
    };
  }

  /**
   * Call every motion step; returns GPS fixes that become available at time t (with latency).
   * The receiver measures the PHONE's velocity (CG velocity + yaw × lever arm), filters
   * course and speed with τ≈0.3 s, and reports an hAcc that tracks its actual error.
   */
  gps(state: TrueState, dt: number, originLat: number, originLon: number): GpsSample[] {
    const out: GpsSample[] = [];
    const t = state.t;
    // receiver-side filtered velocity at the phone position
    const d = this.opt.leverArm;
    const vBodyX = state.speed * Math.cos(state.beta) - state.yawRate * d.y;
    const vBodyY = state.speed * Math.sin(state.beta) + state.yawRate * d.x;
    const vMag = Math.hypot(vBodyX, vBodyY);
    const coursePhone = state.speed > 0.3 ? state.heading + Math.atan2(vBodyY, vBodyX) : state.course;
    const kf = dt > 0 ? Math.min(1, dt / 0.3) : 1;
    if (!this.gpsCourseLp.init) {
      this.gpsCourseLp = { c: Math.cos(coursePhone), s: Math.sin(coursePhone), init: true };
      this.gpsSpeedLp = vMag;
    } else {
      this.gpsCourseLp.c += (Math.cos(coursePhone) - this.gpsCourseLp.c) * kf;
      this.gpsCourseLp.s += (Math.sin(coursePhone) - this.gpsCourseLp.s) * kf;
      this.gpsSpeedLp += (vMag - this.gpsSpeedLp) * kf;
    }
    if (t >= this.nextGpsT) {
      this.nextGpsT += 1 / this.opt.gpsRateHz;
      if (this.opt.gpsDropouts && this.gpsDropUntil < t && this.rng.next() < 0.03) this.gpsDropUntil = t + this.rng.range(2, 5);
      if (t > this.gpsDropUntil) {
        // slowly varying error (τ ≈ 25 s) + occasional multipath steps + white noise
        const kw = Math.exp(-1 / (this.opt.gpsRateHz * 25));
        this.gpsWalk.x = this.gpsWalk.x * kw + 1.2 * Math.sqrt(1 - kw * kw) * this.rng.gauss();
        this.gpsWalk.y = this.gpsWalk.y * kw + 1.2 * Math.sqrt(1 - kw * kw) * this.rng.gauss();
        if (this.rng.next() < 0.02) this.gpsStep = { x: 3 * this.rng.gauss(), y: 3 * this.rng.gauss() };
        this.gpsStep.x *= 0.85;
        this.gpsStep.y *= 0.85;
        const ex = this.gpsWalk.x + this.gpsStep.x + 0.5 * this.rng.gauss();
        const ey = this.gpsWalk.y + this.gpsStep.y + 0.5 * this.rng.gauss();
        const recentDrop = t - this.gpsDropUntil < 3;
        const errMag = Math.hypot(ex, ey);
        const hAcc = Math.max(2.5, 1.1 * errMag + 1.5 + (recentDrop ? 8 : 0) + Math.abs(this.rng.gauss()));
        const speed = Math.max(0, this.gpsSpeedLp + 0.25 * this.rng.gauss());
        const course = Math.atan2(this.gpsCourseLp.s, this.gpsCourseLp.c);
        const courseSigmaDeg = this.gpsSpeedLp > 1 ? 1.5 + 6 / this.gpsSpeedLp : 30;
        const courseDeg = this.gpsSpeedLp > 1 ? mathToCourseDeg(wrapAngle(course + (courseSigmaDeg * Math.PI / 180) * this.rng.gauss())) : -1;
        const mPerDegLat = 111132.954;
        const mPerDegLon = 111132.954 * Math.cos((originLat * Math.PI) / 180);
        // the antenna is at the phone: offset the position by the lever arm
        const px = state.x + Math.cos(state.heading) * d.x - Math.sin(state.heading) * d.y;
        const py = state.y + Math.sin(state.heading) * d.x + Math.cos(state.heading) * d.y;
        let deliverT = t + this.gpsLatency + 0.05 * this.rng.gauss();
        if (deliverT < this.lastDeliverT + 0.05) deliverT = this.lastDeliverT + 0.05;
        this.lastDeliverT = deliverT;
        const sample: GpsSample = {
          t: deliverT,
          lat: originLat + (py + ey) / mPerDegLat,
          lon: originLon + (px + ex) / mPerDegLon,
          speed,
          course: courseDeg,
          hAcc,
        };
        this.gpsPending.push({ deliverT, sample });
      }
    }
    while (this.gpsPending.length && this.gpsPending[0].deliverT <= t) {
      out.push(this.gpsPending.shift()!.sample);
    }
    return out;
  }
}
