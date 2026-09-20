import { type GpsSample, type MotionSample, type TruthSample, clamp, wrapAngle } from '../engine/types';
import { BetaTracker, type DriverOptions, findCorners, planLap, type LapPlan } from './driver';
import { SensorModel, type MountPreset } from './sensors';
import { buildPath, TRACKS, type Path } from './track';
import type { Mat3 } from './mat3';

export { TRACKS, buildPath, findCorners };
export type { Path, MountPreset };

export type TrackId = 'harbor' | 'touge';

export interface SimulateOptions {
  seed?: number;
  laps?: number;
  aggression?: number;
  consistency?: number;
  mount?: MountPreset;
  /** Motion sample rate, Hz. */
  rateHz?: number;
  gpsLatency?: number;
  gpsRateHz?: number;
  vibration?: number;
  gpsDropouts?: boolean;
  /** Seconds of standing still before the run starts (lets calibration settle). */
  idleS?: number;
}

export interface SimulatedRun {
  trackId: TrackId;
  motion: MotionSample[];
  gps: GpsSample[];
  truth: TruthSample[];
  /** Ground-truth phone → vehicle rotation, for validating mount calibration. */
  mount: Mat3;
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

/**
 * Generate a full run: kinematic integration along the track with the scripted drift driver,
 * then the sensor model turns the true state into phone-frame motion samples and GPS fixes.
 */
function smoothProfile(v: Float64Array, i: number, closed: boolean): number {
  const m = v.length;
  const half = 4; // ±2 m at 0.5 m spacing
  let acc = 0;
  let n = 0;
  for (let k = -half; k <= half; k++) {
    let ii = i + k;
    if (closed) ii = ((ii % m) + m) % m;
    else if (ii < 0 || ii >= m) continue;
    acc += v[ii];
    n++;
  }
  return acc / n;
}

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
  for (let l = 0; l < laps; l++) plans.push(planLap(path, corners, l, driver));
  const sensors = new SensorModel({
    mount: opts.mount ?? 'portrait-vent',
    seed: driver.seed,
    gpsLatency: opts.gpsLatency,
    gpsRateHz: opts.gpsRateHz,
    vibration: opts.vibration,
    gpsDropouts: opts.gpsDropouts,
  });
  const rate = opts.rateHz ?? 100;
  const dt = 1 / rate;
  const idleS = opts.idleS ?? 3;

  const motion: MotionSample[] = [];
  const gps: GpsSample[] = [];
  const truth: TruthSample[] = [];
  const tracker = new BetaTracker(driver);

  let t = 0;
  let s = 0;
  let v = 0.5;
  let aCmd = 0;
  let lap = 0;
  let prevV = v;
  let prevBeta = 0;
  const totalLen = def.closed ? path.length * laps : path.length;
  let lastChi = path.at(0).chi;

  // standing still before the run (real sessions start parked)
  const p0 = path.at(0);
  for (let i = 0; i < idleS * rate; i++) {
    const st = { t, x: p0.x, y: p0.y, heading: p0.chi, speed: 0, ax: 0, ay: 0, yawRate: 0, rollRate: 0, pitchRate: 0, roll: 0, pitch: 0 };
    motion.push(sensors.motion(st, dt, def.grade?.(0) ?? 0, 0));
    gps.push(...sensors.gps(st, p0.chi, def.originLat, def.originLon));
    truth.push({ t, x: p0.x, y: p0.y, heading: p0.chi, course: p0.chi, speed: 0, beta: 0, yawRate: 0, ay: 0, ax: 0, drifting: false });
    t += dt;
  }

  const sMax = def.closed ? totalLen : path.length - 0.5;
  while (s < sMax) {
    const sLap = def.closed ? s % path.length : s;
    lap = def.closed ? Math.min(Math.floor(s / path.length), laps - 1) : 0;
    const plan = plans[lap];
    const ps = path.at(sLap);
    // β command from the plan (segments may start before s=0 of the lap → wrap)
    let cmd = 0;
    for (const seg of plan.segments) {
      let a = seg.startS;
      let b = seg.endS;
      let inside = sLap >= a && sLap <= b;
      if (!inside && def.closed && a < 0) inside = sLap >= a + path.length; // segment starting before the line
      if (!inside && def.closed && b > path.length) inside = sLap <= b - path.length;
      if (inside) {
        cmd = seg.beta;
        break;
      }
    }
    tracker.step(cmd, t, dt);
    const beta = clamp(tracker.beta, -1.3, 1.3);
    const betaDot = (beta - prevBeta) / dt;
    prevBeta = beta;

    // speed follows the pre-computed profile (which already respects accel/brake limits),
    // lightly smoothed over ~4 m so v̇ is continuous; v̇ = v · dv/ds
    const idx = Math.min(plan.vTarget.length - 1, Math.floor(sLap / path.ds));
    const vProfile = smoothProfile(plan.vTarget, idx, def.closed);
    const vNext = smoothProfile(plan.vTarget, idx + 1, def.closed);
    const dvds = (vNext - vProfile) / path.ds;
    v = Math.max(0.5, vProfile);
    const vDot = clamp(dvds * v, -7, 4);
    prevV = v;

    // kinematics: the CG follows the path; velocity direction = tangent
    const chi = ps.chi;
    const chiDot = ps.kappa * v; // consistent with the smoothed curvature
    lastChi = chi;
    const heading = wrapAngle(chi - beta);
    const yawRate = chiDot - betaDot;
    const ax = vDot * Math.cos(beta) - v * chiDot * Math.sin(beta);
    const ay = vDot * Math.sin(beta) + v * chiDot * Math.cos(beta);

    const st = { t, x: ps.x, y: ps.y, heading, speed: v, ax, ay, yawRate, rollRate: 0, pitchRate: 0, roll: 0, pitch: 0 };
    motion.push(sensors.motion(st, dt, def.grade?.(sLap) ?? 0, def.banking?.(sLap, ps.kappa) ?? 0));
    gps.push(...sensors.gps(st, chi, def.originLat, def.originLon));
    truth.push({
      t,
      x: ps.x,
      y: ps.y,
      heading,
      course: chi,
      speed: v,
      beta,
      yawRate,
      ay,
      ax,
      drifting: cmd !== 0 || Math.abs(beta) > 0.1,
    });

    s += v * dt;
    t += dt;
  }
  // roll to a stop after the finish so the run ends parked
  for (let i = 0; i < 4 * rate && v > 0.3; i++) {
    const ps = path.at(def.closed ? s % path.length : s);
    aCmd += ((-3.5 - aCmd) / 0.3) * dt;
    v = Math.max(0, v + aCmd * dt);
    const st = { t, x: ps.x, y: ps.y, heading: ps.chi, speed: v, ax: aCmd, ay: v * ps.kappa * v, yawRate: v * ps.kappa, rollRate: 0, pitchRate: 0, roll: 0, pitch: 0 };
    motion.push(sensors.motion(st, dt, 0, 0));
    gps.push(...sensors.gps(st, ps.chi, def.originLat, def.originLon));
    truth.push({ t, x: ps.x, y: ps.y, heading: ps.chi, course: ps.chi, speed: v, beta: 0, yawRate: 0, ay: 0, ax: -4, drifting: false });
    s += v * dt;
    t += dt;
  }
  return {
    trackId,
    motion,
    gps,
    truth,
    mount: sensors.mount,
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
