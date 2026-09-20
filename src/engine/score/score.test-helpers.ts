/**
 * Test-only bridge from the simulator's ground truth to the engine's contracts.
 * The real detector / track model are built in parallel; until they land, tests derive
 * DriftEvents from contiguous `truth.drifting` intervals and a TrackModel from the sim's
 * centre-line, corners and lap times. Not part of the engine (imports src/sim).
 */
import type { DriftEvent, Lap, SlipState, TrackModel, TruthSample } from '../types';
import { degToRad } from '../types';
import { Prng } from '../../sim/prng';
import type { SimulatedRun } from '../../sim';

export function statesFromTruth(truth: TruthSample[], noiseDeg = 1, seed = 7): SlipState[] {
  const rng = new Prng(seed);
  const sigma = degToRad(noiseDeg);
  return truth.map((tr) => ({
    t: tr.t,
    beta: tr.beta + sigma * rng.gauss(),
    betaSigma: sigma,
    heading: tr.heading,
    course: tr.course,
    speed: tr.speed,
    yawRate: tr.yawRate,
    ay: tr.ay,
    ax: tr.ax,
    x: tr.x,
    y: tr.y,
    valid: tr.speed > 1,
  }));
}

/** Build a DriftEvent for an inclusive sample range of `states` (β from `states`, or from `truth` when given). */
export function eventFromRange(id: number, states: SlipState[], a0: number, b0: number, truth?: TruthSample[]): DriftEvent {
  const seg = states.slice(a0, b0 + 1);
  const beta = (i: number) => (truth ? truth[a0 + i].beta : seg[i].beta);
  let peak = 0;
  let peakT = seg[0].t;
  let sum = 0;
  for (let i = 0; i < seg.length; i++) {
    const v = Math.abs(beta(i));
    sum += v;
    if (v > peak) {
      peak = v;
      peakT = seg[i].t;
    }
  }
  const mean = sum / seg.length;
  let sq = 0;
  for (let i = 0; i < seg.length; i++) sq += (Math.abs(beta(i)) - mean) ** 2;
  let transitions = 0;
  let last = 0;
  for (let i = 0; i < seg.length; i++) {
    const b = beta(i);
    const sg = b > 0.14 ? 1 : b < -0.14 ? -1 : 0;
    if (sg !== 0) {
      if (last !== 0 && sg !== last) transitions++;
      last = sg;
    }
  }
  let dist = 0;
  for (let i = 1; i < seg.length; i++) dist += Math.hypot(seg[i].x - seg[i - 1].x, seg[i].y - seg[i - 1].y);
  return {
    id,
    startT: seg[0].t,
    endT: seg[seg.length - 1].t,
    durationS: seg[seg.length - 1].t - seg[0].t,
    peakAngle: peak,
    peakAngleT: peakT,
    meanAngle: mean,
    angleStdDev: Math.sqrt(sq / seg.length),
    transitions,
    entrySpeed: seg[0].speed,
    meanSpeed: seg.reduce((x, s) => x + s.speed, 0) / seg.length,
    minSpeed: seg.reduce((x, s) => Math.min(x, s.speed), Infinity),
    distanceM: dist,
    peakYawRate: seg.reduce((x, s) => Math.max(x, Math.abs(s.yawRate)), 0),
    peakLateralAccel: seg.reduce((x, s) => Math.max(x, Math.abs(s.ay)), 0),
    initialDirection: beta(Math.min(seg.length - 1, 30)) >= 0 ? 1 : -1,
    spin: false,
    sampleStart: a0,
    sampleEnd: b0,
  };
}

/** Contiguous `truth.drifting` intervals → DriftEvents (inclusive sample ranges). */
export function eventsFromTruth(truth: TruthSample[], states: SlipState[], minS = 0.3): DriftEvent[] {
  const out: DriftEvent[] = [];
  let a = -1;
  const flush = (a0: number, b0: number) => {
    if (states[b0].t - states[a0].t < minS) return;
    out.push(eventFromRange(out.length + 1, states, a0, b0, truth));
  };
  for (let i = 0; i < truth.length; i++) {
    if (truth[i].drifting && a < 0) a = i;
    if (!truth[i].drifting && a >= 0) {
      flush(a, i - 1);
      a = -1;
    }
  }
  if (a >= 0) flush(a, truth.length - 1);
  return out;
}

/** TrackModel from the simulator's centre-line, corners and lap times. */
export function trackFromRun(run: SimulatedRun, states: SlipState[]): TrackModel {
  const laps: Lap[] = [];
  const closed = run.lapTimes.length > 1;
  if (closed) {
    for (let k = 0; k + 1 < run.lapTimes.length; k++) {
      const startT = run.lapTimes[k];
      const endT = run.lapTimes[k + 1];
      let sampleStart = states.findIndex((s) => s.t >= startT);
      let sampleEnd = states.findIndex((s) => s.t >= endT);
      if (sampleStart < 0) sampleStart = 0;
      if (sampleEnd < 0) sampleEnd = states.length - 1;
      else sampleEnd = Math.max(sampleStart, sampleEnd - 1);
      laps.push({ index: k, startT, endT, durationS: endT - startT, sampleStart, sampleEnd });
    }
  }
  const lengthM = run.centreLine[run.centreLine.length - 1].s;
  return {
    originLat: run.originLat,
    originLon: run.originLon,
    refPath: run.centreLine.filter((_, i) => i % 2 === 0),
    closed,
    lengthM,
    corners: run.corners.map((c, i) => ({ id: i, apexS: c.apexS, startS: c.startS, endS: c.endS, x: c.x, y: c.y, direction: c.direction, radiusM: c.radius })),
    laps,
  };
}
