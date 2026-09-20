/**
 * Test/demo fixture: fill a `Session` straight from simulator ground truth, bypassing the
 * estimator/detector/scorer pipeline. Drift events, laps and a plausible score are derived
 * with simple rules so the replay module (and the renderers) have something to chew on.
 * Other modules will replace this with the real pipeline output.
 */
import type { SimulatedRun } from '../../sim';
import {
  clamp,
  degToRad,
  type DriftEvent,
  type DriftScore,
  type Grade,
  type Lap,
  type MountCalibration,
  type Session,
  type SessionScore,
  type SlipState,
  type StyleCallout,
  type TrackCorner,
  type TrackModel,
  type TruthSample,
} from '../types';

export interface FixtureOptions {
  /** Merge drifting intervals separated by less than this, s. */
  mergeGapS: number;
  /** Drop drifting intervals shorter than this, s. */
  minDurationS: number;
  /** |β| that counts as "strong" for transitions / std-dev, rad. */
  strongAngle: number;
  /** Points per second at the reference angle. */
  pointsPerS: number;
  /** Angle at which the angle factor is 1. */
  refAngle: number;
  /** Track name used as session name prefix. */
  name?: string;
  /** Build a TrackModel (true) or leave `track` null. */
  track: boolean;
}

const DEFAULT_FIXTURE: FixtureOptions = {
  mergeGapS: 0.3,
  minDurationS: 0.6,
  strongAngle: degToRad(8),
  pointsPerS: 100,
  refAngle: degToRad(30),
  track: true,
};

function stateFromTruth(s: TruthSample): SlipState {
  return {
    t: s.t,
    beta: s.beta,
    betaSigma: 0.02,
    heading: s.heading,
    course: s.course,
    speed: s.speed,
    yawRate: s.yawRate,
    ay: s.ay,
    ax: s.ax,
    x: s.x,
    y: s.y,
    valid: s.speed > 2,
  };
}

function driftIntervals(truth: TruthSample[], opt: FixtureOptions): Array<[number, number]> {
  const raw: Array<[number, number]> = [];
  let start = -1;
  for (let i = 0; i < truth.length; i++) {
    if (truth[i].drifting && start < 0) start = i;
    if (!truth[i].drifting && start >= 0) {
      raw.push([start, i - 1]);
      start = -1;
    }
  }
  if (start >= 0) raw.push([start, truth.length - 1]);
  const merged: Array<[number, number]> = [];
  for (const iv of raw) {
    const last = merged[merged.length - 1];
    if (last && truth[iv[0]].t - truth[last[1]].t < opt.mergeGapS) last[1] = iv[1];
    else merged.push([iv[0], iv[1]]);
  }
  return merged.filter(([a, b]) => truth[b].t - truth[a].t >= opt.minDurationS);
}

function makeDrift(id: number, truth: TruthSample[], a: number, b: number, opt: FixtureOptions): DriftEvent {
  let peak = 0;
  let peakT = truth[a].t;
  let sumAbs = 0;
  let n = 0;
  const strong: number[] = [];
  let transitions = 0;
  let lastStrong = 0;
  let initial: 1 | -1 | 0 = 0;
  let sumV = 0;
  let minV = Infinity;
  let dist = 0;
  let peakYaw = 0;
  let peakAy = 0;
  for (let i = a; i <= b; i++) {
    const s = truth[i];
    const ab = Math.abs(s.beta);
    if (ab > peak) {
      peak = ab;
      peakT = s.t;
    }
    sumAbs += ab;
    n++;
    sumV += s.speed;
    if (s.speed < minV) minV = s.speed;
    if (i > a) dist += 0.5 * (s.speed + truth[i - 1].speed) * (s.t - truth[i - 1].t);
    if (Math.abs(s.yawRate) > peakYaw) peakYaw = Math.abs(s.yawRate);
    if (Math.abs(s.ay) > peakAy) peakAy = Math.abs(s.ay);
    if (ab > opt.strongAngle) {
      strong.push(ab);
      const sg = s.beta > 0 ? 1 : -1;
      if (initial === 0) initial = sg;
      if (lastStrong !== 0 && sg !== lastStrong) transitions++;
      lastStrong = sg;
    }
  }
  const mean = sumAbs / Math.max(1, n);
  let std = 0;
  if (strong.length > 1) {
    const m = strong.reduce((x, y) => x + y, 0) / strong.length;
    std = Math.sqrt(strong.reduce((x, y) => x + (y - m) * (y - m), 0) / strong.length);
  }
  return {
    id,
    startT: truth[a].t,
    endT: truth[b].t,
    durationS: truth[b].t - truth[a].t,
    peakAngle: peak,
    peakAngleT: peakT,
    meanAngle: mean,
    angleStdDev: std,
    transitions,
    entrySpeed: truth[a].speed,
    meanSpeed: sumV / Math.max(1, n),
    minSpeed: Number.isFinite(minV) ? minV : 0,
    distanceM: dist,
    peakYawRate: peakYaw,
    peakLateralG: peakAy,
    initialDirection: initial === -1 ? -1 : 1,
    sampleStart: a,
    sampleEnd: b,
  };
}

function scoreDrift(d: DriftEvent, truth: TruthSample[], opt: FixtureOptions): DriftScore {
  // base: pointsPerS × angle factor (|β|/refAngle, capped at 1.5) × speed factor
  let base = 0;
  for (let i = d.sampleStart + 1; i <= d.sampleEnd; i++) {
    const s = truth[i];
    const dt = s.t - truth[i - 1].t;
    const angleF = clamp(Math.abs(s.beta) / opt.refAngle, 0, 1.5);
    const speedF = clamp(0.5 + s.speed / 30, 0.5, 1.5);
    base += opt.pointsPerS * angleF * speedF * dt;
  }
  base = Math.round(base);
  const callouts: StyleCallout[] = [{ t: d.startT, kind: 'initiation', label: 'INITIATION', points: 0 }];
  let bonus = 0;
  if (d.transitions > 0) {
    const pts = 250 * d.transitions;
    callouts.push({ t: d.startT + d.durationS * 0.5, kind: 'transition', label: `TRANSITION x${d.transitions}`, points: pts });
    bonus += pts;
  }
  if (d.peakAngle > degToRad(40)) {
    callouts.push({ t: d.peakAngleT, kind: 'extreme-angle', label: 'EXTREME ANGLE', points: 500 });
    bonus += 500;
  }
  if (d.durationS > 5) {
    callouts.push({ t: d.startT + 5, kind: 'long-drift', label: 'LONG DRIFT', points: 300 });
    bonus += 300;
  }
  if (d.angleStdDev < degToRad(4) && d.durationS > 2) {
    callouts.push({ t: d.endT, kind: 'smooth', label: 'SMOOTH', points: 200 });
    bonus += 200;
  }
  if (d.meanSpeed > 22) {
    callouts.push({ t: d.endT, kind: 'high-speed', label: 'HIGH SPEED', points: 300 });
    bonus += 300;
  }
  const multiplier = clamp(1 + 0.5 * d.transitions + 0.1 * Math.floor(d.durationS / 3), 1, 5);
  const total = Math.round(base * multiplier + bonus);
  return {
    base,
    multiplier,
    bonus,
    total,
    angle: clamp((d.peakAngle / degToRad(50)) * 100, 0, 100),
    consistency: clamp(100 - (d.angleStdDev * 180) / Math.PI * 8, 0, 100),
    speed: clamp((d.meanSpeed / 30) * 100, 0, 100),
    style: clamp(d.transitions * 30 + bonus / 10, 0, 100),
    callouts,
  };
}

function gradeFor(total: number, drifts: number): Grade {
  const per = drifts > 0 ? total / drifts : 0;
  if (per >= 4000) return 'S';
  if (per >= 2500) return 'A';
  if (per >= 1500) return 'B';
  if (per >= 700) return 'C';
  return 'D';
}

function buildTrack(run: SimulatedRun, truth: TruthSample[]): TrackModel {
  const cl = run.centreLine;
  const first = cl[0];
  const last = cl[cl.length - 1];
  const closed = run.lapTimes.length >= 2 && Math.hypot(first.x - last.x, first.y - last.y) < 5;
  const lengthM = closed ? last.s + (cl[1]?.s ?? 0.5) : last.s;
  // ~1 m spacing
  const refPath = cl.filter((_, i) => i % 2 === 0).map((p) => ({ x: p.x, y: p.y, s: p.s }));
  const corners: TrackCorner[] = run.corners.map((c, i) => ({
    id: i,
    apexS: c.apexS,
    startS: c.startS,
    endS: c.endS,
    x: c.x,
    y: c.y,
    direction: c.direction,
    radiusM: c.radius,
  }));
  const laps: Lap[] = [];
  if (closed) {
    // lap k spans lapTimes[k]..lapTimes[k+1]; the final "lap end" from the simulator is the end of
    // the roll-out, so clip it to the moment the car has covered laps × lengthM.
    let dist = 0;
    let finishT = truth[truth.length - 1].t;
    const lapsPlanned = run.lapTimes.length - 1;
    for (let i = 1; i < truth.length; i++) {
      dist += 0.5 * (truth[i].speed + truth[i - 1].speed) * (truth[i].t - truth[i - 1].t);
      if (dist >= lapsPlanned * lengthM) {
        finishT = truth[i].t;
        break;
      }
    }
    let cursor = 0;
    for (let k = 0; k < lapsPlanned; k++) {
      const startT = run.lapTimes[k];
      const endT = k === lapsPlanned - 1 ? Math.min(run.lapTimes[k + 1], finishT) : run.lapTimes[k + 1];
      if (endT <= startT) continue;
      while (cursor < truth.length && truth[cursor].t < startT) cursor++;
      const sampleStart = cursor;
      let e = cursor;
      while (e < truth.length - 1 && truth[e + 1].t <= endT) e++;
      laps.push({ index: k, startT, endT, durationS: endT - startT, sampleStart, sampleEnd: e });
    }
  }
  const p1 = cl[Math.min(2, cl.length - 1)];
  const chi = Math.atan2(p1.y - first.y, p1.x - first.x);
  const gate = closed ? { ax: first.x - 6 * Math.sin(chi), ay: first.y + 6 * Math.cos(chi), bx: first.x + 6 * Math.sin(chi), by: first.y - 6 * Math.cos(chi) } : undefined;
  return { originLat: run.originLat, originLon: run.originLon, refPath, closed, lengthM, corners, laps, gate };
}

/** Build a Session from a simulated run's ground truth. */
export function sessionFromSimulation(run: SimulatedRun, partial: Partial<FixtureOptions> = {}): Session {
  const opt: FixtureOptions = { ...DEFAULT_FIXTURE, ...partial };
  const truth = run.truth;
  const states = truth.map(stateFromTruth);
  const drifts = driftIntervals(truth, opt).map(([a, b], i) => makeDrift(i + 1, truth, a, b, opt));
  const perDrift: Record<number, DriftScore> = {};
  let total = 0;
  let bestId: number | null = null;
  let best = -1;
  let angle = 0;
  let consistency = 0;
  let speed = 0;
  let style = 0;
  let longest = 0;
  for (const d of drifts) {
    const s = scoreDrift(d, truth, opt);
    perDrift[d.id] = s;
    total += s.total;
    if (s.total > best) {
      best = s.total;
      bestId = d.id;
    }
    angle += s.angle;
    consistency += s.consistency;
    speed += s.speed;
    style += s.style;
    if (s.total > longest) longest = s.total;
  }
  const n = Math.max(1, drifts.length);
  const score: SessionScore = {
    total,
    grade: gradeFor(total, drifts.length),
    angle: angle / n,
    consistency: consistency / n,
    quality: clamp((angle + consistency) / (2 * n), 0, 100),
    speed: speed / n,
    style: style / n,
    bestDriftId: bestId,
    longestChainPoints: longest,
    perDrift,
  };
  const calibration: MountCalibration = { r: [1, 0, 0, 0, 1, 0, 0, 0, 1], quality: 1, forwardResolved: true, t: 0 };
  const trackName = typeof run.meta.track === 'string' ? run.meta.track : run.trackId;
  return {
    version: 1,
    id: `sim-${run.trackId}-${String(run.meta.seed ?? 0)}`,
    name: opt.name ?? `${trackName} (sim)`,
    startedAt: Date.UTC(2026, 0, 1),
    durationS: truth.length ? truth[truth.length - 1].t - truth[0].t : 0,
    motion: run.motion,
    gps: run.gps,
    states,
    drifts,
    score,
    track: opt.track ? buildTrack(run, truth) : null,
    calibration,
    truth,
    meta: { ...run.meta, trackId: run.trackId, source: 'simulation' },
  };
}
