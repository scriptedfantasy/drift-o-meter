import { describe, expect, it } from 'vitest';
import { simulateRun, type SimulateOptions, type TrackId } from '../../sim';
import { type GpsSample, type VehicleMotionSample, degToRad, radToDeg } from '../types';
import { SlipEstimator } from './index';
import { History } from './history';
import { evaluate, formatMetricsTable, originOffset, runEstimator, type SlipMetrics } from './testkit';

interface Case {
  name: string;
  track: TrackId;
  sim: SimulateOptions;
}

const CASES: Case[] = [
  { name: 'harbor s1', track: 'harbor', sim: { seed: 1, laps: 2 } },
  { name: 'harbor s2', track: 'harbor', sim: { seed: 2, laps: 2 } },
  { name: 'harbor s3', track: 'harbor', sim: { seed: 3, laps: 2 } },
  { name: 'touge s1', track: 'touge', sim: { seed: 1 } },
  { name: 'harbor s1 dropouts', track: 'harbor', sim: { seed: 1, laps: 2, gpsDropouts: true } },
  { name: 'harbor s1 latency 0.8', track: 'harbor', sim: { seed: 1, laps: 2, gpsLatency: 0.8 } },
  { name: 'harbor s1 vibration 2', track: 'harbor', sim: { seed: 1, laps: 2, vibration: 2 } },
];

const TARGETS = {
  driftRmsDeg: 2.5,
  straightRmsDeg: 1.0,
  peakDeg: 8,
  lagMs: 120,
  signErrors: 0,
  speedRms: 0.6,
  posRms: 4,
};

function runCase(c: Case): SlipMetrics {
  const run = simulateRun(c.track, c.sim);
  const est = new SlipEstimator(); // default options: gpsLatencyS 0.45 even when the sim uses 0.8
  const states = runEstimator(run, {}, est);
  return evaluate(c.name, run, states, { originOffset: originOffset(run, est) });
}

describe('SlipEstimator vs simulator ground truth', () => {
  const results: SlipMetrics[] = CASES.map(runCase);
  // eslint-disable-next-line no-console
  console.log('\n' + formatMetricsTable(results) + '\n');

  for (const m of results) {
    it(`${m.name}: every output finite and valid for most of the run`, () => {
      expect(m.allFinite).toBe(true);
      expect(m.validFraction).toBeGreaterThan(0.9);
      expect(m.driftSamples).toBeGreaterThan(500);
      expect(m.straightSamples).toBeGreaterThan(500);
    });
    it(`${m.name}: drift RMS < ${TARGETS.driftRmsDeg}°, peak < ${TARGETS.peakDeg}°`, () => {
      expect(m.driftRmsDeg).toBeLessThan(TARGETS.driftRmsDeg);
      expect(m.driftPeakDeg).toBeLessThan(TARGETS.peakDeg);
    });
    it(`${m.name}: straight RMS < ${TARGETS.straightRmsDeg}°, peak < ${TARGETS.peakDeg}°`, () => {
      expect(m.straightRmsDeg).toBeLessThan(TARGETS.straightRmsDeg);
      expect(m.straightPeakDeg).toBeLessThan(TARGETS.peakDeg);
    });
    it(`${m.name}: lag < ${TARGETS.lagMs} ms, no sign errors above 12°`, () => {
      expect(Math.abs(m.lagMs)).toBeLessThan(TARGETS.lagMs);
      expect(m.signErrors).toBe(TARGETS.signErrors);
      expect(m.signSamples).toBeGreaterThan(500);
    });
    it(`${m.name}: speed RMS < ${TARGETS.speedRms} m/s, position RMS < ${TARGETS.posRms} m`, () => {
      expect(m.speedRms).toBeLessThan(TARGETS.speedRms);
      expect(m.posRms).toBeLessThan(TARGETS.posRms);
    });
    it(`${m.name}: betaSigma is honest (≥ 85 % of drift samples within 2σ, mean σ < 6°)`, () => {
      expect(m.sigmaCoverage).toBeGreaterThan(0.85);
      expect(m.meanSigmaDeg).toBeLessThan(6);
    });
  }
});

describe('SlipEstimator behaviour', () => {
  const run = simulateRun('harbor', { seed: 1, laps: 1 });

  it('betaSigma is honest: larger during a GPS dropout than with GPS, and recovers after it', () => {
    // Same seed with and without dropouts → identical truth and IMU streams; only the GPS differs.
    const normal = simulateRun('harbor', { seed: 1, laps: 2 });
    const drop = simulateRun('harbor', { seed: 1, laps: 2, gpsDropouts: true });
    expect(drop.motion.length).toBe(normal.motion.length);
    const gps = [...drop.gps].sort((a, b) => a.t - b.t);
    const gaps: Array<{ start: number; len: number }> = [];
    for (let i = 1; i < gps.length; i++) {
      const g = gps[i].t - gps[i - 1].t;
      if (g > 2.5) gaps.push({ start: gps[i - 1].t, len: g });
    }
    expect(gaps.length).toBeGreaterThan(1);
    const sN = runEstimator(normal);
    const sD = runEstimator(drop);
    let worstDeficit = 0; // how much LESS uncertain the dropout run ever claims to be inside a gap
    let bestExcess = 0; // how much MORE uncertain it gets
    for (const gap of gaps) {
      for (let i = 0; i < sD.length; i++) {
        const t = sD[i].t;
        if (t < gap.start + 0.5 || t > gap.start + gap.len) continue;
        const diff = sD[i].betaSigma - sN[i].betaSigma;
        worstDeficit = Math.min(worstDeficit, diff);
        bestExcess = Math.max(bestExcess, diff);
      }
    }
    expect(bestExcess).toBeGreaterThan(degToRad(0.5));
    expect(worstDeficit).toBeGreaterThan(-degToRad(0.3));
    // recovery: 3 s after the longest gap ends the two runs agree again
    const longest = gaps.reduce((a, b) => (b.len > a.len ? b : a));
    const k = sD.findIndex((s) => s.t >= longest.start + longest.len + 3);
    expect(Math.abs(sD[k].betaSigma - sN[k].betaSigma)).toBeLessThan(degToRad(0.5));
    // and σ is not a constant: it moves with the fix schedule (grows between many fixes, shrinks at many)
    const at = (t: number) => sD.find((s) => s.t >= t)!;
    let grew = 0;
    let shrank = 0;
    let n = 0;
    for (let i = 1; i < gps.length; i++) {
      const ta = gps[i - 1].t;
      const tb = gps[i].t;
      if (tb - ta < 0.8 || tb - ta > 1.3) continue;
      const a = at(ta + 0.03);
      const b = at(tb - 0.03);
      const c = at(tb + 0.03);
      if (!a.valid || !b.valid) continue;
      n++;
      if (b.betaSigma > a.betaSigma) grew++;
      if (c.betaSigma < b.betaSigma) shrank++;
    }
    expect(n).toBeGreaterThan(50);
    expect(grew / n).toBeGreaterThan(0.5);
    expect(shrank / n).toBeGreaterThan(0.5);
  });

  it('ignores NaN / negative GPS speed and course without poisoning the filter', () => {
    const est = new SlipEstimator();
    const poisoned: GpsSample[] = run.gps.map((g, i) =>
      i % 3 === 1 ? { ...g, speed: NaN, course: NaN } : i % 3 === 2 ? { ...g, speed: -1, course: -1 } : g,
    );
    const states = runEstimator({ ...run, gps: poisoned }, {}, est);
    const m = evaluate('poisoned', run, states, { originOffset: originOffset(run, est) });
    expect(m.allFinite).toBe(true);
    expect(m.driftRmsDeg).toBeLessThan(4);
    expect(m.speedRms).toBeLessThan(1.0);
    expect(m.signErrors).toBe(0);
    // NaN position / hAcc too
    const est2 = new SlipEstimator();
    const nanPos: GpsSample[] = run.gps.map((g, i) => (i % 4 === 0 ? { ...g, lat: NaN, lon: NaN, hAcc: NaN } : g));
    const states2 = runEstimator({ ...run, gps: nanPos }, {}, est2);
    expect(evaluate('nanpos', run, states2, { originOffset: originOffset(run, est2) }).allFinite).toBe(true);
  });

  it('never reports valid before a GPS course lock and holds β near 0 below the speed floor', () => {
    const est = new SlipEstimator();
    const m = (t: number, ay: number, r: number): VehicleMotionSample => ({
      t,
      ax: 0,
      ay,
      az: 0,
      yawRate: r,
      rollRate: 0,
      pitchRate: 0,
      calibrationQuality: 1,
    });
    let s = est.state;
    for (let i = 0; i < 300; i++) s = est.pushMotion(m(i * 0.01, 3, 0.3));
    expect(s.valid).toBe(false);
    expect(Math.abs(s.beta)).toBeLessThan(degToRad(0.5));
    expect(Number.isFinite(s.betaSigma)).toBe(true);
    // slow fix with course: still not valid (speed below floor)
    est.pushGps({ t: 3.0, lat: 35, lon: 139, speed: 1, course: 90, hAcc: 4 });
    s = est.pushMotion(m(3.01, 0, 0));
    expect(s.valid).toBe(false);
    expect(s.speed).toBeLessThan(2);
  });

  it('position is smooth at 100 Hz (no teleporting) and reset() clears everything', () => {
    const est = new SlipEstimator();
    const states = runEstimator(run, {}, est);
    const m = evaluate('smooth', run, states);
    let maxExcess = 0;
    for (let i = 1; i < states.length; i++) {
      if (states[i].t < m.fromT) continue; // the sim's 0 → 12.7 m/s speed step at t = 3 s is excluded
      const d = Math.hypot(states[i].x - states[i - 1].x, states[i].y - states[i - 1].y);
      const dt = states[i].t - states[i - 1].t;
      maxExcess = Math.max(maxExcess, d - states[i].speed * dt);
    }
    // a step is the travelled distance plus a blended correction: never more than ~20 cm extra
    expect(maxExcess).toBeLessThan(0.2);
    expect(est.origin).not.toBeNull();
    est.reset();
    expect(est.origin).toBeNull();
    expect(est.state.valid).toBe(false);
    expect(est.state.speed).toBe(0);
    expect(est.state.x).toBe(0);
  });

  it('tracks the (random-walking) gyro bias to within 0.15°/s', () => {
    // stop 10 s before the end: the simulator's roll-to-stop phase teleports the truth heading
    const cut = run.motion.length - 1000;
    const trimmed = { ...run, motion: run.motion.slice(0, cut), truth: run.truth.slice(0, cut) };
    const est = new SlipEstimator();
    runEstimator(trimmed, {}, est);
    // true bias over the last 10 s before the cut (the simulator's bias random-walks ~0.1°/s per run)
    const n = cut;
    let acc = 0;
    for (let i = n - 1000; i < n; i++) {
      const mm = run.motion[i].rotationRate;
      const r = run.mount[6] * mm.x + run.mount[7] * mm.y + run.mount[8] * mm.z;
      acc += r - run.truth[i].yawRate;
    }
    const trueBias = acc / 1000;
    expect(Math.abs(trueBias)).toBeGreaterThan(degToRad(0.1)); // the test is meaningful
    expect(Math.abs(est.gyroBias.value - trueBias)).toBeLessThan(degToRad(0.15));
    expect(est.gyroBias.sigma).toBeLessThan(degToRad(0.3));
  });

  it('adapts the assumed GPS latency toward the real one', () => {
    const slow = simulateRun('harbor', { seed: 2, laps: 2, gpsLatency: 0.8 });
    const est = new SlipEstimator({ gpsLatencyS: 0.45 });
    runEstimator(slow, {}, est);
    expect(est.gpsLatency).toBeGreaterThan(0.6);
    expect(est.gpsLatency).toBeLessThan(1.0);
    const fast = simulateRun('harbor', { seed: 2, laps: 2, gpsLatency: 0.2 });
    const est2 = new SlipEstimator({ gpsLatencyS: 0.45 });
    runEstimator(fast, {}, est2);
    expect(est2.gpsLatency).toBeLessThan(0.35);
  });

  it('is deterministic', () => {
    const a = runEstimator(run);
    const b = runEstimator(run);
    expect(a[4000].beta).toBe(b[4000].beta);
    expect(a[4000].x).toBe(b[4000].x);
  });
});

describe('History ring buffer', () => {
  it('interpolates and clamps', () => {
    const h = new History(8);
    for (let i = 0; i < 20; i++) h.push({ t: i, c: i * 2, v: i * 3, x: i, y: -i, cl: i * 2 - 1, vl: i * 3 - 1 });
    expect(h.length).toBe(8);
    expect(h.oldestT()).toBe(12);
    expect(h.newestT()).toBe(19);
    const mid = h.at(14.5)!;
    expect(mid.c).toBeCloseTo(29);
    expect(mid.v).toBeCloseTo(43.5);
    expect(mid.clamped).toBe(0);
    const old = h.at(3)!;
    expect(old.t).toBe(12);
    expect(old.clamped).toBe(9);
    const fut = h.at(25)!;
    expect(fut.t).toBe(19);
    expect(fut.clamped).toBe(6);
    expect(new History(4).at(1)).toBeNull();
  });
});

// keep radToDeg referenced for readable debugging output in failures
void radToDeg;
