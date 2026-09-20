import { describe, expect, it } from 'vitest';
import { simulateRun, buildPath, TRACKS, findCorners } from './index';
import { mountMatrix } from './sensors';
import { apply, mul, transpose } from './mat3';
import { radToDeg, wrapAngle, courseDegToMath, G } from '../engine/types';
import { Prng } from './prng';

function rms(a: number[]): number {
  return Math.sqrt(a.reduce((s, v) => s + v * v, 0) / Math.max(1, a.length));
}

describe('tracks', () => {
  it('builds both tracks with the advertised corners', () => {
    for (const id of ['harbor', 'touge'] as const) {
      const p = buildPath(TRACKS[id]);
      const c = findCorners(p);
      expect(p.length).toBeGreaterThan(500);
      expect(c.length).toBeGreaterThanOrEqual(4);
    }
    const harbor = findCorners(buildPath(TRACKS.harbor));
    // a real hairpin (R < 22 m), a genuine left–right chicane, and lefts and rights
    expect(Math.min(...harbor.map((c) => c.apexRadius))).toBeLessThan(22);
    const dirs = harbor.map((c) => c.direction);
    expect(dirs).toContain(1);
    expect(dirs).toContain(-1);
    expect(dirs.some((d, i) => i > 0 && d !== dirs[i - 1])).toBe(true);
  });

  it('closes the loop with uniform spacing', () => {
    const p = buildPath(TRACKS.harbor);
    const a = p.samples[p.samples.length - 1];
    const b = p.samples[0];
    const closing = Math.hypot(a.x - b.x, a.y - b.y);
    expect(Math.abs(closing - p.ds)).toBeLessThan(0.1);
  });
});

describe('mount presets', () => {
  it('are proper rotations', () => {
    const rng = new Prng(5);
    for (const preset of ['portrait-vent', 'landscape-dash', 'flat-console', 'random'] as const) {
      const R = mountMatrix(preset, rng);
      const I = mul(R, transpose(R));
      for (let i = 0; i < 9; i++) expect(Math.abs(I[i] - (i % 4 === 0 ? 1 : 0))).toBeLessThan(1e-9);
      const det = R[0] * (R[4] * R[8] - R[5] * R[7]) - R[1] * (R[3] * R[8] - R[5] * R[6]) + R[2] * (R[3] * R[7] - R[4] * R[6]);
      expect(det).toBeCloseTo(1, 9);
    }
    // portrait-vent: screen faces slightly UP (gravity has a negative z component in the phone frame)
    const R = mountMatrix('portrait-vent', rng);
    const gPhone = apply(transpose(R), { x: 0, y: 0, z: -G });
    expect(gPhone.z).toBeLessThan(0);
    expect(gPhone.y).toBeLessThan(-9);
  });
});

describe('kinematic ground truth', () => {
  const run = simulateRun('harbor', { seed: 3, laps: 2 });
  const tr = run.truth;

  it('has no teleports: speed and heading are continuous, run starts and ends parked', () => {
    let maxDv = 0;
    let maxDh = 0;
    for (let i = 1; i < tr.length; i++) {
      maxDv = Math.max(maxDv, Math.abs(tr[i].speed - tr[i - 1].speed));
      maxDh = Math.max(maxDh, Math.abs(wrapAngle(tr[i].heading - tr[i - 1].heading)));
    }
    expect(maxDv).toBeLessThan(0.6);
    expect(radToDeg(maxDh)).toBeLessThan(2);
    expect(tr[0].speed).toBe(0);
    expect(tr[tr.length - 1].speed).toBeLessThan(0.5);
    expect(Math.abs(tr[tr.length - 1].beta)).toBeLessThan(0.02);
  });

  it('satisfies heading = course − β and yawRate = d(heading)/dt', () => {
    const res: number[] = [];
    for (let i = 1; i < tr.length; i++) {
      expect(Math.abs(wrapAngle(tr[i].course - tr[i].beta - tr[i].heading))).toBeLessThan(1e-9);
      const dt = tr[i].t - tr[i - 1].t;
      if (dt > 0.02) continue; // across a dropped-sample gap
      const dh = wrapAngle(tr[i].heading - tr[i - 1].heading) / dt;
      res.push(dh - tr[i].yawRate);
    }
    expect(radToDeg(rms(res))).toBeLessThan(1.5);
  });

  it('satisfies the lateral/longitudinal acceleration identities', () => {
    const resAy: number[] = [];
    const resAx: number[] = [];
    for (let i = 2; i < tr.length - 2; i++) {
      const dt = tr[i + 1].t - tr[i - 1].t;
      if (dt > 0.03 || tr[i].speed < 2) continue;
      const vDot = (tr[i + 1].speed - tr[i - 1].speed) / dt;
      const betaDot = (tr[i + 1].beta - tr[i - 1].beta) / dt;
      const v = tr[i].speed;
      const b = tr[i].beta;
      const ay = vDot * Math.sin(b) + v * (tr[i].yawRate + betaDot) * Math.cos(b);
      const ax = vDot * Math.cos(b) - v * (tr[i].yawRate + betaDot) * Math.sin(b);
      resAy.push(ay - tr[i].ay);
      resAx.push(ax - tr[i].ax);
    }
    expect(rms(resAy)).toBeLessThan(0.3);
    expect(rms(resAx)).toBeLessThan(0.3);
  });

  it('positions integrate the course at the given speed', () => {
    const res: number[] = [];
    for (let i = 1; i < tr.length; i++) {
      const dt = tr[i].t - tr[i - 1].t;
      if (dt > 0.02 || tr[i].speed < 3) continue;
      const dx = tr[i].x - tr[i - 1].x;
      const dy = tr[i].y - tr[i - 1].y;
      const course = Math.atan2(dy, dx);
      res.push(wrapAngle(course - tr[i].course));
    }
    expect(radToDeg(rms(res))).toBeLessThan(1);
  });

  it('drifts like a drift car: 20–50° held angles, transitions, ≤ 1.15 g lateral, ≤ 150°/s yaw', () => {
    const peak = Math.max(...tr.map((s) => Math.abs(s.beta)));
    expect(radToDeg(peak)).toBeGreaterThan(30);
    expect(radToDeg(peak)).toBeLessThan(55);
    expect(Math.max(...tr.map((s) => Math.abs(s.ay)))).toBeLessThan(1.15 * G);
    expect(radToDeg(Math.max(...tr.map((s) => Math.abs(s.yawRate))))).toBeLessThan(150);
    // at least one sign change of β while drifting (a transition) per lap
    let transitions = 0;
    for (let i = 1; i < tr.length; i++) {
      if (tr[i].drifting && tr[i - 1].drifting && Math.sign(tr[i].beta) !== Math.sign(tr[i - 1].beta) && Math.abs(tr[i].beta) > 1e-6) transitions++;
    }
    expect(transitions).toBeGreaterThanOrEqual(2);
    // lap times recorded
    expect(run.lapTimes.length).toBe(3);
    expect(run.lapTimes[2] - run.lapTimes[1]).toBeGreaterThan(30);
  });
});

describe('sensor model', () => {
  it('gravity is consistent with the gyro on a rigid mount and with hand-held sway (ġ = −ω × g)', () => {
    for (const looseness of [0, 1]) {
      const run = simulateRun('harbor', { seed: 4, laps: 1, looseness, vibration: 0, gravityLean: 0, timestampJitter: 0, sampleGaps: false });
      // compare low-passed (τ 0.1 s) residuals so sensor noise does not dominate the physics signal
      const lpOk = { x: 0, y: 0, z: 0 };
      const lpBad = { x: 0, y: 0, z: 0 };
      const ok: number[] = [];
      const bad: number[] = [];
      for (let i = 1; i < run.motion.length; i++) {
        const a = run.motion[i - 1];
        const b = run.motion[i];
        const dt = b.t - a.t;
        if (dt > 0.02 || dt <= 0) continue;
        const gd = { x: (b.gravity.x - a.gravity.x) / dt, y: (b.gravity.y - a.gravity.y) / dt, z: (b.gravity.z - a.gravity.z) / dt };
        const w = b.rotationRate;
        const g = b.gravity;
        const cross = { x: w.y * g.z - w.z * g.y, y: w.z * g.x - w.x * g.z, z: w.x * g.y - w.y * g.x };
        const k = dt / 0.1;
        lpOk.x += (gd.x + cross.x - lpOk.x) * k;
        lpOk.y += (gd.y + cross.y - lpOk.y) * k;
        lpOk.z += (gd.z + cross.z - lpOk.z) * k;
        lpBad.x += (gd.x - cross.x - lpBad.x) * k;
        lpBad.y += (gd.y - cross.y - lpBad.y) * k;
        lpBad.z += (gd.z - cross.z - lpBad.z) * k;
        if (i > 50) {
          ok.push(Math.hypot(lpOk.x, lpOk.y, lpOk.z));
          bad.push(Math.hypot(lpBad.x, lpBad.y, lpBad.z));
        }
      }
      const rOk = rms(ok);
      const rBad = rms(bad);
      expect(rOk).toBeLessThan(rBad * 0.5);
      expect(rBad).toBeGreaterThan(looseness === 1 ? 3 : 0.1); // the physics signal is really there
    }
  });

  it('looseness adds gyro power, vibration is broadband and speed-scaled', () => {
    const rigid = simulateRun('harbor', { seed: 2, laps: 1, looseness: 0 });
    const loose = simulateRun('harbor', { seed: 2, laps: 1, looseness: 1 });
    const power = (r: typeof rigid) => rms(r.motion.map((m) => Math.hypot(m.rotationRate.x, m.rotationRate.y, m.rotationRate.z)));
    expect(power(loose)).toBeGreaterThan(power(rigid) * 1.5);
    const azFast: number[] = [];
    const azSlow: number[] = [];
    for (let i = 0; i < rigid.motion.length; i++) {
      const av = apply(rigid.mount, rigid.motion[i].accel);
      if (rigid.truth[i].speed > 20) azFast.push(av.z);
      else if (rigid.truth[i].speed < 1) azSlow.push(av.z);
    }
    const fast = rms(azFast);
    expect(fast).toBeGreaterThan(0.5);
    expect(fast).toBeLessThan(1.5);
    expect(rms(azSlow)).toBeLessThan(0.3);
  });

  it('timestamps jitter but stay monotonic; occasional gaps; truth stays index-aligned', () => {
    const run = simulateRun('touge', { seed: 7 });
    let gapsOver = 0;
    let maxJitter = 0;
    for (let i = 1; i < run.motion.length; i++) {
      const dt = run.motion[i].t - run.motion[i - 1].t;
      expect(dt).toBeGreaterThan(0);
      if (dt > 0.025) gapsOver++;
      maxJitter = Math.max(maxJitter, Math.abs(run.motion[i].t - run.truth[i].t));
    }
    expect(gapsOver).toBeGreaterThan(0);
    expect(maxJitter).toBeLessThan(0.012);
    expect(run.motion.length).toBe(run.truth.length);
  });
});

describe('gps model', () => {
  it('delivers fixes late by the configured latency, monotonic, with honest hAcc', () => {
    for (const lat of [0.2, 0.6, 1.0]) {
      const run = simulateRun('harbor', { seed: 5, laps: 1, gpsLatency: lat });
      expect(run.gpsLatency).toBeCloseTo(lat, 6);
      // measure: each fix's position corresponds to the truth position ~latency earlier
      const errs: number[] = [];
      const mLat = 111132.954;
      const mLon = 111132.954 * Math.cos((run.originLat * Math.PI) / 180);
      for (const g of run.gps) {
        if (g.speed < 5) continue;
        const gx = (g.lon - run.originLon) * mLon;
        const gy = (g.lat - run.originLat) * mLat;
        let best = Infinity;
        let bestT = 0;
        for (const s of run.truth) {
          if (s.t > g.t || s.t < g.t - 2) continue;
          const d = Math.hypot(s.x - gx, s.y - gy);
          if (d < best) {
            best = d;
            bestT = s.t;
          }
        }
        errs.push(g.t - bestT);
      }
      const measured = errs.sort((a, b) => a - b)[Math.floor(errs.length / 2)];
      expect(Math.abs(measured - lat)).toBeLessThan(0.2);
      for (let i = 1; i < run.gps.length; i++) expect(run.gps[i].t).toBeGreaterThan(run.gps[i - 1].t);
      // hAcc within a factor ~3 of the actual error on average
      const ratio: number[] = [];
      for (const g of run.gps) {
        const gx = (g.lon - run.originLon) * mLon;
        const gy = (g.lat - run.originLat) * mLat;
        const s = run.truth.find((q) => q.t >= g.t - lat) ?? run.truth[0];
        ratio.push(Math.hypot(s.x - gx, s.y - gy) / g.hAcc);
      }
      const mean = ratio.reduce((a, b) => a + b, 0) / ratio.length;
      expect(mean).toBeGreaterThan(0.2);
      expect(mean).toBeLessThan(1.5);
    }
  });

  it('course is invalid when parked, dropouts create gaps > 1.5 s, and course is not a pure delay of truth', () => {
    const run = simulateRun('harbor', { seed: 6, laps: 1, gpsDropouts: true });
    const parked = run.gps.filter((g) => g.t < 3);
    expect(parked.length).toBeGreaterThan(0);
    for (const g of parked) expect(g.course).toBeLessThan(0);
    let maxGap = 0;
    for (let i = 1; i < run.gps.length; i++) maxGap = Math.max(maxGap, run.gps[i].t - run.gps[i - 1].t);
    expect(maxGap).toBeGreaterThan(1.5);
    // course error vs truth course at the fix time: non-trivial (receiver filtering + lever arm + noise)
    const errs: number[] = [];
    for (const g of run.gps) {
      if (g.course < 0 || g.speed < 5) continue;
      const s = run.truth.find((q) => q.t >= g.t - run.gpsLatency);
      if (!s) continue;
      errs.push(radToDeg(wrapAngle(courseDegToMath(g.course) - s.course)));
    }
    expect(rms(errs)).toBeGreaterThan(1);
    expect(rms(errs)).toBeLessThan(8);
  });
});

describe('determinism', () => {
  it('is byte-identical for a seed and differs across seeds', () => {
    const a = simulateRun('touge', { seed: 9 });
    const b = simulateRun('touge', { seed: 9 });
    const c = simulateRun('touge', { seed: 10 });
    expect(a.motion.length).toBe(b.motion.length);
    expect(a.motion[500].rotationRate.z).toBe(b.motion[500].rotationRate.z);
    expect(a.gps[5].lat).toBe(b.gps[5].lat);
    expect(a.motion[500].rotationRate.z).not.toBe(c.motion[500].rotationRate.z);
  });
});
