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
 * can never be numerically identical to the car.
 *
 * It is synchronised by DISTANCE, not by time: the ghost sits at the point of the reference lap
 * where that lap had covered the same distance into the lap. Time-syncing put it 60–100 m away
 * for 88 % of the lap — an off-screen badge rather than a car — whereas distance-syncing keeps
 * it on screen essentially always and makes the comparison the useful one for a drift app: the
 * same corner, the reference line and angle against yours. The ahead/behind information is not
 * lost, it moves into the labels:
 *   `gapS`      how much earlier (+) or later (−) the car reached this point than the reference
 *               lap did — a true time gap from the distance→time curve, so it does not flicker
 *   `gapPoints` the score delta at the same point of the lap
 *   `gapM`      how far the car is off the reference line here, metres
 * Returns null outside laps or when the replay has no ghost.
 */
export function ghostPoseAt(replay: Replay, t: number): GhostPose | null {
  if (!replay.ghost || replay.laps.length === 0) return null;
  const lap = lapAt(replay, t);
  if (!lap || lap.ghostRef < 0) return null;
  const ref = replay.laps.find((l) => l.index === lap.ghostRef);
  if (!ref) return null;
  const trail = replay.trail;
  const tau = t - lap.startT;
  const carX = trailValueAt(trail, trail.x, clamp(t, 0, replay.durationS));
  const carY = trailValueAt(trail, trail.y, clamp(t, 0, replay.durationS));
  const refD0 = trailValueAt(trail, trail.dist, ref.startT);
  const refP0 = trailValueAt(trail, trail.score, ref.startT);
  const carDist = trailValueAt(trail, trail.dist, clamp(t, 0, replay.durationS)) - trailValueAt(trail, trail.dist, lap.startT);
  const carPoints = trailValueAt(trail, trail.score, clamp(t, 0, replay.durationS)) - trailValueAt(trail, trail.score, lap.startT);
  // when did the reference lap reach this distance?
  const g = replay.ghost;
  let refTau: number;
  if (ref.index === g.lapIndex) {
    refTau = tauAtDistance(g.dist, g.tau, carDist);
  } else {
    const n = Math.max(2, Math.round(ref.durationS * trail.hz) + 1);
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      const d = trailValueAt(trail, trail.dist, ref.startT + mid / trail.hz) - refD0;
      if (d <= carDist) lo = mid;
      else hi = mid;
    }
    refTau = lo / trail.hz;
  }
  const inLap = refTau < ref.durationS - 1e-6;
  // `time` sync places the ghost where the reference lap was at the same ELAPSED time — a car
  // to chase rather than a line to compare. The gaps below are identical either way.
  const poseTau = replay.options.ghostSync === 'time' ? Math.min(tau, ref.durationS) : Math.min(refTau, ref.durationS);
  const tg = clamp(ref.startT + poseTau, 0, replay.durationS);
  // the GAPS are always measured at the same point of the lap (distance-matched), whichever way
  // the pose is placed, so the numbers a driver reads do not change with the camera option
  const tGap = clamp(ref.startT + Math.min(refTau, ref.durationS), 0, replay.durationS);
  const fi = trailIndexOf(trail, tg);
  const i0 = Math.floor(fi);
  const i1 = Math.min(i0 + 1, trail.n - 1);
  const f = fi - i0;
  const gx = trailValueAt(trail, trail.x, tg);
  const gy = trailValueAt(trail, trail.y, tg);
  const ghostPoints = trailValueAt(trail, trail.score, tGap) - refP0;
  const gapS = refTau - tau;
  return {
    x: gx,
    y: gy,
    heading: lerpAngle(trail.heading[i0], trail.heading[i1], f),
    course: lerpAngle(trail.course[i0], trail.course[i1], f),
    beta: lerpAngle(trail.beta[i0], trail.beta[i1], f),
    speed: trailValueAt(trail, trail.speed, tg),
    tau: refTau,
    lapIndex: ref.index,
    gapM: Math.hypot(carX - gx, carY - gy),
    gapS: Number.isFinite(gapS) ? gapS : 0,
    gapPoints: carPoints - ghostPoints,
    inLap,
    sync: replay.options.ghostSync,
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
