import { clamp } from '../types';
import { lerpAngle, trailIndexOf, trailValueAt } from './build';
import type { GhostPose, Replay, ReplayPose } from './types';

/**
 * The car's state at replay time `t` (seconds since replay start), interpolated between trail
 * samples. Angles use shortest-arc interpolation so a heading wrap at ±π never produces a spin.
 */
export function poseAt(replay: Replay, t: number): ReplayPose {
  const trail = replay.trail;
  const tt = clamp(t, 0, replay.durationS);
  const fi = trailIndexOf(trail, tt);
  const i0 = Math.floor(fi);
  const i1 = Math.min(i0 + 1, trail.n - 1);
  const f = fi - i0;
  const lin = (arr: ArrayLike<number>) => arr[i0] + (arr[i1] - arr[i0]) * f;
  const beta = lin(trail.beta);
  const near = f < 0.5 ? i0 : i1;
  const segment = trail.segmentOf[near];
  const lap = trail.lapOf[near];
  return {
    t: tt,
    x: lin(trail.x),
    y: lin(trail.y),
    heading: lerpAngle(trail.heading[i0], trail.heading[i1], f),
    course: lerpAngle(trail.course[i0], trail.course[i1], f),
    beta,
    speed: lin(trail.speed),
    points: lin(trail.score),
    phase: segment >= 0 ? 'drifting' : 'idle',
    intensity: clamp((Math.abs(beta) - replay.options.intensityLo) / (replay.options.intensityHi - replay.options.intensityLo), 0, 1),
    segment,
    lap,
    dist: lin(trail.dist),
  };
}

/** The lap containing replay time t, or null. */
export function lapAt(replay: Replay, t: number): Replay['laps'][number] | null {
  const laps = replay.laps;
  for (let i = 0; i < laps.length; i++) {
    const lap = laps[i];
    const last = i === laps.length - 1;
    if (t >= lap.startT && (t < lap.endT || (last && t <= lap.endT))) return lap;
  }
  return null;
}

/**
 * Where the best-lap ghost is at replay time t: the ghost is time-synchronised to the current
 * lap (same elapsed time since the line), so it runs ahead when the current lap is slower.
 * After the ghost crosses the line it keeps driving along the recorded continuation of its lap.
 * Returns null outside laps or when the replay has no ghost.
 */
export function ghostPoseAt(replay: Replay, t: number): GhostPose | null {
  const ghost = replay.ghost;
  if (!ghost) return null;
  const lap = lapAt(replay, t);
  if (!lap) return null;
  const tau = t - lap.startT;
  const trail = replay.trail;
  const carDist = trailValueAt(trail, trail.dist, clamp(t, 0, replay.durationS)) - trailValueAt(trail, trail.dist, lap.startT);
  if (tau <= ghost.durationS) {
    const fi = clamp(tau * ghost.hz, 0, ghost.n - 1);
    const i0 = Math.floor(fi);
    const i1 = Math.min(i0 + 1, ghost.n - 1);
    const f = fi - i0;
    const lin = (arr: Float64Array) => arr[i0] + (arr[i1] - arr[i0]) * f;
    const dist = lin(ghost.dist);
    return {
      x: lin(ghost.x),
      y: lin(ghost.y),
      heading: lerpAngle(ghost.heading[i0], ghost.heading[i1], f),
      course: lerpAngle(ghost.course[i0], ghost.course[i1], f),
      beta: lin(ghost.beta),
      speed: lin(ghost.speed),
      tau,
      gapM: carDist - dist,
      inLap: true,
    };
  }
  // past the line: continue along the recorded trail after the best lap
  const tg = clamp(ghost.startT + tau, 0, replay.durationS);
  const p = poseAt(replay, tg);
  const dist = p.dist - trailValueAt(trail, trail.dist, ghost.startT);
  return { x: p.x, y: p.y, heading: p.heading, course: p.course, beta: p.beta, speed: p.speed, tau, gapM: carDist - dist, inLap: false };
}

export interface TelemetrySample {
  index: number;
  t: number;
  speed: number;
  /** |β|, radians. */
  angle: number;
  beta: number;
  points: number;
  drifting: boolean;
}

/** Nearest telemetry-strip sample to replay time t (for the scrubber). */
export function scrubTelemetry(replay: Replay, t: number): TelemetrySample {
  const tel = replay.telemetry;
  const index = clamp(Math.round(clamp(t, 0, replay.durationS) * tel.hz), 0, tel.n - 1);
  return {
    index,
    t: tel.t[index],
    speed: tel.speed[index],
    angle: tel.angle[index],
    beta: tel.beta[index],
    points: tel.points[index],
    drifting: tel.drifting[index] === 1,
  };
}
