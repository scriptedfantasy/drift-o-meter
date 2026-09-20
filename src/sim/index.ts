import { type GpsSample, type MotionSample, type TruthSample, type Vec3, clamp, wrapAngle } from '../engine/types';
import { BetaTracker, type DriverOptions, findCorners, planLap, type LapPlan } from './driver';
import { SensorModel, type MountPreset, type TrueState } from './sensors';
import { buildPath, TRACKS, type Path } from './track';
import type { Mat3 } from './mat3';

export { TRACKS, buildPath, findCorners, SensorModel };
export type { Path, MountPreset, TrueState };

export type TrackId = 'harbor' | 'touge';

export interface SimulateOptions {
  seed?: number;
  laps?: number;
  aggression?: number;
  consistency?: number;
  mount?: MountPreset;
  /** Motion sample rate, Hz. */
  rateHz?: number;
  /** GPS delivery latency, s (default: random per seed in 0.35..0.8). */
  gpsLatency?: number;
  gpsRateHz?: number;
  /** 1 = typical dash mount on a track, 0 = none, 2 = rough. */
  vibration?: number;
  gpsDropouts?: boolean;
  /** 0 = rigid mount (default), 0.25 ≈ rattling cradle, 1 = hand-held phone swaying on all axes. */
  looseness?: number;
  /** Phone position relative to the CG, metres (default 0.9 m ahead, 0.35 m up). */
  leverArm?: Vec3;
  /** 0..1 how far the OS gravity estimate leans into sustained acceleration (default 1). */
  gravityLean?: number;
  /** Timestamp jitter σ in seconds (default 0.002) and whether occasional sample gaps occur (default true). */
  timestampJitter?: number;
  sampleGaps?: boolean;
  /** Seconds of standing still before the run starts (lets calibration settle). */
  idleS?: number;
}

export interface SimulatedRun {
  trackId: TrackId;
  /** Phone-frame samples. `t` carries realistic timestamp jitter; truth[i] is the same instant with the exact time. */
  motion: MotionSample[];
  gps: GpsSample[];
  truth: TruthSample[];
  /** Ground-truth phone → vehicle rotation (nominal mount), for validating mount calibration. */
  mount: Mat3;
  /** Times (s) at which the car crossed the start line (closed tracks): lap k spans lapTimes[k]..lapTimes[k+1]. */
  lapTimes: number[];
  /** Ground-truth corners of the track (arc length along the centre-line, metres). */
  corners: Array<{ startS: number; endS: number; apexS: number; direction: 1 | -1; radius: number; x: number; y: number }>;
  /** Track centre-line in metres (x, y, s). */
  centreLine: Array<{ x: number; y: number; s: number }>;
  /** GPS delivery latency actually used, s. */
  gpsLatency: number;
  originLat: number;
  originLon: number;
  plans: LapPlan[];
  meta: Record<string, string | number | boolean>;
}

export function listTracks(): Array<{ id: TrackId; name: string; tagline: string; lengthM: number; closed: boolean }> {
  return (Object.keys(TRACKS) as TrackId[]).map((id) => {
    const p = buildPath(TRACKS[id]);
    return { id, name: TRACKS[id].name, tagline: TRACKS[id].tagline, lengthM: Math.round(p.length), closed: TRACKS[id].closed };
  });
}

function profileAt(v: Float64Array, fi: number, closed: boolean): number {
  const m = v.length;
  let i0 = Math.floor(fi);
  const f = fi - i0;
  let i1 = i0 + 1;
  if (closed) {
    i0 = ((i0 % m) + m) % m;
    i1 = ((i1 % m) + m) % m;
  } else {
    i0 = Math.min(Math.max(i0, 0), m - 1);
    i1 = Math.min(Math.max(i1, 0), m - 1);
  }
  return v[i0] + (v[i1] - v[i0]) * f;
}

/**
 * Generate a full run: kinematic integration along the track with the scripted drift driver,
 * then the sensor model turns the true state into phone-frame motion samples and GPS fixes.
 * One state object per step feeds BOTH the truth record and the sensors, so they can never
 * disagree; the roll-out after the finish uses the same physics with the drift command at 0.
 */
export function simulateRun(trackId: TrackId, opts: SimulateOptions = {}): SimulatedRun {
  const def = TRACKS[trackId];
  const path = buildPath(def);
  const corners = findCorners(path);
  const driver: DriverOptions = {
    aggression: opts.aggression ?? 0.7,
    consistency: opts.consistency ?? 0.7,
    seed: opts.seed ?? 1,
  };
  const laps = def.closed ? Math.max(1, opts.laps ?? 2) : 1;
  const plans: LapPlan[] = [];
  for (let l = 0; l < laps; l++) plans.push(planLap(path, corners, l, driver, l === 0));
  const sensors = new SensorModel({
    mount: opts.mount ?? 'portrait-vent',
    seed: driver.seed,
    gpsLatency: opts.gpsLatency,
    gpsRateHz: opts.gpsRateHz,
    vibration: opts.vibration,
    gpsDropouts: opts.gpsDropouts,
    looseness: opts.looseness,
    leverArm: opts.leverArm,
    gravityLean: opts.gravityLean,
  });
  const rate = opts.rateHz ?? 100;
  const dt = 1 / rate;
  const idleS = opts.idleS ?? 3;
  const jitter = opts.timestampJitter ?? 0.002;
  const gaps = opts.sampleGaps ?? true;
  const rngT = new (class {
    private s = (driver.seed * 2654435761) >>> 0 || 7;
    next() {
      let t = (this.s += 0x6d2b79f5);
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
    gauss() {
      const u = this.next() || 1e-9;
      const v = this.next() || 1e-9;
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    }
  })();

  const motion: MotionSample[] = [];
  const gps: GpsSample[] = [];
  const truth: TruthSample[] = [];
  const tracker = new BetaTracker(driver);

  let t = 0;
  let s = 0;
  let v = 0;
  let lastYawRate = 0;
  let lastBeta = 0;
  let lastStamp = -1;
  let skip = 0;
  const totalLen = def.closed ? path.length * laps : path.length;
  const lapTimes: number[] = [];
  let nextLapS = path.length;

  const emit = (st: TrueState, cmd: number, sLap: number, grade: number, banking: number) => {
    // timestamp jitter + occasional dropped samples (both streams stay index-aligned)
    if (skip > 0) {
      skip--;
      sensors.gps(st, dt, def.originLat, def.originLon); // the receiver keeps running
      return;
    }
    if (gaps && rngT.next() < dt * 0.02) skip = 3 + Math.floor(rngT.next() * 6);
    let stamp = t + jitter * rngT.gauss();
    if (stamp <= lastStamp + 0.001) stamp = lastStamp + 0.001;
    lastStamp = stamp;
    motion.push(sensors.motion(st, dt, grade, banking, stamp));
    gps.push(...sensors.gps(st, dt, def.originLat, def.originLon));
    truth.push({
      t: st.t,
      x: st.x,
      y: st.y,
      heading: st.heading,
      course: st.course,
      speed: st.speed,
      beta: st.beta,
      yawRate: st.yawRate,
      ay: st.ay,
      ax: st.ax,
      drifting: cmd !== 0 || Math.abs(st.beta) > 0.1,
    });
    void sLap;
  };

  // standing still before the run (real sessions start parked)
  const p0 = path.at(0);
  for (let i = 0; i < idleS * rate; i++) {
    const st: TrueState = { t, x: p0.x, y: p0.y, heading: p0.chi, course: p0.chi, speed: 0, ax: 0, ay: 0, yawRate: 0, yawAccel: 0, beta: 0 };
    emit(st, 0, 0, def.grade?.(0) ?? 0, def.banking?.(0, p0.kappa) ?? 0);
    t += dt;
  }
  lapTimes.push(t);

  /** One physics step at arc length s with the given drift command and speed. */
  const stepState = (cmd: number, vNow: number, vDot: number, sLap: number): TrueState => {
    const ps = path.at(sLap);
    tracker.step(cmd, t, dt);
    const beta = clamp(tracker.beta, -1.3, 1.3);
    const betaDot = (beta - lastBeta) / dt;
    lastBeta = beta;
    const chi = ps.chi;
    const chiDot = ps.kappa * vNow; // consistent with the smoothed curvature
    const heading = wrapAngle(chi - beta);
    const yawRate = chiDot - betaDot;
    const yawAccel = clamp((yawRate - lastYawRate) / dt, -12, 12);
    lastYawRate = yawRate;
    const ax = vDot * Math.cos(beta) - vNow * chiDot * Math.sin(beta);
    const ay = vDot * Math.sin(beta) + vNow * chiDot * Math.cos(beta);
    return { t, x: ps.x, y: ps.y, heading, course: chi, speed: vNow, ax, ay, yawRate, yawAccel, beta };
  };

  const sMax = def.closed ? totalLen : path.length - 0.5;
  while (s < sMax) {
    const sLap = def.closed ? s % path.length : s;
    if (def.closed && s >= nextLapS) {
      lapTimes.push(t);
      nextLapS += path.length;
    }
    const lap = def.closed ? Math.min(Math.floor(s / path.length), laps - 1) : 0;
    const plan = plans[lap];
    // β command from the plan (segments may start before s=0 of the lap or end after it → wrap)
    let cmd = 0;
    for (const seg of plan.segments) {
      let inside = sLap >= seg.startS && sLap <= seg.endS;
      if (!inside && def.closed && seg.startS < 0) inside = sLap >= seg.startS + path.length;
      if (!inside && def.closed && seg.endS > path.length) inside = sLap <= seg.endS - path.length;
      if (inside) {
        cmd = seg.beta;
        break;
      }
    }
    // speed from the profile (interpolated between cells); v̇ = v · dv/ds
    const fi = sLap / path.ds;
    const wrapProfile = def.closed && lap > 0; // lap 0 starts from rest: never wrap back to 0.5 m/s at the line
    const vP = Math.max(0.3, profileAt(plan.vTarget, fi, wrapProfile));
    const vN = Math.max(0.3, profileAt(plan.vTarget, fi + 1, wrapProfile));
    const vDot = clamp(((vN - vP) / path.ds) * vP, -6, 4);
    v = vP;
    const st = stepState(cmd, v, vDot, sLap);
    emit(st, cmd, sLap, def.grade?.(sLap) ?? 0, def.banking?.(sLap, path.at(sLap).kappa) ?? 0);
    s += v * dt;
    t += dt;
  }
  if (def.closed) lapTimes.push(t);

  // roll-out after the finish with the same physics: drift command 0, brake gently to a stop
  let aCmd = 0;
  for (let i = 0; i < 12 * rate && v > 0.3; i++) {
    const sLap = def.closed ? s % path.length : s;
    aCmd += ((-2.5 - aCmd) / 0.4) * dt;
    v = Math.max(0, v + aCmd * dt);
    const st = stepState(0, v, aCmd, sLap);
    emit(st, 0, sLap, def.grade?.(sLap) ?? 0, 0);
    s += v * dt;
    t += dt;
  }
  return {
    trackId,
    motion,
    gps,
    truth,
    mount: sensors.mount,
    lapTimes,
    corners: corners.map((c) => {
      const a = path.at(c.apexS);
      return { ...c, x: a.x, y: a.y };
    }),
    centreLine: path.samples.map((q) => ({ x: q.x, y: q.y, s: q.s })),
    gpsLatency: sensors.gpsLatency,
    originLat: def.originLat,
    originLon: def.originLon,
    plans,
    meta: {
      track: def.name,
      laps,
      seed: driver.seed,
      aggression: driver.aggression,
      consistency: driver.consistency,
      mount: opts.mount ?? 'portrait-vent',
      corners: corners.length,
    },
  };
}
