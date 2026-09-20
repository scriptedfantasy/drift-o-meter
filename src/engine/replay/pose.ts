import { clamp } from '../types';
import { lerpAngle, severityOf, trailIndexOf, trailValueAt } from './build';
import type { ActiveEvent, GhostPose, Replay, ReplayLap, ReplayPose } from './types';

/**
 * The car's state at replay time `t` (seconds since replay start), interpolated between trail
 * samples. Angles use shortest-arc interpolation so a heading (or β) wrap at ±π never produces
 * a spin or a phantom 0°.
 */
export function poseAt(replay: Replay, t: number): ReplayPose {
  const trail = replay.trail;
  const tt = clamp(Number.isFinite(t) ? t : 0, 0, replay.durationS);
  const fi = trailIndexOf(trail, tt);
  const i0 = Math.floor(fi);
  const i1 = Math.min(i0 + 1, trail.n - 1);
  const f = fi - i0;
  const lin = (arr: ArrayLike<number>) => arr[i0] + (arr[i1] - arr[i0]) * f;
  const beta = lerpAngle(trail.beta[i0], trail.beta[i1], f);
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
    multiplier: lin(trail.multiplier),
    chain: lin(trail.chain),
    phase: segment >= 0 ? 'drifting' : 'idle',
    intensity: clamp((Math.abs(beta) - replay.options.intensityLo) / (replay.options.intensityHi - replay.options.intensityLo), 0, 1),
    severity: severityOf(beta),
    segment,
    lap,
    dist: lin(trail.dist),
  };
}

/** The lap containing replay time t, or null. */
export function lapAt(replay: Replay, t: number): ReplayLap | null {
  const laps = replay.laps;
  for (let i = 0; i < laps.length; i++) {
    const lap = laps[i];
    const last = i === laps.length - 1;
    if (t >= lap.startT && (t < lap.endT || (last && t <= lap.endT))) return lap;
  }
  return null;
}

/** Invert a monotone distance array: the τ at which the ghost had covered `d` metres. */
function tauAtDistance(dist: Float64Array, tau: Float64Array, d: number): number {
  const n = dist.length;
  if (n === 0) return 0;
  if (d <= dist[0]) return tau[0];
  if (d >= dist[n - 1]) return tau[n - 1];
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (dist[mid] <= d) lo = mid;
    else hi = mid;
  }
  const span = dist[hi] - dist[lo];
  const f = span > 1e-9 ? (d - dist[lo]) / span : 0;
  return tau[lo] + (tau[hi] - tau[lo]) * f;
}

/** Same idea for points: how many points the ghost had scored by lap-time τ. */
function valueAtTau(arr: Float64Array, tau: number, hz: number): number {
  const n = arr.length;
  const fi = clamp(tau * hz, 0, n - 1);
  const i0 = Math.floor(fi);
  const i1 = Math.min(i0 + 1, n - 1);
  return arr[i0] + (arr[i1] - arr[i0]) * (fi - i0);
}

/**
 * Where the ghost is at replay time t.
 *
 * The ghost is ALWAYS a different lap from the one being watched (`ReplayLap.ghostRef`), so it
 * can never be numerically identical to the car. It is time-synchronised to the current lap: at
 * the same elapsed time since the line, this is where the reference lap's car was.
 *
 * Gaps: `gapS` is a true time gap (how much earlier the car reached this point than the ghost
 * did, by inverting the ghost's distance→time curve) — it does not flicker with instantaneous
 * speed. `gapPoints` compares the score at the same point of the lap, which is what the
 * points-chosen reference lap actually means. Returns null outside laps or with no ghost.
 */
export function ghostPoseAt(replay: Replay, t: number): GhostPose | null {
  if (!replay.ghost || replay.laps.length === 0) return null;
  const lap = lapAt(replay, t);
  if (!lap || lap.ghostRef < 0) return null;
  const ref = replay.laps.find((l) => l.index === lap.ghostRef);
  if (!ref) return null;
  const trail = replay.trail;
  const tau = t - lap.startT;
  const inLap = tau <= ref.durationS;
  const tg = clamp(ref.startT + tau, 0, replay.durationS);
  const gx = trailValueAt(trail, trail.x, tg);
  const gy = trailValueAt(trail, trail.y, tg);
  const fi = trailIndexOf(trail, tg);
  const i0 = Math.floor(fi);
  const i1 = Math.min(i0 + 1, trail.n - 1);
  const f = fi - i0;
  const refD0 = trailValueAt(trail, trail.dist, ref.startT);
  const refP0 = trailValueAt(trail, trail.score, ref.startT);
  const ghostDist = trailValueAt(trail, trail.dist, tg) - refD0;
  const ghostPoints = trailValueAt(trail, trail.score, tg) - refP0;
  const carDist = trailValueAt(trail, trail.dist, clamp(t, 0, replay.durationS)) - trailValueAt(trail, trail.dist, lap.startT);
  const carPoints = trailValueAt(trail, trail.score, clamp(t, 0, replay.durationS)) - trailValueAt(trail, trail.score, lap.startT);
  // true time gap: when did the ghost reach the car's distance?
  const g = replay.ghost;
  let gapS = 0;
  if (ref.index === g.lapIndex) {
    gapS = tau - tauAtDistance(g.dist, g.tau, carDist);
  } else {
    // reference lap is not the sampled ghost lap: walk the trail inside that lap
    const n = Math.max(2, Math.round(ref.durationS * trail.hz) + 1);
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      const d = trailValueAt(trail, trail.dist, ref.startT + mid / trail.hz) - refD0;
      if (d <= carDist) lo = mid;
      else hi = mid;
    }
    gapS = tau - lo / trail.hz;
  }
  return {
    x: gx,
    y: gy,
    heading: lerpAngle(trail.heading[i0], trail.heading[i1], f),
    course: lerpAngle(trail.course[i0], trail.course[i1], f),
    beta: lerpAngle(trail.beta[i0], trail.beta[i1], f),
    speed: trailValueAt(trail, trail.speed, tg),
    tau,
    lapIndex: ref.index,
    gapM: carDist - ghostDist,
    gapS: Number.isFinite(gapS) ? gapS : 0,
    gapPoints: carPoints - ghostPoints,
    inLap,
  };
}

/** Points the ghost had scored τ seconds into its lap (for a live points delta). */
export function ghostPointsAt(replay: Replay, tau: number): number {
  const g = replay.ghost;
  if (!g) return 0;
  return valueAtTau(g.points_, tau, g.hz);
}

/**
 * The dramatic beats live at time `t`, strongest first, with their animation phase resolved.
 * Both renderers drive slam/shake/fade from this so the app and the harness cannot diverge.
 * DESIGN.md: callouts slam 1.8 → 1.0 with overshoot (320 ms), shake ~100 ms.
 */
export function activeEvents(replay: Replay, t: number, limit = 4): ActiveEvent[] {
  const out: ActiveEvent[] = [];
  for (const e of replay.events) {
    const age = t - e.t;
    if (age < 0) continue;
    const total = e.holdS + 0.45;
    if (age > total) continue;
    // slam: 1.8 → 1.0 over 320 ms with a small overshoot, then hold
    const k = clamp(age / 0.32, 0, 1);
    const eased = 1 - Math.pow(1 - k, 3);
    const overshoot = k < 1 ? Math.sin(k * Math.PI) * 0.06 : 0;
    const scale = 1.8 - 0.8 * eased - overshoot;
    const fade = age <= e.holdS ? 1 : 1 - clamp((age - e.holdS) / 0.45, 0, 1);
    const shake = age < 0.18 ? e.magnitude * Math.pow(1 - age / 0.18, 2) : 0;
    out.push({ ...e, age, progress: clamp(age / total, 0, 1), scale, opacity: fade, shake });
  }
  out.sort((a, b) => b.priority - a.priority || a.age - b.age);
  return out.slice(0, limit);
}

/** Combined screen-shake amplitude 0..1 at time t (sum of live beats, capped). */
export function shakeAt(replay: Replay, t: number): number {
  let s = 0;
  for (const e of activeEvents(replay, t, 8)) s += e.shake;
  return clamp(s, 0, 1);
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
  const index = clamp(Math.round(clamp(Number.isFinite(t) ? t : 0, 0, replay.durationS) * tel.hz), 0, tel.n - 1);
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
