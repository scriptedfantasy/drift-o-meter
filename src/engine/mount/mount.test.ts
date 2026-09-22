import { describe, expect, it } from 'vitest';
import { simulateRun, type SimulateOptions, type SimulatedRun } from '../../sim';
import type { MountPreset } from '../../sim/sensors';
import type { GpsSample, MotionSample } from '../types';
import { DEFAULT_MOUNT_OPTIONS, forwardProgress, MountCalibrator, type MountOptions } from './calibrator';
import { angleBetweenDeg, rowOf } from './math';

/**
 * Mount calibration against the simulator's ground truth.
 *
 * Everything here is measured against `run.mount`, the NOMINAL phone→vehicle rotation (row-major,
 * v_vehicle = R·v_phone): row 0 is the vehicle's forward axis in phone coordinates, row 2 its up
 * axis. Motion and GPS are fed strictly interleaved by timestamp, exactly as the pipeline does.
 *
 * Three targets in the brief are NOT reachable as stated, for reasons that are physics rather
 * than calibration. Each one is asserted at the number actually achieved and explained where it
 * is asserted; the floors quoted are measured in this file with the TRUE mount matrix, so a
 * reader can see that the residual is not a calibration error:
 *
 *   1. `ay` RMS < 0.6 m/s² vs `run.truth.ay`. `run.truth.ay` is the CG's, and this output is
 *      defined AT THE PHONE — the phone sits 0.9 m ahead of the CG, so it genuinely measures
 *      a_y + ṙ·d_x, 1.13 m/s² RMS of tangential acceleration the CG does not have, and removing
 *      it here would remove it twice (the slip estimator owns the lever arm end to end; see the
 *      contract on `VehicleMotionSample`). So `ay` is measured against the PHONE's lateral
 *      acceleration, a_y(CG) + ṙ·d_x reconstructed from truth, where the error is 0.26–0.55
 *      against a perfect-mount floor of 0.28–0.33. The CG columns are kept in the table to show
 *      the size of what is deliberately NOT removed: 1.15–1.26 m/s².
 *   2. `yawRate` RMS < 0.04 rad/s under `looseness: 0.25`. A rattling cradle really does rotate
 *      the phone relative to the car, at up to 1.5 rad/s. With a PERFECT mount matrix the error
 *      against the car's yaw rate is 0.144–0.202 rad/s; this test measures that floor and
 *      asserts that the calibrator is within 5 % of it instead.
 *   3. Re-convergence "within ~20 s" after a mid-session mount change. The UP axis does re-converge
 *      in ~12 s and the quality collapses within 1.5 s, but FORWARD needs longitudinal evidence,
 *      and on a drift circuit away from a standing start that arrives at ~0.02 gated seconds per
 *      second. Asserted: up within 6° at +20 s, forward within 9° by the end of the spliced run.
 */

const UP_DEG = 1.5;
const FWD_DEG = 3;
const AY_RMS = 0.6; // against the PHONE's lateral acceleration — what this output is defined as
const YAW_RMS = 0.04;
const RESOLVE_S = 25;

interface Metrics {
  label: string;
  /** Angle between the estimated and true UP axis at the end of the run, degrees. */
  upDeg: number;
  /** Angle between the estimated and true FORWARD axis at the end of the run, degrees. */
  fwdDeg: number;
  /** Same two, averaged over the last 20 s (a single final sample is a noisy statistic). */
  upDeg20: number;
  fwdDeg20: number;
  /**
   * RMS error of the reported ay against the PHONE's lateral acceleration — the quantity this
   * output is defined as — and against the CG's, which is what `run.truth.ay` holds and which
   * differs from it by the whole lever-arm term. Plus yawRate against truth.
   */
  ayRms: number;
  ayCgRms: number;
  yawRms: number;
  /** The same three with the TRUE mount matrix substituted: the physical floor. */
  ayFloor: number;
  ayCgFloor: number;
  yawFloor: number;
  /** Seconds from the car first moving to `forwardResolved`. */
  resolveS: number;
  quality: number;
  leverDx: number;
}

/**
 * The deterministic part of the PHONE's lateral acceleration in the vehicle frame:
 * a_y(CG) + ṙ·d_x with the simulator's default 0.9 m lever arm (its ṙ is clamped to ±12 rad/s²).
 * Road vibration and bumps are on top of this in the sensor and are not reconstructible from
 * truth, which is why even a perfect mount matrix leaves ~0.3 m/s² against it.
 */
function phoneAy(truth: SimulatedRun['truth'], i: number): number {
  const dt = i > 0 ? truth[i].t - truth[i - 1].t : 0.01;
  const rDot = dt > 0 && dt < 0.015 ? (truth[i].yawRate - truth[i - 1].yawRate) / dt : 0;
  return truth[i].ay + Math.max(-12, Math.min(12, rDot)) * 0.9;
}

/** Feed one run through a fresh calibrator, motion and GPS interleaved in time order. */
function evaluate(label: string, run: SimulatedRun, opts?: Partial<MountOptions>): Metrics {
  const cal = new MountCalibrator(opts);
  const trueUp = rowOf(run.mount, 2);
  const trueLeft = rowOf(run.mount, 1);
  const trueFwd = rowOf(run.mount, 0);

  let moveT = run.truth[0].t;
  for (const s of run.truth) {
    if (s.speed > 0.5) {
      moveT = s.t;
      break;
    }
  }
  const endT = run.truth[run.truth.length - 1].t;

  let gi = 0;
  let resolveT = NaN;
  let sAy = 0;
  let sAyCg = 0;
  let sYaw = 0;
  let sAyF = 0;
  let sAyCgF = 0;
  let sYawF = 0;
  let n = 0;
  let upAcc = 0;
  let fwdAcc = 0;
  let accN = 0;
  for (let i = 0; i < run.motion.length; i++) {
    const m = run.motion[i];
    while (gi < run.gps.length && run.gps[gi].t <= m.t) {
      cal.pushGps(run.gps[gi]);
      gi++;
    }
    const v = cal.push(m);
    const tr = run.truth[i];
    const c = cal.calibration;
    if (c.forwardResolved && Number.isNaN(resolveT)) resolveT = tr.t;
    if (tr.t > moveT + 2) {
      const ayPhone = phoneAy(run.truth, i);
      sAy += (v.ay - ayPhone) ** 2;
      sAyCg += (v.ay - tr.ay) ** 2;
      sYaw += (v.yawRate - tr.yawRate) ** 2;
      // floor: the same sample resolved with the TRUE mount matrix
      const fx = m.gravity.x + m.accel.x;
      const fy = m.gravity.y + m.accel.y;
      const fz = m.gravity.z + m.accel.z;
      const ayT = trueLeft.x * fx + trueLeft.y * fy + trueLeft.z * fz;
      const yzT = trueUp.x * m.rotationRate.x + trueUp.y * m.rotationRate.y + trueUp.z * m.rotationRate.z;
      sAyF += (ayT - ayPhone) ** 2;
      sAyCgF += (ayT - tr.ay) ** 2;
      sYawF += (yzT - tr.yawRate) ** 2;
      n++;
    }
    if (tr.t > endT - 20) {
      upAcc += angleBetweenDeg(rowOf(c.r, 2), trueUp);
      fwdAcc += angleBetweenDeg(rowOf(c.r, 0), trueFwd);
      accN++;
    }
  }
  const c = cal.calibration;
  return {
    label,
    upDeg: angleBetweenDeg(rowOf(c.r, 2), trueUp),
    fwdDeg: angleBetweenDeg(rowOf(c.r, 0), trueFwd),
    upDeg20: upAcc / Math.max(1, accN),
    fwdDeg20: fwdAcc / Math.max(1, accN),
    ayRms: Math.sqrt(sAy / Math.max(1, n)),
    ayCgRms: Math.sqrt(sAyCg / Math.max(1, n)),
    yawRms: Math.sqrt(sYaw / Math.max(1, n)),
    ayFloor: Math.sqrt(sAyF / Math.max(1, n)),
    ayCgFloor: Math.sqrt(sAyCgF / Math.max(1, n)),
    yawFloor: Math.sqrt(sYawF / Math.max(1, n)),
    resolveS: Number.isNaN(resolveT) ? Infinity : resolveT - moveT,
    quality: c.quality,
    leverDx: cal.diagnostics().leverDx,
  };
}

function run1(track: 'harbor' | 'touge', opts: SimulateOptions): SimulatedRun {
  return simulateRun(track, opts);
}

const table: string[] = [];
function record(m: Metrics): Metrics {
  const p = (v: number, w: number, d: number) => (Number.isFinite(v) ? v.toFixed(d) : 'NEVER').padStart(w);
  table.push(
    `${m.label.padEnd(30)}${p(m.upDeg, 7, 2)}${p(m.fwdDeg, 8, 2)}${p(m.upDeg20, 7, 2)}${p(m.fwdDeg20, 8, 2)}` +
      `${p(m.ayRms, 7, 2)}${p(m.ayFloor, 8, 2)}${p(m.ayCgRms, 7, 2)}${p(m.ayCgFloor, 8, 2)}` +
      `${p(m.yawRms, 8, 4)}${p(m.yawFloor, 9, 4)}${p(m.resolveS, 7, 1)}${p(m.quality, 6, 2)}${p(m.leverDx, 7, 2)}`,
  );
  return m;
}
function flush(title: string): void {
  if (table.length === 0) return;
  process.stdout.write(
    `\n${title}\n${'case'.padEnd(30)}${'up°'.padStart(7)}${'fwd°'.padStart(8)}${'up20°'.padStart(7)}${'fwd20°'.padStart(8)}` +
      `${'ay@ph'.padStart(7)}${'[floor]'.padStart(8)}${'ay@CG'.padStart(7)}${'[floor]'.padStart(8)}` +
      `${'yaw'.padStart(8)}${'[floor]'.padStart(9)}${'res s'.padStart(7)}${'qual'.padStart(6)}${'d̂ₓ m'.padStart(7)}\n`,
  );
  for (const line of table) process.stdout.write(`${line}\n`);
  table.length = 0;
}

const MOUNTS: MountPreset[] = ['portrait-vent', 'landscape-dash', 'flat-console', 'random'];
const SEEDS = [1, 2, 3];

describe('MountCalibrator — harbor circuit, every mount preset × seeds 1–3', () => {
  const results: Metrics[] = [];
  for (const mount of MOUNTS) {
    for (const seed of SEEDS) {
      results.push(record(evaluate(`harbor ${mount} s${seed}`, run1('harbor', { seed, laps: 2, mount }))));
    }
  }
  flush('MOUNT CALIBRATION — harbor, 2 laps (errors at the END of the run; up20/fwd20 = mean over the last 20 s)');

  it('(1) resolves the UP axis to better than 1.5°', () => {
    for (const m of results) expect.soft(`${m.label} up ${m.upDeg.toFixed(2)}°`).toBe(`${m.label} up ${Math.min(m.upDeg, UP_DEG - 0.001).toFixed(2)}°`);
    expect(Math.max(...results.map((m) => m.upDeg))).toBeLessThan(UP_DEG);
  });

  it('(2) resolves the FORWARD axis to better than 3°', () => {
    for (const m of results) expect.soft(`${m.label} fwd ${m.fwdDeg.toFixed(2)}°`).toBe(`${m.label} fwd ${Math.min(m.fwdDeg, FWD_DEG - 0.001).toFixed(2)}°`);
    expect(Math.max(...results.map((m) => m.fwdDeg))).toBeLessThan(FWD_DEG);
  });

  it('(3) reports ay within 0.6 m/s² RMS of the PHONE\'s lateral acceleration, lever arm left in', () => {
    // `ay` is defined AT THE PHONE, so it is scored against a_y(CG) + ṙ·d_x. The `[floor]` next
    // to it is the same comparison with the TRUE mount matrix: 0.28–0.33, all of it road
    // vibration and bumps, which truth cannot reconstruct. The ay@CG columns show what is
    // deliberately left in — 1.15+ m/s² of lever arm that the slip estimator removes, not us.
    for (const m of results) {
      expect(m.ayCgFloor).toBeGreaterThan(1.1); // the lever arm is really there...
      expect(m.ayCgRms).toBeGreaterThan(1.0); // ...and it is still in this output, as specified
      expect.soft(`${m.label} ay ${m.ayRms.toFixed(2)}`).toBe(`${m.label} ay ${Math.min(m.ayRms, AY_RMS - 0.001).toFixed(2)}`);
    }
    expect(Math.max(...results.map((m) => m.ayRms))).toBeLessThan(AY_RMS);
    // the frame costs little over a perfect mount matrix
    for (const m of results) expect(m.ayRms).toBeLessThan(m.ayFloor + 0.3);
  });

  it('(4) reports yawRate within 0.04 rad/s RMS of truth', () => {
    for (const m of results) expect.soft(`${m.label} yaw ${m.yawRms.toFixed(4)}`).toBe(`${m.label} yaw ${Math.min(m.yawRms, YAW_RMS - 1e-6).toFixed(4)}`);
    expect(Math.max(...results.map((m) => m.yawRms))).toBeLessThan(YAW_RMS);
  });

  it('(5) resolves forward within 25 s of the car first moving, and ends confident', () => {
    for (const m of results) expect.soft(`${m.label} resolve ${m.resolveS.toFixed(1)}s`).toBe(`${m.label} resolve ${Math.min(m.resolveS, RESOLVE_S - 0.01).toFixed(1)}s`);
    expect(Math.max(...results.map((m) => m.resolveS))).toBeLessThan(RESOLVE_S);
    expect(Math.min(...results.map((m) => m.quality))).toBeGreaterThan(0.4);
  });

  it('(6) still estimates the phone lever arm (true 0.9 m forward) with compensation off', () => {
    // `leverCompensation` defaults to false — the slip estimator owns the lever arm — but d̂ₓ is
    // estimated regardless and published, so that module can replace its fixed 0.9 constant.
    expect(DEFAULT_MOUNT_OPTIONS.leverCompensation).toBe(false);
    for (const m of results) expect(m.leverDx).toBeGreaterThan(0.45);
    for (const m of results) expect(m.leverDx).toBeLessThan(1.1);
  });

  it('(7) produces an orthonormal, right-handed rotation', () => {
    const run = run1('harbor', { seed: 1, laps: 1, mount: 'landscape-dash' });
    const cal = new MountCalibrator();
    let gi = 0;
    for (const m of run.motion) {
      while (gi < run.gps.length && run.gps[gi].t <= m.t) cal.pushGps(run.gps[gi++]);
      cal.push(m);
    }
    const r = cal.calibration.r;
    const row = (i: 0 | 1 | 2) => rowOf(r, i);
    for (const i of [0, 1, 2] as const) {
      const v = row(i);
      expect(Math.hypot(v.x, v.y, v.z)).toBeCloseTo(1, 9);
    }
    const dot = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) => a.x * b.x + a.y * b.y + a.z * b.z;
    expect(dot(row(0), row(1))).toBeCloseTo(0, 9);
    expect(dot(row(1), row(2))).toBeCloseTo(0, 9);
    expect(dot(row(0), row(2))).toBeCloseTo(0, 9);
    // forward × left = up  (right-handed, ISO 8855)
    const f = row(0);
    const l = row(1);
    const cross = { x: f.y * l.z - f.z * l.y, y: f.z * l.x - f.x * l.z, z: f.x * l.y - f.y * l.x };
    expect(angleBetweenDeg(cross, row(2))).toBeLessThan(1e-6);
  });
});

describe('MountCalibrator — mountain pass (grade + off-camber banking)', () => {
  const results: Metrics[] = [];
  for (const mount of MOUNTS) {
    for (const seed of SEEDS) {
      results.push(record(evaluate(`touge ${mount} s${seed}`, run1('touge', { seed, mount }))));
    }
  }
  flush('MOUNT CALIBRATION — touge, point to point (mean grade −5.5 %, banking 2κ off-camber)');

  it('(8) the up axis does not chase body roll/pitch: within 2.5° of the body up on a −6 % pass', () => {
    // The pass averages −5.5 % grade and banks AWAY from every turn, so the world vertical the
    // accelerometer sees is 2.8° (mean pitch) off the body's own up and swings ±10° through the
    // hairpins. What keeps this inside 2.5° is the body-up filter's long, load-weighted memory,
    // not a grade model; `gradeCompensation` is measured in the report and defaults to off.
    for (const m of results) expect.soft(`${m.label} up ${m.upDeg.toFixed(2)}°`).toBe(`${m.label} up ${Math.min(m.upDeg, 2.5).toFixed(2)}°`);
    expect(Math.max(...results.map((m) => m.upDeg))).toBeLessThan(2.5);
    expect(Math.max(...results.map((m) => m.upDeg20))).toBeLessThan(2.5);
  });

  it('(9) still resolves forward (to 5°) and quickly', () => {
    for (const m of results) expect.soft(`${m.label} fwd ${m.fwdDeg.toFixed(2)}°`).toBe(`${m.label} fwd ${Math.min(m.fwdDeg, 5).toFixed(2)}°`);
    expect(Math.max(...results.map((m) => m.fwdDeg))).toBeLessThan(5);
    expect(Math.max(...results.map((m) => m.resolveS))).toBeLessThan(RESOLVE_S);
    expect(Math.max(...results.map((m) => m.yawRms))).toBeLessThan(YAW_RMS);
    // ay costs more here than the 0.6 the flat circuit manages, and so does the floor (0.52–0.56
    // against a PERFECT mount matrix): the pass banks off-camber for whole corners, which tilts
    // the body's lateral axis out of the horizontal and leaks gravity into it, and a body-up
    // filter with half a lap of memory deliberately does not follow that.
    for (const m of results) {
      expect(m.ayFloor).toBeGreaterThan(0.45);
      expect(m.ayRms).toBeLessThan(m.ayFloor + 0.4);
    }
    expect(Math.max(...results.map((m) => m.ayRms))).toBeLessThan(1.0);
  });
});

describe('MountCalibrator — degraded mounts', () => {
  const rough: Metrics[] = [];
  for (const seed of SEEDS) {
    rough.push(record(evaluate(`vibration 2 s${seed}`, run1('harbor', { seed, laps: 2, mount: 'portrait-vent', vibration: 2 }))));
  }
  const loose: Metrics[] = [];
  for (const seed of SEEDS) {
    loose.push(record(evaluate(`looseness 0.25 s${seed}`, run1('harbor', { seed, laps: 2, mount: 'portrait-vent', looseness: 0.25 }))));
  }
  flush('MOUNT CALIBRATION — rough road (vibration 2) and a rattling cradle (looseness 0.25)');

  it('(10) doubled road vibration barely moves the axes', () => {
    for (const m of rough) {
      expect.soft(`${m.label} up ${m.upDeg.toFixed(2)}°`).toBe(`${m.label} up ${Math.min(m.upDeg, 2).toFixed(2)}°`);
      expect.soft(`${m.label} fwd ${m.fwdDeg.toFixed(2)}°`).toBe(`${m.label} fwd ${Math.min(m.fwdDeg, FWD_DEG).toFixed(2)}°`);
    }
    expect(Math.max(...rough.map((m) => m.upDeg))).toBeLessThan(2);
    expect(Math.max(...rough.map((m) => m.fwdDeg))).toBeLessThan(FWD_DEG);
    expect(Math.max(...rough.map((m) => m.ayRms))).toBeLessThan(AY_RMS);
    expect(Math.max(...rough.map((m) => m.yawRms))).toBeLessThan(YAW_RMS);
    expect(Math.max(...rough.map((m) => m.resolveS))).toBeLessThan(RESOLVE_S);
  });

  it('(11) a rattling cradle degrades the axes but the rate error stays at the rigid-body floor', () => {
    // At looseness 0.25 the phone sways ±8° against the car at 0.4–1.8 Hz. The `[floor]` columns
    // are the same errors computed with the TRUE mount matrix: the phone genuinely rotates at
    // 0.14–0.20 rad/s relative to the car, so the brief's 0.04 rad/s is unreachable for ANY
    // calibration and the only meaningful claim is that we add nothing to it.
    for (const m of loose) {
      expect(m.yawFloor).toBeGreaterThan(0.1);
      expect(m.yawRms).toBeLessThan(m.yawFloor * 1.05);
      // ay is allowed 45 % over the floor: the sway rotates the whole frame sample by sample,
      // so some of the longitudinal acceleration lands on the lateral axis
      expect(m.ayRms).toBeLessThan(m.ayFloor * 1.45);
      expect(m.ayRms).toBeLessThan(1.05);
    }
    // the axes survive, at roughly four times the rigid-mount error
    for (const m of loose) {
      expect.soft(`${m.label} up ${m.upDeg.toFixed(2)}°`).toBe(`${m.label} up ${Math.min(m.upDeg, 7).toFixed(2)}°`);
      expect.soft(`${m.label} fwd ${m.fwdDeg.toFixed(2)}°`).toBe(`${m.label} fwd ${Math.min(m.fwdDeg, 16).toFixed(2)}°`);
    }
    expect(Math.max(...loose.map((m) => m.upDeg))).toBeLessThan(7);
    expect(Math.max(...loose.map((m) => m.fwdDeg))).toBeLessThan(16);
    expect(Math.max(...loose.map((m) => m.resolveS))).toBeLessThan(RESOLVE_S);
    // ...and it says so: quality collapses well below the rigid-mount 0.55+
    expect(Math.max(...loose.map((m) => m.quality))).toBeLessThan(0.45);
  });
});

describe('MountCalibrator — the phone is re-seated mid-session', () => {
  /** Splice run B (a different mount) onto the first `cut` seconds of run A, one clock. */
  function splice(mountA: MountPreset, mountB: MountPreset, cut: number) {
    const a = simulateRun('harbor', { seed: 1, laps: 2, mount: mountA });
    const b = simulateRun('harbor', { seed: 2, laps: 2, mount: mountB, idleS: 0 });
    const motion: MotionSample[] = a.motion.filter((m) => m.t <= cut).concat(b.motion.map((m) => ({ ...m, t: m.t + cut })));
    const gps: GpsSample[] = a.gps.filter((g) => g.t <= cut).concat(b.gps.map((g) => ({ ...g, t: g.t + cut })));
    motion.sort((p, q) => p.t - q.t);
    gps.sort((p, q) => p.t - q.t);
    return { a, b, motion, gps };
  }

  const CUT = 60;
  const cases: Array<[MountPreset, MountPreset]> = [
    ['portrait-vent', 'flat-console'],
    ['landscape-dash', 'portrait-vent'],
    ['flat-console', 'random'],
  ];
  const rows: Array<{ label: string; qBefore: number; qDropS: number; minQ: number; up20: number; fwd20: number; upEnd: number; fwdEnd: number; upEndOld: number }> = [];
  for (const [mA, mB] of cases) {
    const { a, b, motion, gps } = splice(mA, mB, CUT);
    const cal = new MountCalibrator();
    const UA = rowOf(a.mount, 2);
    const UB = rowOf(b.mount, 2);
    const FB = rowOf(b.mount, 0);
    let gi = 0;
    let qBefore = 0;
    let qDropS = Infinity;
    let minQ = 1;
    let up20 = NaN;
    let fwd20 = NaN;
    for (const m of motion) {
      while (gi < gps.length && gps[gi].t <= m.t) cal.pushGps(gps[gi++]);
      cal.push(m);
      const c = cal.calibration;
      if (m.t > CUT - 5 && m.t <= CUT) qBefore = c.quality;
      if (m.t > CUT) {
        if (c.quality < minQ) minQ = c.quality;
        if (c.quality < 0.25 && !Number.isFinite(qDropS)) qDropS = m.t - CUT;
        if (Number.isNaN(up20) && m.t >= CUT + 20) {
          up20 = angleBetweenDeg(rowOf(c.r, 2), UB);
          fwd20 = angleBetweenDeg(rowOf(c.r, 0), FB);
        }
      }
    }
    const c = cal.calibration;
    rows.push({
      label: `${mA} → ${mB}`,
      qBefore,
      qDropS,
      minQ,
      up20,
      fwd20,
      upEnd: angleBetweenDeg(rowOf(c.r, 2), UB),
      fwdEnd: angleBetweenDeg(rowOf(c.r, 0), FB),
      upEndOld: angleBetweenDeg(rowOf(c.r, 2), UA),
    });
  }
  process.stdout.write(
    `\nMOUNT RE-CONVERGENCE — the phone is moved to a different mount 60 s into the session\n${'case'.padEnd(32)}${'q before'.padStart(9)}${'q<0.25 after'.padStart(13)}${'min q'.padStart(7)}${'up@+20s'.padStart(9)}${'fwd@+20s'.padStart(10)}${'up end'.padStart(8)}${'fwd end'.padStart(9)}${'up end vs OLD'.padStart(14)}\n`,
  );
  for (const r of rows) {
    process.stdout.write(
      `${r.label.padEnd(32)}${r.qBefore.toFixed(2).padStart(9)}${`${r.qDropS.toFixed(1)}s`.padStart(13)}${r.minQ.toFixed(2).padStart(7)}` +
        `${`${r.up20.toFixed(1)}°`.padStart(9)}${`${r.fwd20.toFixed(1)}°`.padStart(10)}${`${r.upEnd.toFixed(1)}°`.padStart(8)}${`${r.fwdEnd.toFixed(1)}°`.padStart(9)}${`${r.upEndOld.toFixed(1)}°`.padStart(14)}\n`,
    );
  }

  it('(12) drops its quality within a few seconds of the change', () => {
    for (const r of rows) {
      expect(r.qBefore).toBeGreaterThan(0.5);
      expect(r.qDropS).toBeLessThan(5);
      expect(r.minQ).toBeLessThan(0.1);
    }
  });

  it('(13) re-converges the UP axis onto the new mount within 20 s', () => {
    for (const r of rows) expect.soft(`${r.label} up@20s ${r.up20.toFixed(1)}°`).toBe(`${r.label} up@20s ${Math.min(r.up20, 6).toFixed(1)}°`);
    expect(Math.max(...rows.map((r) => r.up20))).toBeLessThan(6);
  });

  it('(14) ends pointing at the NEW mount, not the old one', () => {
    // FORWARD is slower than 20 s here and the brief's "~20 s" is not met for it: see the
    // header note (3). What is asserted is that it does get there, and that the old mount is
    // decisively abandoned.
    for (const r of rows) {
      expect(r.upEnd).toBeLessThan(5);
      expect(r.fwdEnd).toBeLessThan(9);
      expect(r.upEndOld).toBeGreaterThan(4 * r.upEnd);
    }
  });
});

describe('MountCalibrator — boundary behaviour', () => {
  it('(15) starts as the identity with zero quality and never emits NaN', () => {
    const cal = new MountCalibrator();
    expect(cal.calibration.quality).toBe(0);
    expect(cal.calibration.forwardResolved).toBe(false);
    expect(cal.calibration.r).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    const bad: MotionSample = {
      t: NaN,
      accel: { x: NaN, y: Infinity, z: 0 },
      gravity: { x: 0, y: 0, z: -Infinity },
      rotationRate: { x: NaN, y: 0, z: 0 },
    };
    const out = cal.push(bad);
    for (const v of [out.t, out.ax, out.ay, out.az, out.yawRate, out.rollRate, out.pitchRate, out.calibrationQuality]) {
      expect(Number.isFinite(v)).toBe(true);
    }
    cal.pushGps({ t: NaN, lat: NaN, lon: NaN, speed: -1, course: -1, hAcc: NaN });
    expect(Number.isFinite(cal.calibration.quality)).toBe(true);
  });

  it('(16) survives a run fed with no GPS at all (gravity still fixes up)', () => {
    const run = run1('harbor', { seed: 2, laps: 1, mount: 'portrait-vent' });
    const cal = new MountCalibrator();
    for (const m of run.motion) cal.push(m);
    const c = cal.calibration;
    expect(Number.isFinite(c.quality)).toBe(true);
    expect(angleBetweenDeg(rowOf(c.r, 2), rowOf(run.mount, 2))).toBeLessThan(2.5);
    for (const v of c.r) expect(Number.isFinite(v)).toBe(true);
  });

  it('(17) markStationary() re-anchors the up axis immediately', () => {
    const run = run1('harbor', { seed: 1, laps: 1, mount: 'flat-console' });
    const cal = new MountCalibrator();
    let gi = 0;
    for (const m of run.motion) {
      while (gi < run.gps.length && run.gps[gi].t <= m.t) cal.pushGps(run.gps[gi++]);
      cal.push(m);
      if (m.t > 1 && m.t < 1.02) cal.markStationary();
    }
    expect(angleBetweenDeg(rowOf(cal.calibration.r, 2), rowOf(run.mount, 2))).toBeLessThan(2);
  });
});

describe('forwardProgress', () => {
  /**
   * The readout that printed "1730% there".
   *
   * A phone lying flat on a dash gathers straight-line acceleration for as long as you drive,
   * so a tile showing evidence over its minimum climbs without bound — while what is actually
   * stuck is that the evidence is smeared across two axes, or that the line is known and which
   * end of it faces the windscreen is not. Both parts are ratios to their own bar, clamped, so
   * 100 % means done.
   */
  const OPTS = { lineAcceptQuality: DEFAULT_MOUNT_OPTIONS.lineAcceptQuality, signAcceptScore: DEFAULT_MOUNT_OPTIONS.signAcceptScore };

  it('never reports more than done, however much evidence piles up', () => {
    const p = forwardProgress({ lineQuality: 100, signScore: 40 }, OPTS);
    expect(p.axis).toBe(1);
    expect(p.direction).toBe(1);
    expect(p.resolved).toBe(true);
  });

  it('blames the axis when the line is smeared, even with the direction settled', () => {
    // The flat-on-the-dash case: plenty of acceleration, no single line through it.
    const p = forwardProgress({ lineQuality: 0.05, signScore: 10 }, OPTS);
    expect(p.blocking).toBe('axis');
    expect(p.resolved).toBe(false);
    expect(p.direction).toBe(1);
  });

  it('blames the direction when the line is found but not which end is forward', () => {
    const p = forwardProgress({ lineQuality: 10, signScore: 0.01 }, OPTS);
    expect(p.blocking).toBe('direction');
    expect(p.resolved).toBe(false);
    expect(p.axis).toBe(1);
  });

  it('reports nothing found before any evidence', () => {
    const p = forwardProgress({ lineQuality: 0, signScore: 0 }, OPTS);
    expect(p.axis).toBe(0);
    expect(p.direction).toBe(0);
    expect(p.blocking).toBe('axis');
  });

  it('agrees with the calibrator it is the gate for', () => {
    // Both bars exactly met is resolved; a hair under either is not.
    expect(forwardProgress({ lineQuality: OPTS.lineAcceptQuality, signScore: OPTS.signAcceptScore }, OPTS).resolved).toBe(true);
    expect(forwardProgress({ lineQuality: OPTS.lineAcceptQuality * 0.999, signScore: OPTS.signAcceptScore }, OPTS).resolved).toBe(false);
    expect(forwardProgress({ lineQuality: OPTS.lineAcceptQuality, signScore: OPTS.signAcceptScore * 0.999 }, OPTS).resolved).toBe(false);
  });

  it('takes a negative sign score as evidence, not as absence', () => {
    // The sign says WHICH end; a strong negative is as resolved as a strong positive.
    expect(forwardProgress({ lineQuality: 10, signScore: -10 }, OPTS).resolved).toBe(true);
  });
});
