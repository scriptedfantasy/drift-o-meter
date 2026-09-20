import { G, type GpsSample, type MotionSample, type Vec3, mathToCourseDeg } from '../engine/types';
import { type Mat3, apply, mul, rotX, rotY, rotZ, transpose, fromColumns } from './mat3';
import { Prng } from './prng';

/**
 * Sensor imperfection model: mount orientation + wobble, body roll/pitch, road grade and
 * banking, gyro bias/noise, accelerometer noise + engine/road vibration + bumps, and a
 * GPS receiver with latency, correlated position noise, speed/course noise and dropouts.
 */
export type MountPreset = 'portrait-vent' | 'landscape-dash' | 'flat-console' | 'random';

export interface SensorModelOptions {
  mount: MountPreset;
  seed: number;
  /** Gyro bias magnitude scale (rad/s), default 0.006. */
  gyroBias?: number;
  gpsLatency?: number;
  gpsRateHz?: number;
  vibration?: number; // 0..2 multiplier
  gpsDropouts?: boolean;
}

export interface TrueState {
  t: number;
  x: number;
  y: number;
  heading: number;
  speed: number;
  ax: number;
  ay: number;
  yawRate: number;
  rollRate: number;
  pitchRate: number;
  roll: number;
  pitch: number;
}

/** Phone → vehicle rotation for a preset. Phone axes: x right, y top-of-screen, z out of screen. */
export function mountMatrix(preset: MountPreset, rng: Prng): Mat3 {
  // vehicle: x forward, y left, z up
  let R: Mat3;
  switch (preset) {
    case 'portrait-vent': {
      // upright, screen facing the driver (rearward), tilted back 15°
      // x_p → −y_v, y_p → +z_v, z_p → −x_v
      const base = fromColumns({ x: 0, y: -1, z: 0 }, { x: 0, y: 0, z: 1 }, { x: -1, y: 0, z: 0 });
      R = mul(rotY(-0.26), base); // tilt back about the vehicle's lateral axis
      break;
    }
    case 'landscape-dash': {
      // portrait-vent rotated 90° CCW about the screen normal (home side to the right)
      const base = fromColumns({ x: 0, y: -1, z: 0 }, { x: 0, y: 0, z: 1 }, { x: -1, y: 0, z: 0 });
      R = mul(rotY(-0.2), mul(base, rotZ(Math.PI / 2)));
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

export class SensorModel {
  readonly mount: Mat3; // phone → vehicle
  private readonly phoneFromVehicle: Mat3;
  private rng: Prng;
  private gyroBias: Vec3;
  private vibPhase: number[];
  private vibFreq: number[];
  private vibDir: Vec3[];
  private bumpA = 0;
  private bumpT = -1;
  private lastRoll = 0;
  private lastPitch = 0;
  private gpsPending: Array<{ deliverT: number; sample: GpsSample }> = [];
  private nextGpsT = 0;
  private gpsWalk = { x: 0, y: 0 };
  private gpsDropUntil = -1;
  private mountWobblePhase: number;
  readonly opt: Required<SensorModelOptions>;

  constructor(options: SensorModelOptions) {
    const given = Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined));
    this.opt = {
      gyroBias: 0.006,
      gpsLatency: 0.5,
      gpsRateHz: 1,
      vibration: 1,
      gpsDropouts: false,
      ...(given as SensorModelOptions),
    };
    this.rng = new Prng(this.opt.seed * 13 + 101);
    this.mount = mountMatrix(this.opt.mount, this.rng);
    this.phoneFromVehicle = transpose(this.mount);
    const b = this.opt.gyroBias;
    this.gyroBias = { x: b * this.rng.gauss(), y: b * this.rng.gauss(), z: b * this.rng.gauss() };
    this.vibFreq = [23, 37, 51].map((f) => f * this.rng.range(0.9, 1.1));
    this.vibPhase = [0, 1, 2].map(() => this.rng.range(0, 6.28));
    this.vibDir = [0, 1, 2].map(() => {
      const v = { x: this.rng.gauss(), y: this.rng.gauss(), z: this.rng.gauss() * 2 };
      const n = Math.hypot(v.x, v.y, v.z);
      return { x: v.x / n, y: v.y / n, z: v.z / n };
    });
    this.mountWobblePhase = this.rng.range(0, 6.28);
    this.nextGpsT = this.rng.range(0, 1 / this.opt.gpsRateHz);
  }

  /** Body roll/pitch from lateral/longitudinal accel plus road banking and grade. */
  attitude(state: TrueState, grade: number, banking: number): { roll: number; pitch: number } {
    const roll = 0.0053 * state.ay + banking;
    const pitch = -0.004 * state.ax + Math.atan(grade) * -1; // downhill (grade<0) → nose down → +pitch
    return { roll, pitch };
  }

  motion(state: TrueState, dt: number, grade: number, banking: number): MotionSample {
    const target = this.attitude(state, grade, banking);
    // suspension dynamics: body roll/pitch follow the load with a ~0.15 s lag
    const k = dt > 0 ? Math.min(1, dt / 0.15) : 1;
    const roll = this.lastRoll + (target.roll - this.lastRoll) * k;
    const pitch = this.lastPitch + (target.pitch - this.lastPitch) * k;
    const rollRate = dt > 0 ? (roll - this.lastRoll) / dt : 0;
    const pitchRate = dt > 0 ? (pitch - this.lastPitch) / dt : 0;
    this.lastRoll = roll;
    this.lastPitch = pitch;

    // vehicle-frame quantities
    const gravityVehicle = apply(mul(rotX(-roll), rotY(-pitch)), { x: 0, y: 0, z: -G });
    const accVehicle: Vec3 = { x: state.ax, y: state.ay, z: 0 };
    const rateVehicle: Vec3 = { x: rollRate, y: pitchRate, z: state.yawRate };

    // vibration (scales with speed), bumps, noise
    const t = state.t;
    const vibAmp = 0.35 * this.opt.vibration * Math.min(1, state.speed / 25) + 0.05 * this.opt.vibration;
    let vib: Vec3 = { x: 0, y: 0, z: 0 };
    for (let i = 0; i < 3; i++) {
      const a = vibAmp * Math.sin(2 * Math.PI * this.vibFreq[i] * t + this.vibPhase[i]) / (i + 1);
      vib = { x: vib.x + a * this.vibDir[i].x, y: vib.y + a * this.vibDir[i].y, z: vib.z + a * this.vibDir[i].z };
    }
    if (this.rng.next() < dt * 0.25 * this.opt.vibration && state.speed > 3) {
      this.bumpA = this.rng.range(1.5, 4) * this.opt.vibration;
      this.bumpT = t;
    }
    const bump = this.bumpT >= 0 ? this.bumpA * Math.exp(-(t - this.bumpT) / 0.06) * Math.cos(2 * Math.PI * 12 * (t - this.bumpT)) : 0;
    accVehicle.z += vib.z + bump;
    accVehicle.x += vib.x;
    accVehicle.y += vib.y;

    // mount wobble: slow ±1.5° oscillation of the phone in its cradle, plus vibration-induced jitter
    const wob = 0.026 * Math.sin(2 * Math.PI * 0.2 * t + this.mountWobblePhase) * (0.5 + this.opt.vibration * 0.5);
    const wobble = mul(rotX(wob), rotY(0.5 * wob));
    const P = mul(this.phoneFromVehicle, wobble);

    const noiseA = 0.04;
    const noiseG = 0.003;
    const accel = apply(P, accVehicle);
    const gravity = apply(P, gravityVehicle);
    const rate = apply(P, rateVehicle);
    // gyro bias random walk
    this.gyroBias.x += 0.0002 * this.rng.gauss() * Math.sqrt(dt);
    this.gyroBias.y += 0.0002 * this.rng.gauss() * Math.sqrt(dt);
    this.gyroBias.z += 0.0002 * this.rng.gauss() * Math.sqrt(dt);
    return {
      t,
      accel: { x: accel.x + noiseA * this.rng.gauss(), y: accel.y + noiseA * this.rng.gauss(), z: accel.z + noiseA * this.rng.gauss() },
      gravity: { x: gravity.x + 0.01 * this.rng.gauss(), y: gravity.y + 0.01 * this.rng.gauss(), z: gravity.z + 0.01 * this.rng.gauss() },
      rotationRate: {
        x: rate.x + this.gyroBias.x + noiseG * this.rng.gauss(),
        y: rate.y + this.gyroBias.y + noiseG * this.rng.gauss(),
        z: rate.z + this.gyroBias.z + noiseG * this.rng.gauss(),
      },
    };
  }

  /** Call every motion step; returns GPS fixes that become available at time t (with latency). */
  gps(state: TrueState, course: number, originLat: number, originLon: number): GpsSample[] {
    const out: GpsSample[] = [];
    const t = state.t;
    if (t >= this.nextGpsT) {
      this.nextGpsT += 1 / this.opt.gpsRateHz;
      if (this.opt.gpsDropouts && this.gpsDropUntil < t && this.rng.next() < 0.03) this.gpsDropUntil = t + this.rng.range(2, 5);
      if (t > this.gpsDropUntil) {
        // correlated position error (random walk pulled back to zero) + white noise
        this.gpsWalk.x = this.gpsWalk.x * 0.9 + 0.7 * this.rng.gauss();
        this.gpsWalk.y = this.gpsWalk.y * 0.9 + 0.7 * this.rng.gauss();
        const ex = this.gpsWalk.x + 0.5 * this.rng.gauss();
        const ey = this.gpsWalk.y + 0.5 * this.rng.gauss();
        const speed = Math.max(0, state.speed + 0.25 * this.rng.gauss());
        const courseSigmaDeg = state.speed > 1 ? 1.5 + 6 / state.speed : 30;
        const courseDeg = state.speed > 1 ? mathToCourseDeg(course + (courseSigmaDeg * Math.PI / 180) * this.rng.gauss()) : -1;
        const mPerDegLat = 111132.954;
        const mPerDegLon = 111132.954 * Math.cos((originLat * Math.PI) / 180);
        const sample: GpsSample = {
          t: t + this.opt.gpsLatency + 0.08 * this.rng.gauss(),
          lat: originLat + (state.y + ey) / mPerDegLat,
          lon: originLon + (state.x + ex) / mPerDegLon,
          speed,
          course: courseDeg,
          hAcc: 3 + Math.abs(this.rng.gauss()) * 1.5,
        };
        this.gpsPending.push({ deliverT: sample.t, sample });
      }
    }
    while (this.gpsPending.length && this.gpsPending[0].deliverT <= t) {
      out.push(this.gpsPending.shift()!.sample);
    }
    return out;
  }
}
