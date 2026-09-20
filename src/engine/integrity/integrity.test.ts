import { describe, expect, it } from 'vitest';
import { G, type GpsSample, type MotionSample, type SlipState, type TruthSample, type VehicleMotionSample } from '../types';
import { simulateRun, type MountPreset, type SimulatedRun } from '../../sim/index';
import { apply, mul, rotX, rotY, rotZ, transpose, type Mat3 } from '../../sim/mat3';
import { IntegrityMonitor, UNKNOWN_HACC, type IntegrityFlag, type IntegrityState } from './index';

// ------------------------------------------------------------------------------------------
// helpers

/** Rotate a raw phone-frame sample into the vehicle frame with the TRUE mount (v_vehicle = R·v_phone). */
function toVehicle(raw: MotionSample, R: Mat3): VehicleMotionSample {
  const a = apply(R, raw.accel);
  const w = apply(R, raw.rotationRate);
  return { t: raw.t, ax: a.x, ay: a.y, az: a.z, yawRate: w.z, rollRate: w.x, pitchRate: w.y, calibrationQuality: 1 };
}

function truthState(tr: TruthSample): SlipState {
  return {
    t: tr.t,
    beta: tr.beta,
    betaSigma: 0.02,
    heading: tr.heading,
    course: tr.course,
    speed: tr.speed,
    yawRate: tr.yawRate,
    ay: tr.ay,
    ax: tr.ax,
    x: tr.x,
    y: tr.y,
    valid: tr.speed > 2,
  };
}

interface Trace {
  t: number;
  state: IntegrityState;
  truth: TruthSample;
  gravityRateRms: number;
  offYawRms: number;
  azBandRms: number;
}

/** Feed a simulated run through a fresh monitor, interleaving GPS fixes by receive time. */
function drive(run: SimulatedRun, monitor = new IntegrityMonitor()): Trace[] {
  const out: Trace[] = [];
  let gi = 0;
  for (let i = 0; i < run.motion.length; i++) {
    const m = run.motion[i];
    while (gi < run.gps.length && run.gps[gi].t <= m.t) monitor.pushGps(run.gps[gi++]);
    monitor.pushMotion(m, toVehicle(m, run.mount));
    monitor.pushState(truthState(run.truth[i]));
    const mt = monitor.metrics;
    out.push({ t: m.t, state: monitor.state, truth: run.truth[i], gravityRateRms: mt.gravityRateRms, offYawRms: mt.offYawRms, azBandRms: mt.azBandRms });
  }
  return out;
}

function frac<T>(xs: T[], pred: (x: T) => boolean): number {
  return xs.length ? xs.filter(pred).length / xs.length : 0;
}

function p95(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(0.95 * s.length))] : 0;
}

function assertWellFormed(s: IntegrityState): void {
  expect(['rigid', 'suspect', 'loose']).toContain(s.mount);
  expect(['ok', 'implausible']).toContain(s.physics);
  expect(['good', 'poor', 'none']).toContain(s.gps);
  expect(Number.isFinite(s.looseScore)).toBe(true);
  expect(s.looseScore).toBeGreaterThanOrEqual(0);
  expect(s.looseScore).toBeLessThanOrEqual(1);
  expect(Number.isFinite(s.gpsAgeS)).toBe(true);
  expect(Number.isFinite(s.hAcc)).toBe(true);
  expect(typeof s.driftPlausible).toBe('boolean');
  expect(Array.isArray(s.flags)).toBe(true);
  expect(typeof s.message).toBe('string');
  expect(s.message.length).toBeGreaterThan(0);
}

// metrics table, printed once at the end
const rows: string[] = [];
function record(name: string, trace: Trace[]) {
  const after3 = trace.filter((x) => x.t >= 3);
  const firstLoose = trace.find((x) => x.state.mount === 'loose');
  const drifting = trace.filter((x) => x.truth.drifting && x.truth.speed > 5 && Math.abs(x.truth.beta) > 0.14);
  const pc = (v: number) => (100 * v).toFixed(1).padStart(5) + '%';
  rows.push(
    [
      name.padEnd(28),
      `rigid ${pc(frac(after3, (x) => x.state.mount === 'rigid'))}`,
      `suspect ${pc(frac(after3, (x) => x.state.mount === 'suspect'))}`,
      `loose ${pc(frac(after3, (x) => x.state.mount === 'loose'))}`,
      `1st loose ${firstLoose ? firstLoose.t.toFixed(1).padStart(5) + 's' : '   -  '}`,
      `gRate p95 ${p95(after3.map((x) => x.gravityRateRms)).toFixed(3)}`,
      `offYaw p95 ${p95(after3.map((x) => x.offYawRms)).toFixed(3)}`,
      `az p95 ${p95(after3.map((x) => x.azBandRms)).toFixed(2)}`,
      `score max ${Math.max(...after3.map((x) => x.state.looseScore)).toFixed(2)}`,
      `physics ok ${pc(frac(trace, (x) => x.state.physics === 'ok'))}`,
      `gps good ${pc(frac(after3, (x) => x.state.gps === 'good'))}`,
      `drift plausible ${pc(frac(drifting, (x) => x.state.driftPlausible))} (n=${drifting.length})`,
    ].join(' | '),
  );
}


// ------------------------------------------------------------------------------------------

describe('IntegrityMonitor — mount detection on simulated runs', () => {
  const mounts: MountPreset[] = ['portrait-vent', 'landscape-dash', 'flat-console', 'random'];

  it('(1) rigid mounts stay rigid for ≥95 % of samples after 3 s and are never called loose', () => {
    for (const mount of mounts) {
      for (const vibration of [1, 2]) {
        const run = simulateRun('harbor', { seed: 3, laps: 1, mount, vibration, looseness: 0 });
        const trace = drive(run);
        record(`harbor ${mount} vib${vibration}`, trace);
        const after3 = trace.filter((x) => x.t >= 3);
        expect(frac(after3, (x) => x.state.mount === 'rigid')).toBeGreaterThanOrEqual(0.95);
        expect(trace.some((x) => x.state.mount === 'loose')).toBe(false);
        expect(trace.some((x) => x.state.flags.includes('loose-mount') || x.state.flags.includes('handheld'))).toBe(false);
        // physics is plausible throughout and real slides are accepted
        expect(frac(trace, (x) => x.state.physics === 'ok')).toBe(1);
        const drifting = trace.filter((x) => x.truth.drifting && x.truth.speed > 5 && Math.abs(x.truth.beta) > 0.14);
        expect(drifting.length).toBeGreaterThan(500);
        expect(frac(drifting, (x) => x.state.driftPlausible)).toBeGreaterThanOrEqual(0.95);
        for (let i = 0; i < trace.length; i += 25) assertWellFormed(trace[i].state);
      }
    }
    // the touge (grade, off-camber banking) with the roughest road
    const run = simulateRun('touge', { seed: 5, mount: 'portrait-vent', vibration: 2, looseness: 0 });
    const trace = drive(run);
    record('touge portrait-vent vib2', trace);
    expect(frac(trace.filter((x) => x.t >= 3), (x) => x.state.mount === 'rigid')).toBeGreaterThanOrEqual(0.95);
    expect(trace.some((x) => x.state.mount === 'loose')).toBe(false);
  }, 15000);

  it('(2) a hand-held phone (looseness 1) is called loose within 4 s and for ≥80 % of the run', () => {
    for (const [track, mount] of [
      ['harbor', 'portrait-vent'],
      ['touge', 'random'],
    ] as const) {
      const run = simulateRun(track, { seed: 3, laps: 1, mount, looseness: 1 });
      const trace = drive(run);
      record(`${track} ${mount} looseness 1`, trace);
      const firstLoose = trace.find((x) => x.state.mount === 'loose');
      expect(firstLoose).toBeDefined();
      expect(firstLoose!.t).toBeLessThan(4);
      expect(frac(trace, (x) => x.state.mount === 'loose')).toBeGreaterThanOrEqual(0.8);
      expect(frac(trace, (x) => x.state.flags.includes('handheld'))).toBeGreaterThanOrEqual(0.8);
      // a loose phone never scores a drift
      expect(trace.filter((x) => x.t >= 4).some((x) => x.state.driftPlausible)).toBe(false);
    }
  });

  it('(2b) a half-loose phone (looseness 0.5) is at least suspect for most of the run', () => {
    const run = simulateRun('harbor', { seed: 3, laps: 1, mount: 'landscape-dash', looseness: 0.5 });
    const trace = drive(run);
    record('harbor landscape-dash looseness 0.5', trace);
    expect(frac(trace, (x) => x.state.mount !== 'rigid')).toBeGreaterThanOrEqual(0.8);
    expect(frac(trace.filter((x) => x.t >= 3), (x) => x.state.looseScore > 0.35)).toBeGreaterThanOrEqual(0.95);
  });

  it('(2c) a slightly loose phone (looseness 0.25) is flagged suspect but not loose', () => {
    const run = simulateRun('harbor', { seed: 3, laps: 1, mount: 'portrait-vent', looseness: 0.25 });
    const trace = drive(run);
    record('harbor portrait-vent looseness 0.25', trace);
    const after3 = trace.filter((x) => x.t >= 3);
    expect(frac(after3, (x) => x.state.mount === 'suspect')).toBeGreaterThanOrEqual(0.9);
    expect(trace.some((x) => x.state.mount === 'loose')).toBe(false);
  });

  it('a wrong calibration (15° off) or a different sample rate does not make a rigid mount look loose', () => {
    // mis-calibrated vehicle frame: rotate the true mount by 15° about a mixed axis
    const run = simulateRun('harbor', { seed: 2, laps: 1, aggression: 1, consistency: 0.2, vibration: 2, mount: 'random', looseness: 0 });
    const err = (15 * Math.PI) / 180;
    const wrong = mul(mul(rotX(err * 0.6), rotY(err * 0.8)), run.mount);
    const mon = new IntegrityMonitor();
    let gi = 0;
    let rigid = 0;
    let n = 0;
    let loose = false;
    for (let i = 0; i < run.motion.length; i++) {
      const m = run.motion[i];
      while (gi < run.gps.length && run.gps[gi].t <= m.t) mon.pushGps(run.gps[gi++]);
      mon.pushMotion(m, toVehicle(m, wrong));
      mon.pushState(truthState(run.truth[i]));
      if (m.t >= 3) {
        n++;
        if (mon.state.mount === 'rigid') rigid++;
      }
      if (mon.state.mount === 'loose') loose = true;
    }
    expect(rigid / n).toBeGreaterThanOrEqual(0.95);
    expect(loose).toBe(false);
    // 50 Hz motion rate: same verdicts
    const slow = drive(simulateRun('harbor', { seed: 3, laps: 1, rateHz: 50, looseness: 0 }));
    expect(frac(slow.filter((x) => x.t >= 3), (x) => x.state.mount === 'rigid')).toBeGreaterThanOrEqual(0.95);
    const slowLoose = drive(simulateRun('harbor', { seed: 3, laps: 1, rateHz: 50, looseness: 1 }));
    expect(slowLoose.find((x) => x.state.mount === 'loose')!.t).toBeLessThan(4);
    expect(frac(slowLoose, (x) => x.state.mount === 'loose')).toBeGreaterThanOrEqual(0.8);
  });

  it('mount label does not flicker: few transitions per run', () => {
    const run = simulateRun('harbor', { seed: 7, laps: 1, mount: 'random', vibration: 2, looseness: 0.5 });
    const trace = drive(run);
    let transitions = 0;
    for (let i = 1; i < trace.length; i++) if (trace[i].state.mount !== trace[i - 1].state.mount) transitions++;
    expect(transitions).toBeLessThanOrEqual(4);
  });
});

// ------------------------------------------------------------------------------------------

/** A parked car, phone waved about by hand: rotation ±20° at ~1 Hz on three axes, hand accelerations ~1–2 m/s². */
function shakenParkedStream(seconds: number, rate = 100): { motion: MotionSample[]; vehicle: VehicleMotionSample[]; states: SlipState[]; gps: GpsSample[] } {
  const motion: MotionSample[] = [];
  const vehicle: VehicleMotionSample[] = [];
  const states: SlipState[] = [];
  const gps: GpsSample[] = [];
  const dt = 1 / rate;
  const n = Math.round(seconds * rate);
  let heading = 0;
  for (let i = 0; i < n; i++) {
    const t = i * dt;
    const ax = 0.35 * Math.sin(2 * Math.PI * 1.0 * t);
    const ay = 0.25 * Math.sin(2 * Math.PI * 1.3 * t + 1);
    const az = 0.3 * Math.sin(2 * Math.PI * 0.7 * t + 2);
    const dax = 0.35 * 2 * Math.PI * 1.0 * Math.cos(2 * Math.PI * 1.0 * t);
    const day = 0.25 * 2 * Math.PI * 1.3 * Math.cos(2 * Math.PI * 1.3 * t + 1);
    const daz = 0.3 * 2 * Math.PI * 0.7 * Math.cos(2 * Math.PI * 0.7 * t + 2);
    // phone attitude R (phone → world); gravity in the phone frame is Rᵀ·(0,0,−G)
    const R = mul(rotZ(az), mul(rotY(ay), rotX(ax)));
    const gravity = apply(transpose(R), { x: 0, y: 0, z: -G });
    const accel = { x: 1.5 * Math.sin(2 * Math.PI * 1.1 * t), y: 1.2 * Math.sin(2 * Math.PI * 0.9 * t + 0.5), z: 2.0 * Math.sin(2 * Math.PI * 1.3 * t + 1) };
    const rotationRate = { x: dax, y: day, z: daz };
    motion.push({ t, accel, gravity, rotationRate });
    // the "calibrated" vehicle frame is the phone frame itself (phone lying flat, screen up)
    vehicle.push({ t, ax: accel.x, ay: accel.y, az: accel.z, yawRate: rotationRate.z, rollRate: rotationRate.x, pitchRate: rotationRate.y, calibrationQuality: 1 });
    // what a fooled estimator would say: heading integrates the yaw, course stays put → β grows
    heading += rotationRate.z * dt;
    states.push({ t, beta: -heading, betaSigma: 0.05, heading, course: 0, speed: 0, yawRate: rotationRate.z, ay: accel.y, ax: accel.x, x: 0, y: 0, valid: false });
    if (i % rate === 0) gps.push({ t: t + 0.5, lat: 35.62, lon: 139.77, speed: 0, course: -1, hAcc: 4 });
  }
  return { motion, vehicle, states, gps };
}

/** A phone lying flat and perfectly still, with an optional override applied to a time window. */
function quietStream(seconds: number, override: (t: number) => Partial<VehicleMotionSample> & { rawRate?: number }, rate = 100) {
  const motion: MotionSample[] = [];
  const vehicle: VehicleMotionSample[] = [];
  const dt = 1 / rate;
  for (let i = 0; i < seconds * rate; i++) {
    const t = i * dt;
    const o = override(t);
    const rawRate = o.rawRate ?? 0;
    motion.push({ t, accel: { x: 0, y: 0, z: 0 }, gravity: { x: 0, y: 0, z: -G }, rotationRate: { x: 0, y: 0, z: rawRate } });
    vehicle.push({ t, ax: 0, ay: 0, az: 0, yawRate: rawRate, rollRate: 0, pitchRate: 0, calibrationQuality: 1, ...o });
  }
  return { motion, vehicle };
}

describe('IntegrityMonitor — synthetic streams', () => {
  it('(3) a parked car with the phone waved about never counts as a drift', () => {
    const { motion, vehicle, states, gps } = shakenParkedStream(12);
    const mon = new IntegrityMonitor();
    let gi = 0;
    const seen: IntegrityState[] = [];
    for (let i = 0; i < motion.length; i++) {
      while (gi < gps.length && gps[gi].t <= motion[i].t) mon.pushGps(gps[gi++]);
      mon.pushMotion(motion[i], vehicle[i]);
      mon.pushState(states[i]);
      seen.push(mon.state);
    }
    for (let i = 0; i < seen.length; i++) {
      if (i % 10 === 0) assertWellFormed(seen[i]);
      expect(seen[i].driftPlausible).toBe(false);
    }
    const after3 = seen.filter((_, i) => motion[i].t >= 3);
    expect(after3.every((s) => s.flags.includes('handheld') || s.flags.includes('loose-mount'))).toBe(true);
    expect(frac(after3, (s) => s.mount === 'loose')).toBeGreaterThanOrEqual(0.95);
    expect(frac(after3, (s) => s.flags.includes('handheld'))).toBeGreaterThanOrEqual(0.9);
    // while the fooled estimator claims a slide (|β| > 8°) the speed gate names the reason
    const claimed = seen.filter((_, i) => Math.abs(states[i].beta) > 0.14 && motion[i].t >= 3);
    expect(claimed.length).toBeGreaterThan(100);
    expect(claimed.every((s) => s.flags.includes('too-slow'))).toBe(true);
    expect(after3.some((s) => /hand-held/i.test(s.message))).toBe(true);
  });

  it('(3b) a parked phone that is perfectly still is rigid, but still no drift', () => {
    const { motion, vehicle } = quietStream(6, () => ({}));
    const mon = new IntegrityMonitor();
    for (let i = 0; i < motion.length; i++) {
      mon.pushMotion(motion[i], vehicle[i]);
      mon.pushState({ t: motion[i].t, beta: 0, betaSigma: 0.02, heading: 0, course: 0, speed: 0, yawRate: 0, ay: 0, ax: 0, x: 0, y: 0, valid: false });
    }
    expect(mon.state.mount).toBe('rigid');
    expect(mon.state.looseScore).toBeLessThan(0.05);
    expect(mon.state.driftPlausible).toBe(false);
    expect(mon.state.flags).not.toContain('too-slow'); // no slide claimed → no nagging
  });

  it('(4) an implausible yaw burst (8 rad/s for 300 ms) trips physics and then recovers', () => {
    const { motion, vehicle } = quietStream(5, (t) => (t >= 2 && t < 2.3 ? { rawRate: 8 } : {}));
    const mon = new IntegrityMonitor();
    const physicsAt: Array<{ t: number; physics: string; flags: IntegrityFlag[]; message: string }> = [];
    for (let i = 0; i < motion.length; i++) {
      mon.pushMotion(motion[i], vehicle[i]);
      const s = mon.state;
      physicsAt.push({ t: motion[i].t, physics: s.physics, flags: s.flags, message: s.message });
    }
    const at = (t: number) => physicsAt.find((p) => p.t >= t - 1e-9)!;
    expect(at(1.9).physics).toBe('ok');
    expect(at(2.05).physics).toBe('ok'); // not yet sustained 100 ms
    expect(at(2.15).physics).toBe('implausible');
    expect(at(2.15).flags).toContain('yaw-rate-limit');
    expect(at(2.15).message).toMatch(/spinning/i);
    expect(at(2.29).physics).toBe('implausible');
    expect(at(2.6).physics).toBe('implausible'); // held for 0.5 s after the excess stops
    expect(at(3.0).physics).toBe('ok');
    expect(at(3.0).flags).not.toContain('yaw-rate-limit');
    expect(at(4.9).physics).toBe('ok');
  });

  it('(4b) a 50 ms blip is ignored; sustained lateral or longitudinal g over the limit is not', () => {
    const blip = quietStream(3, (t) => (t >= 1 && t < 1.05 ? { rawRate: 8 } : {}));
    const mon = new IntegrityMonitor();
    for (let i = 0; i < blip.motion.length; i++) {
      mon.pushMotion(blip.motion[i], blip.vehicle[i]);
      expect(mon.state.physics).toBe('ok');
    }
    mon.reset();
    const lateral = quietStream(2, (t) => (t >= 1 && t < 1.3 ? { ay: 2.5 * G } : {}));
    let sawLateral = false;
    for (let i = 0; i < lateral.motion.length; i++) {
      mon.pushMotion(lateral.motion[i], lateral.vehicle[i]);
      if (mon.state.flags.includes('lateral-g-limit')) sawLateral = true;
    }
    expect(sawLateral).toBe(true);
    mon.reset();
    const longitudinal = quietStream(2, (t) => (t >= 1 && t < 1.3 ? { ax: -1.8 * G } : {}));
    let sawLong = false;
    for (let i = 0; i < longitudinal.motion.length; i++) {
      mon.pushMotion(longitudinal.motion[i], longitudinal.vehicle[i]);
      if (mon.state.physics === 'implausible') sawLong = true;
    }
    expect(sawLong).toBe(true);
    expect(mon.state.physics).toBe('ok'); // recovered by t = 2 s
  });

  it('a slide claimed on a straight (no lateral g) is inconsistent; a real corner is not', () => {
    const { motion, vehicle } = quietStream(6, () => ({}));
    const mon = new IntegrityMonitor();
    const seen: IntegrityState[] = [];
    for (let i = 0; i < motion.length; i++) {
      const t = motion[i].t;
      if (i % 100 === 0) mon.pushGps({ t, lat: 0, lon: 0, speed: 15, course: 90, hAcc: 4 });
      mon.pushMotion(motion[i], vehicle[i]);
      // 0–3 s: the estimator claims β = 20° at 15 m/s with zero yaw and zero lateral g (a phantom slide)
      // 3–6 s: a genuine right-hand drift: course rate −0.4 rad/s, a_n = v·χ̇ = −6 m/s², β = +20°
      const phantom = t < 3;
      const beta = 0.35;
      const r = phantom ? 0 : -0.4;
      const an = phantom ? 0 : 15 * r;
      mon.pushState({ t, beta, betaSigma: 0.02, heading: 0, course: beta, speed: 15, yawRate: r, ay: an * Math.cos(beta), ax: -an * Math.sin(beta), x: 0, y: 0, valid: true });
      seen.push(mon.state);
    }
    const at = (t: number) => seen[Math.round(t * 100)];
    expect(at(0.3).driftPlausible).toBe(true); // violation budget not yet spent
    expect(at(1.5).driftPlausible).toBe(false);
    expect(at(1.5).flags).toContain('inconsistent-slip');
    expect(at(1.5).message).toMatch(/g-forces/i);
    expect(at(2.9).driftPlausible).toBe(false);
    expect(at(4.0).driftPlausible).toBe(true);
    expect(at(4.0).flags).not.toContain('inconsistent-slip');
    expect(at(5.9).driftPlausible).toBe(true);
  });

  it('a slide whose lateral g points the wrong way is inconsistent', () => {
    const { motion, vehicle } = quietStream(3, () => ({}));
    const mon = new IntegrityMonitor();
    for (let i = 0; i < motion.length; i++) {
      const t = motion[i].t;
      mon.pushMotion(motion[i], vehicle[i]);
      // course turning right (r = −0.4) but the accelerometer says the car is pushed LEFT (+6 m/s²)
      mon.pushState({ t, beta: 0.35, betaSigma: 0.02, heading: 0, course: 0, speed: 15, yawRate: -0.4, ay: 6, ax: 0, x: 0, y: 0, valid: true });
    }
    expect(mon.state.driftPlausible).toBe(false);
    expect(mon.state.flags).toContain('inconsistent-slip');
  });

  it('a fresh GPS fix reporting a standstill vetoes a claimed slide', () => {
    const { motion, vehicle } = quietStream(3, () => ({}));
    const mon = new IntegrityMonitor();
    mon.pushGps({ t: 0, lat: 0, lon: 0, speed: 0, course: -1, hAcc: 4 });
    for (let i = 0; i < motion.length; i++) {
      const t = motion[i].t;
      if (i % 100 === 50) mon.pushGps({ t, lat: 0, lon: 0, speed: 0.2, course: -1, hAcc: 4 });
      mon.pushMotion(motion[i], vehicle[i]);
      mon.pushState({ t, beta: 0.35, betaSigma: 0.02, heading: 0, course: 0, speed: 12, yawRate: -0.4, ay: -5, ax: 0, x: 0, y: 0, valid: true });
    }
    expect(mon.state.driftPlausible).toBe(false);
    expect(mon.state.flags).toContain('too-slow');
  });
});

// ------------------------------------------------------------------------------------------

describe('IntegrityMonitor — GPS', () => {
  it('(5) dropouts: good → none → good with correct ages', () => {
    const run = simulateRun('harbor', { seed: 3, laps: 1, gpsDropouts: true });
    const mon = new IntegrityMonitor();
    const labels: Array<{ t: number; gps: string; age: number; flags: IntegrityFlag[] }> = [];
    let gi = 0;
    let lastFixT = NaN;
    const firstT = run.motion[0].t;
    for (let i = 0; i < run.motion.length; i++) {
      const m = run.motion[i];
      while (gi < run.gps.length && run.gps[gi].t <= m.t) {
        mon.pushGps(run.gps[gi]);
        lastFixT = run.gps[gi].t;
        gi++;
      }
      mon.pushMotion(m, toVehicle(m, run.mount));
      mon.pushState(truthState(run.truth[i]));
      const s = mon.state;
      // Age is exact: time since the newest fix was received (or since the first motion sample),
      // measured against the newest timestamp actually pushed. Sample timestamps carry OS jitter
      // (σ 2 ms) and the streams are not on a shared grid — the motion sample is stamped by the
      // sensor and the state by the estimator — so the clock is `max` over the streams, never
      // i × dt. Asserting against the real timestamps keeps this exact to the microsecond.
      const nowT = Math.max(m.t, run.truth[i].t);
      const expectedAge = Number.isFinite(lastFixT) ? Math.max(0, nowT - lastFixT) : nowT - firstT;
      expect(Math.abs(s.gpsAgeS - expectedAge)).toBeLessThan(1e-9);
      if (Number.isFinite(lastFixT)) {
        expect(s.gps).toBe(expectedAge > 3 ? 'none' : 'good');
        expect(s.hAcc).toBeLessThan(15);
      } else {
        expect(s.gps).toBe('none');
        expect(s.hAcc).toBe(UNKNOWN_HACC);
      }
      expect(s.flags.includes('gps-lost')).toBe(s.gps === 'none');
      labels.push({ t: m.t, gps: s.gps, age: s.gpsAgeS, flags: s.flags });
    }
    // sequence of distinct labels contains good → none → good (at least one dropout > 3 s)
    const seq: string[] = [];
    for (const l of labels) if (seq[seq.length - 1] !== l.gps) seq.push(l.gps);
    expect(seq[0]).toBe('none'); // before the first fix
    const s = seq.join(',');
    expect(s).toContain('good,none,good');
    const longest = Math.max(...labels.map((l) => l.age));
    expect(longest).toBeGreaterThan(3.5);
    const maxGap = Math.max(...run.gps.slice(1).map((g, i) => g.t - run.gps[i].t));
    expect(Math.abs(longest - maxGap)).toBeLessThan(0.02);
    // while GPS is fine, the sensors-look-good message is shown; while lost, the driver is told
    expect(labels.some((l) => l.gps === 'none' && l.t > 5)).toBe(true);
    const lost = labels.find((l) => l.gps === 'none' && l.t > 5)!;
    expect(lost.age).toBeGreaterThan(3);
    record('harbor gpsDropouts seed3', drive(run));
  });

  it('poor accuracy is flagged with hysteresis', () => {
    const mon = new IntegrityMonitor();
    const m: MotionSample = { t: 0, accel: { x: 0, y: 0, z: 0 }, gravity: { x: 0, y: 0, z: -G }, rotationRate: { x: 0, y: 0, z: 0 } };
    const v: VehicleMotionSample = { t: 0, ax: 0, ay: 0, az: 0, yawRate: 0, rollRate: 0, pitchRate: 0, calibrationQuality: 1 };
    mon.pushMotion(m, v);
    expect(mon.state.gps).toBe('none');
    expect(mon.state.message).toMatch(/GPS/);
    mon.pushGps({ t: 0.1, lat: 0, lon: 0, speed: 0, course: -1, hAcc: 30 });
    expect(mon.state.gps).toBe('poor');
    expect(mon.state.flags).toContain('gps-poor');
    expect(mon.state.hAcc).toBe(30);
    expect(mon.state.message).toMatch(/30 m/);
    mon.pushGps({ t: 0.2, lat: 0, lon: 0, speed: 0, course: -1, hAcc: 13 });
    expect(mon.state.gps).toBe('poor'); // still above the 12 m exit threshold
    mon.pushGps({ t: 0.3, lat: 0, lon: 0, speed: 0, course: -1, hAcc: 10 });
    expect(mon.state.gps).toBe('good');
    expect(mon.state.flags).not.toContain('gps-poor');
    // a fix whose accuracy is unknown counts as poor, never NaN
    mon.pushGps({ t: 0.4, lat: 0, lon: 0, speed: NaN, course: NaN, hAcc: NaN });
    expect(mon.state.gps).toBe('poor');
    expect(Number.isFinite(mon.state.hAcc)).toBe(true);
    // ageing out
    mon.pushMotion({ ...m, t: 4 }, { ...v, t: 4 });
    expect(mon.state.gps).toBe('none');
    expect(mon.state.gpsAgeS).toBeCloseTo(3.6, 6);
    expect(mon.state.message).toMatch(/lost/i);
  });
});

// ------------------------------------------------------------------------------------------

describe('IntegrityMonitor — messages, robustness, reset', () => {
  it('(6) messages are non-empty and change with state', () => {
    const messages = new Set<string>();
    const rigid = drive(simulateRun('harbor', { seed: 3, laps: 1 }));
    const loose = drive(simulateRun('harbor', { seed: 3, laps: 1, looseness: 1 }));
    const half = drive(simulateRun('harbor', { seed: 3, laps: 1, looseness: 0.25 }));
    const dropouts = drive(simulateRun('harbor', { seed: 3, laps: 1, gpsDropouts: true }));
    for (const trace of [rigid, loose, half, dropouts]) for (const x of trace) messages.add(x.state.message);
    const { motion, vehicle } = quietStream(3, (t) => (t >= 1 && t < 1.5 ? { rawRate: 9 } : {}));
    const mon = new IntegrityMonitor();
    for (let i = 0; i < motion.length; i++) {
      mon.pushMotion(motion[i], vehicle[i]);
      messages.add(mon.state.message);
    }
    for (const msg of messages) expect(msg.trim().length).toBeGreaterThan(10);
    expect(messages.size).toBeGreaterThanOrEqual(6);
    // the steady-state message of a good run differs from that of a hand-held phone
    const good = rigid[Math.floor(rigid.length / 2)].state.message;
    const held = loose[Math.floor(loose.length / 2)].state.message;
    expect(good).not.toBe(held);
    expect(good).toMatch(/good/i);
    expect(held).toMatch(/hand-held|mount/i);
    const lostFrame = dropouts.find((x) => x.state.gps === 'none' && x.t > 5)!;
    expect(lostFrame.state.message).toMatch(/GPS/);
  });

  it('never produces NaN, even from garbage input', () => {
    const mon = new IntegrityMonitor();
    const bad: MotionSample = { t: 0, accel: { x: NaN, y: 1, z: -Infinity }, gravity: { x: NaN, y: NaN, z: NaN }, rotationRate: { x: NaN, y: 0, z: Infinity } };
    const badV: VehicleMotionSample = { t: 0, ax: NaN, ay: Infinity, az: NaN, yawRate: NaN, rollRate: NaN, pitchRate: NaN, calibrationQuality: NaN };
    for (let i = 0; i < 50; i++) {
      mon.pushMotion({ ...bad, t: i * 0.01 }, { ...badV, t: i * 0.01 });
      mon.pushState({ t: i * 0.01, beta: NaN, betaSigma: NaN, heading: NaN, course: NaN, speed: NaN, yawRate: NaN, ay: NaN, ax: NaN, x: NaN, y: NaN, valid: false });
      mon.pushGps({ t: NaN, lat: NaN, lon: NaN, speed: NaN, course: NaN, hAcc: NaN });
      assertWellFormed(mon.state);
      for (const v of Object.values(mon.metrics)) expect(Number.isFinite(v)).toBe(true);
    }
    // out-of-order / duplicate timestamps are tolerated
    mon.pushMotion({ ...bad, t: 0.2 }, { ...badV, t: 0.2 });
    mon.pushMotion({ ...bad, t: 0.2 }, { ...badV, t: 0.2 });
    assertWellFormed(mon.state);
  });

  it('reset() returns to the initial state and the monitor is reusable', () => {
    const mon = new IntegrityMonitor();
    const initial = mon.state;
    assertWellFormed(initial);
    const run = simulateRun('harbor', { seed: 3, laps: 1, looseness: 1 });
    drive(run, mon);
    expect(mon.state.mount).toBe('loose');
    mon.reset();
    expect(mon.state).toEqual(initial);
    const again = drive(simulateRun('harbor', { seed: 3, laps: 1, looseness: 0 }), mon);
    expect(frac(again.filter((x) => x.t >= 3), (x) => x.state.mount === 'rigid')).toBeGreaterThanOrEqual(0.95);
  });

  it('options can be overridden and the state getter returns an independent snapshot', () => {
    const mon = new IntegrityMonitor({ gpsMaxAgeS: 1, minDriftSpeed: 8 });
    expect(mon.opts.gpsMaxAgeS).toBe(1);
    expect(mon.opts.minDriftSpeed).toBe(8);
    expect(mon.opts.windowS).toBe(2);
    const a = mon.state;
    expect(a.flags).toEqual(['gps-lost']); // no fix yet
    a.flags.push('too-slow');
    expect(mon.state.flags).toEqual(['gps-lost']); // the mutation did not leak into the monitor
    expect(mon.state).not.toBe(a);
  });

  it('prints the metrics table', () => {
    expect(rows.length).toBeGreaterThanOrEqual(14);
    const table = '\nIntegrity metrics (after first 3 s unless noted; RMS cues in rad/s, m/s²)\n' + rows.join('\n') + '\n';
    // vitest 5 defaults to `silent: 'passed-only'`, which hides console.log from passing tests;
    // a direct stdout write is not captured, so the table is visible under the default config.
    process.stdout.write(table);
  });
});
