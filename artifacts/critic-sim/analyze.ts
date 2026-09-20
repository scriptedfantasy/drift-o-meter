/* Critic scratch analysis for src/sim. Run: npx tsx artifacts/critic-sim/analyze.ts */
import { simulateRun, TRACKS, buildPath, findCorners, type SimulateOptions, type TrackId } from '../../src/sim';
import { mountMatrix } from '../../src/sim/sensors';
import { planLap } from '../../src/sim/driver';
import { Prng } from '../../src/sim/prng';
import { wrapAngle, radToDeg, G } from '../../src/engine/types';
import * as fs from 'fs';

const OUT = 'artifacts/critic-sim';
const r3 = (x: number) => Math.round(x * 1000) / 1000;
const r4 = (x: number) => Math.round(x * 10000) / 10000;
function st(a: number[]) {
  if (!a.length) return { n: 0, mean: NaN, rms: NaN, maxAbs: NaN, p95: NaN };
  const n = a.length;
  const mean = a.reduce((s, v) => s + v, 0) / n;
  const rms = Math.sqrt(a.reduce((s, v) => s + v * v, 0) / n);
  const maxAbs = Math.max(...a.map(Math.abs));
  const sorted = a.map(Math.abs).sort((x, y) => x - y);
  const p95 = sorted[Math.floor(0.95 * (n - 1))];
  return { n, mean: r4(mean), rms: r4(rms), maxAbs: r4(maxAbs), p95: r4(p95) };
}
const applyM = (m: number[], v: { x: number; y: number; z: number }) => ({
  x: m[0] * v.x + m[1] * v.y + m[2] * v.z,
  y: m[3] * v.x + m[4] * v.y + m[5] * v.z,
  z: m[6] * v.x + m[7] * v.y + m[8] * v.z,
});

// ---------- 1. kinematic consistency ----------
function kinematics(run: ReturnType<typeof simulateRun>, label: string) {
  const T = run.truth;
  const n = T.length;
  const dt = T[1].t - T[0].t;
  // unwrap heading
  const hU: number[] = [T[0].heading];
  for (let i = 1; i < n; i++) hU.push(hU[i - 1] + wrapAngle(T[i].heading - T[i - 1].heading));
  const cU: number[] = [T[0].course];
  for (let i = 1; i < n; i++) cU.push(cU[i - 1] + wrapAngle(T[i].course - T[i - 1].course));
  const resHead: number[] = [], resYaw: number[] = [], resSpeedPos: number[] = [], resDirPos: number[] = [];
  const resAy: number[] = [], resAx: number[] = [], resAxNum: number[] = [], yawAcc: number[] = [], betaDotArr: number[] = [];
  const resAyFormula: number[] = [];
  let sumVdot = 0;
  for (let i = 1; i < n - 1; i++) {
    const s = T[i];
    resHead.push(radToDeg(wrapAngle(s.heading - wrapAngle(s.course - s.beta))));
    if (s.speed > 1 && T[i - 1].speed > 1 && T[i + 1].speed > 1) {
      const hd = (hU[i + 1] - hU[i - 1]) / (2 * dt);
      resYaw.push(radToDeg(s.yawRate - hd));
      const vx = (T[i + 1].x - T[i - 1].x) / (2 * dt);
      const vy = (T[i + 1].y - T[i - 1].y) / (2 * dt);
      resSpeedPos.push(Math.hypot(vx, vy) - s.speed);
      resDirPos.push(radToDeg(wrapAngle(Math.atan2(vy, vx) - s.course)));
      const vdot = (T[i + 1].speed - T[i - 1].speed) / (2 * dt);
      const bdot = (T[i + 1].beta - T[i - 1].beta) / (2 * dt);
      const cdot = (cU[i + 1] - cU[i - 1]) / (2 * dt);
      betaDotArr.push(bdot);
      // formula with truth r and numerical v̇, β̇
      const ayF = vdot * Math.sin(s.beta) + s.speed * (s.yawRate + bdot) * Math.cos(s.beta);
      const axF = vdot * Math.cos(s.beta) - s.speed * (s.yawRate + bdot) * Math.sin(s.beta);
      resAy.push(s.ay - ayF);
      resAx.push(s.ax - axF);
      // formula using course rate from truth course (cdot) instead of r+bdot
      resAyFormula.push(s.ay - (vdot * Math.sin(s.beta) + s.speed * cdot * Math.cos(s.beta)));
      if (Math.abs(s.beta) < 0.02) resAxNum.push(s.ax - vdot);
      yawAcc.push((T[i + 1].yawRate - T[i - 1].yawRate) / (2 * dt));
    }
  }
  const out = {
    label,
    samples: n,
    dt,
    heading_minus_course_plus_beta_deg: st(resHead),
    yawRate_minus_dHeading_dt_degps: st(resYaw),
    speedFromPos_minus_speed_mps: st(resSpeedPos),
    dirFromPos_minus_course_deg: st(resDirPos),
    ay_minus_formula_numeric: st(resAy),
    ax_minus_formula_numeric: st(resAx),
    ay_minus_formula_courseRate: st(resAyFormula),
    ax_minus_vdot_straight: st(resAxNum),
    yawAccel_radps2: st(yawAcc),
    betaDot_radps: st(betaDotArr),
  };
  return out;
}

// ---------- 2. drift stats ----------
function driftStats(run: ReturnType<typeof simulateRun>, label: string) {
  const T = run.truth;
  const dt = T[1].t - T[0].t;
  // segments by |beta|>5 deg (physically what a judge sees), and by the drifting flag
  const segs: Array<{ t0: number; t1: number; peak: number; mean: number; vMean: number; vMin: number; vMax: number; rPeak: number; ayPeak: number; axPeak: number; signChanges: number; rise90: number; overshoot: number; flagLead: number; }> = [];
  let i = 0;
  const n = T.length;
  while (i < n) {
    if (Math.abs(T[i].beta) > 0.087) {
      let j = i;
      while (j < n && Math.abs(T[j].beta) > 0.087) j++;
      // allow tiny zero crossings inside a transition: merge if next region starts within 0.4 s
      let k = j;
      while (k < n && Math.abs(T[k].beta) <= 0.087 && (k - j) * dt < 0.4) k++;
      let end = j;
      while (k < n && Math.abs(T[k].beta) > 0.087 && (k - j) * dt < 0.4) {
        // continue region
        while (k < n && Math.abs(T[k].beta) > 0.087) k++;
        end = k;
        j = k;
        while (k < n && Math.abs(T[k].beta) <= 0.087 && (k - j) * dt < 0.4) k++;
      }
      const seg = T.slice(i, end);
      const betas = seg.map((s) => Math.abs(s.beta));
      const peak = Math.max(...betas);
      const mid = seg.slice(Math.floor(seg.length * 0.2), Math.floor(seg.length * 0.8));
      const mean = mid.length ? mid.reduce((a, s) => a + Math.abs(s.beta), 0) / mid.length : NaN;
      let sc = 0;
      for (let q = 1; q < seg.length; q++) if (Math.sign(seg[q].beta) !== Math.sign(seg[q - 1].beta) && seg[q].beta !== 0) sc++;
      // initiation: time from |beta|>5deg to 90% of first local max; overshoot = first local max / following settled mean
      let firstMax = 0, firstMaxIdx = 0;
      for (let q = 1; q < seg.length - 1; q++) {
        if (betas[q] > betas[q - 1] && betas[q] >= betas[q + 1] && betas[q] > 0.15) { firstMax = betas[q]; firstMaxIdx = q; break; }
      }
      let rise90 = NaN, overshoot = NaN;
      if (firstMax > 0) {
        let q = 0;
        while (q < firstMaxIdx && betas[q] < 0.9 * firstMax) q++;
        rise90 = q * dt;
        const after = betas.slice(firstMaxIdx + 20, Math.min(firstMaxIdx + 120, seg.length));
        if (after.length > 30) overshoot = firstMax / (after.reduce((a, b) => a + b, 0) / after.length) - 1;
      }
      // flag lead: how long before |beta|>5deg was drifting flag already true
      let fl = i;
      while (fl > 0 && T[fl - 1].drifting) fl--;
      segs.push({
        t0: r3(T[i].t), t1: r3(T[end - 1].t), peak: r3(radToDeg(peak)), mean: r3(radToDeg(mean)),
        vMean: r3(seg.reduce((a, s) => a + s.speed, 0) / seg.length * 3.6), vMin: r3(Math.min(...seg.map((s) => s.speed)) * 3.6), vMax: r3(Math.max(...seg.map((s) => s.speed)) * 3.6),
        rPeak: r3(radToDeg(Math.max(...seg.map((s) => Math.abs(s.yawRate))))), ayPeak: r3(Math.max(...seg.map((s) => Math.abs(s.ay))) / G), axPeak: r3(Math.max(...seg.map((s) => Math.abs(s.ax))) / G),
        signChanges: sc, rise90: r3(rise90), overshoot: r3(overshoot), flagLead: r3((i - fl) * dt),
      });
      i = Math.max(end, i + 1);
    } else i++;
  }
  const total = T[n - 1].t - T[0].t;
  const driftT = T.filter((s) => Math.abs(s.beta) > 0.087).length * dt;
  const flagT = T.filter((s) => s.drifting).length * dt;
  const vmax = Math.max(...T.map((s) => s.speed));
  const ayMax = Math.max(...T.map((s) => Math.abs(s.ay)));
  const rMax = Math.max(...T.map((s) => Math.abs(s.yawRate)));
  // transitions: measure swing time between -50% and +50% of neighbouring holds
  const swings: number[] = [];
  const rSwing: number[] = [];
  for (let q = 1; q < n; q++) {
    if (Math.sign(T[q].beta) !== Math.sign(T[q - 1].beta) && Math.abs(T[q - 1].beta) > 0.02) {
      // find where |beta| was last > 0.26 (15 deg) before and first > 0.26 after
      let a = q - 1; while (a > 0 && Math.abs(T[a].beta) < 0.26) a--;
      let b = q; while (b < n - 1 && Math.abs(T[b].beta) < 0.26) b++;
      if (Math.abs(T[a].beta) >= 0.26 && Math.abs(T[b].beta) >= 0.26 && (b - a) * dt < 3) {
        swings.push((b - a) * dt);
        rSwing.push(radToDeg(Math.max(...T.slice(a, b + 1).map((s) => Math.abs(s.yawRate)))));
      }
    }
  }
  return { label, totalS: r3(total), driftS_beta5: r3(driftT), driftS_flag: r3(flagT), vmaxKmh: r3(vmax * 3.6), ayMaxG: r3(ayMax / G), yawRateMaxDegps: r3(radToDeg(rMax)), nSegs: segs.length, segs, transitions15to15_s: swings.map(r3), transitionPeakYaw_degps: rSwing.map(r3) };
}

// ---------- 3. sensor stats ----------
function sensorStats(run: ReturnType<typeof simulateRun>, label: string) {
  const M = run.motion, T = run.truth, R = run.mount as number[];
  const dt = M[1].t - M[0].t;
  // idle window (first 2.5 s)
  const idle = M.filter((m) => m.t < 2.5);
  const gyrIdle = ['x', 'y', 'z'].map((k) => st(idle.map((m) => (m.rotationRate as any)[k])));
  const accIdle = ['x', 'y', 'z'].map((k) => st(idle.map((m) => (m.accel as any)[k])));
  const gravIdle = idle.map((m) => Math.hypot(m.gravity.x, m.gravity.y, m.gravity.z));
  // at speed: vehicle-frame accel residual after removing truth ax, ay
  const resV: { x: number[]; y: number[]; z: number[] } = { x: [], y: [], z: [] };
  const gyrRes: { x: number[]; y: number[]; z: number[] } = { x: [], y: [], z: [] };
  const gravTilt: number[] = [];
  const gravMag: number[] = [];
  for (let i = 0; i < M.length; i++) {
    if (T[i].speed > 15) {
      const a = applyM(R, M[i].accel);
      resV.x.push(a.x - T[i].ax); resV.y.push(a.y - T[i].ay); resV.z.push(a.z);
      const w = applyM(R, M[i].rotationRate);
      gyrRes.z.push(radToDeg(w.z - T[i].yawRate)); gyrRes.x.push(radToDeg(w.x)); gyrRes.y.push(radToDeg(w.y));
    }
    const g = applyM(R, M[i].gravity);
    gravMag.push(Math.hypot(g.x, g.y, g.z));
    gravTilt.push(radToDeg(Math.atan2(Math.hypot(g.x, g.y), -g.z)));
  }
  // gravity vs gyro consistency: d(g)/dt + ω × g  (phone frame), smoothed 0.3 s
  const win = Math.round(0.3 / dt);
  const sm = (arr: number[]) => arr.map((_, i) => { let s = 0, c = 0; for (let k = -win; k <= win; k++) { const j = i + k; if (j >= 0 && j < arr.length) { s += arr[j]; c++; } } return s / c; });
  const gx = sm(M.map((m) => m.gravity.x)), gy = sm(M.map((m) => m.gravity.y)), gz = sm(M.map((m) => m.gravity.z));
  const wx = sm(M.map((m) => m.rotationRate.x)), wy = sm(M.map((m) => m.rotationRate.y)), wz = sm(M.map((m) => m.rotationRate.z));
  const rPlus: number[] = [], rMinus: number[] = [], gd: number[] = [];
  for (let i = win + 1; i < M.length - win - 1; i++) {
    const dgx = (gx[i + 1] - gx[i - 1]) / (2 * dt), dgy = (gy[i + 1] - gy[i - 1]) / (2 * dt), dgz = (gz[i + 1] - gz[i - 1]) / (2 * dt);
    const cx = wy[i] * gz[i] - wz[i] * gy[i], cy = wz[i] * gx[i] - wx[i] * gz[i], cz = wx[i] * gy[i] - wy[i] * gx[i];
    rPlus.push(Math.hypot(dgx + cx, dgy + cy, dgz + cz));
    rMinus.push(Math.hypot(dgx - cx, dgy - cy, dgz - cz));
    gd.push(Math.hypot(dgx, dgy, dgz));
  }
  return {
    label,
    idle_gyro_degps: gyrIdle.map((s) => ({ mean: r3(radToDeg(s.mean)), rms: r3(radToDeg(s.rms)) })),
    idle_accel_mps2: accIdle.map((s) => ({ mean: r4(s.mean), rms: r4(s.rms) })),
    idle_gravMag: st(gravIdle),
    atSpeed_accelResidual_vehicle_rms: { x: r3(st(resV.x).rms), y: r3(st(resV.y).rms), z: r3(st(resV.z).rms) },
    atSpeed_gyro_vehicle_degps: { rollRms: r3(st(gyrRes.x).rms), pitchRms: r3(st(gyrRes.y).rms), yawResidualMean: r3(st(gyrRes.z).mean), yawResidualRms: r3(st(gyrRes.z).rms) },
    gravityTiltDeg: st(gravTilt),
    gravityMag: st(gravMag),
    gravGyroConsistency: { rms_dg_plus_wxg: r3(st(rPlus).rms), rms_dg_minus_wxg: r3(st(rMinus).rms), rms_dg: r3(st(gd).rms) },
  };
}

// ---------- 4. GPS stats ----------
function gpsStats(run: ReturnType<typeof simulateRun>, label: string) {
  const Gp = run.gps, T = run.truth;
  const dt = T[1].t - T[0].t;
  const mLat = 111132.954, mLon = 111132.954 * Math.cos((run.originLat * Math.PI) / 180);
  const lat: number[] = [], posErr: number[] = [], spdErr: number[] = [], crsErr: number[] = [], crsErrNoLag: number[] = [], hacc: number[] = [], gaps: number[] = [], ex: number[] = [], ey: number[] = [];
  let prevT = -1;
  for (const g of Gp) {
    const gx = (g.lon - run.originLon) * mLon, gy = (g.lat - run.originLat) * mLat;
    // estimate fix time: nearest truth sample by position in window [t-1.5, t]
    const i1 = Math.min(T.length - 1, Math.floor(g.t / dt)), i0 = Math.max(0, Math.floor((g.t - 1.5) / dt));
    let best = i1, bd = Infinity;
    for (let i = i0; i <= i1; i++) { const d = Math.hypot(T[i].x - gx, T[i].y - gy); if (d < bd) { bd = d; best = i; } }
    if (T[best].speed > 3) {
      lat.push(g.t - T[best].t);
      posErr.push(bd); ex.push(gx - T[best].x); ey.push(gy - T[best].y);
      spdErr.push(g.speed - T[best].speed);
      if (g.course >= 0) {
        const cm = wrapAngle(Math.PI / 2 - (g.course * Math.PI) / 180);
        crsErr.push(radToDeg(wrapAngle(cm - T[best].course)));
        const iNow = Math.min(T.length - 1, Math.floor(g.t / dt));
        crsErrNoLag.push(radToDeg(wrapAngle(cm - T[iNow].course)));
      }
    }
    hacc.push(g.hAcc);
    if (prevT >= 0) gaps.push(g.t - prevT);
    prevT = g.t;
  }
  // position-error autocorrelation at lag 1..5 fixes
  const ac = (a: number[], L: number) => { const m = a.reduce((s, v) => s + v, 0) / a.length; let num = 0, den = 0; for (let i = 0; i < a.length; i++) { den += (a[i] - m) ** 2; if (i + L < a.length) num += (a[i] - m) * (a[i + L] - m); } return r3(num / den); };
  const noCourse = Gp.filter((g) => g.course < 0).length;
  return {
    label, fixes: Gp.length, noCourse, gaps_s: { min: r3(Math.min(...gaps)), max: r3(Math.max(...gaps)), mean: r3(gaps.reduce((a, b) => a + b, 0) / gaps.length), over1p5: gaps.filter((g) => g > 1.5).length },
    latencyEst_s: st(lat), posErr_m: st(posErr), posErrAutocorr: [1, 2, 5, 10].map((L) => ({ L, x: ac(ex, L), y: ac(ey, L) })), speedErr_mps: st(spdErr), courseErr_atFix_deg: st(crsErr), courseErr_vsCourseAtDelivery_deg: st(crsErrNoLag), hAcc: st(hacc),
  };
}

// ---------- run ----------
const results: any = {};
const t0 = performance.now();
const base = simulateRun('harbor', { seed: 1, laps: 2 });
const tBase = performance.now() - t0;
results.timing = { harbor2laps_ms: r3(tBase), samples: base.motion.length };
const t1 = performance.now();
const three = simulateRun('harbor', { seed: 4, laps: 3 });
results.timing.harbor3laps_ms = r3(performance.now() - t1);
results.timing.harbor3laps_samples = three.motion.length;
results.timing.harbor3laps_durationS = r3(three.truth[three.truth.length - 1].t);

results.kin = [kinematics(base, 'harbor s1 2laps'), kinematics(simulateRun('touge', { seed: 9 }), 'touge s9'), kinematics(simulateRun('harbor', { seed: 7, aggression: 1, consistency: 0.2 }), 'harbor s7 aggr1 cons0.2')];
results.drift = [
  driftStats(base, 'harbor s1 2laps a0.7 c0.7'),
  driftStats(simulateRun('harbor', { seed: 2, aggression: 0, consistency: 1 }), 'harbor s2 a0 c1'),
  driftStats(simulateRun('harbor', { seed: 3, aggression: 1, consistency: 0 }), 'harbor s3 a1 c0'),
  driftStats(simulateRun('touge', { seed: 9 }), 'touge s9 a0.7 c0.7'),
  driftStats(simulateRun('touge', { seed: 11, aggression: 1, consistency: 0.3 }), 'touge s11 a1 c0.3'),
];
results.sensors = [
  sensorStats(base, 'harbor s1 rigid vib1'),
  sensorStats(simulateRun('harbor', { seed: 1, laps: 1, looseness: 1 }), 'harbor s1 looseness1'),
  sensorStats(simulateRun('harbor', { seed: 1, laps: 1, vibration: 0 }), 'harbor s1 vib0'),
  sensorStats(simulateRun('harbor', { seed: 1, laps: 1, vibration: 2 }), 'harbor s1 vib2'),
  sensorStats(simulateRun('touge', { seed: 5, mount: 'flat-console' }), 'touge s5 flat-console'),
  sensorStats(simulateRun('touge', { seed: 5, mount: 'random' }), 'touge s5 random'),
];
results.gps = [
  gpsStats(base, 'harbor s1 default'),
  gpsStats(simulateRun('harbor', { seed: 1, laps: 1, gpsLatency: 1.0 }), 'harbor s1 latency1.0'),
  gpsStats(simulateRun('harbor', { seed: 1, laps: 1, gpsLatency: 0.2 }), 'harbor s1 latency0.2'),
  gpsStats(simulateRun('harbor', { seed: 1, laps: 2, gpsDropouts: true }), 'harbor s1 dropouts'),
  gpsStats(simulateRun('harbor', { seed: 1, laps: 1, gpsRateHz: 5 }), 'harbor s1 5Hz'),
];
// mount matrices
const rng = new Prng(1);
results.mounts = (['portrait-vent', 'landscape-dash', 'flat-console', 'random'] as const).map((p) => {
  const R = mountMatrix(p, rng) as number[];
  const col = (j: number) => [R[j], R[3 + j], R[6 + j]];
  const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const det = R[0] * (R[4] * R[8] - R[5] * R[7]) - R[1] * (R[3] * R[8] - R[5] * R[6]) + R[2] * (R[3] * R[7] - R[4] * R[6]);
  const c = [col(0), col(1), col(2)];
  return { preset: p, det: r4(det), orth: [r4(dot(c[0], c[1])), r4(dot(c[0], c[2])), r4(dot(c[1], c[2]))], norms: c.map((v) => r4(Math.hypot(...v))), phoneX_inVehicle: c[0].map(r3), phoneY_inVehicle: c[1].map(r3), phoneZ_inVehicle: c[2].map(r3) };
});
// determinism
const a = simulateRun('touge', { seed: 9, looseness: 0.5, gpsDropouts: true });
const b = simulateRun('touge', { seed: 9, looseness: 0.5, gpsDropouts: true });
results.deterministic = JSON.stringify(a.motion) === JSON.stringify(b.motion) && JSON.stringify(a.gps) === JSON.stringify(b.gps) && JSON.stringify(a.truth) === JSON.stringify(b.truth);
const c1 = simulateRun('harbor', { seed: 9 }), c2 = simulateRun('harbor', { seed: 10 });
results.seedsDiffer = JSON.stringify(c1.truth) !== JSON.stringify(c2.truth);
// edge cases
const edge: any = {};
for (const [name, opt] of Object.entries({ laps0: { laps: 0 }, idle0: { idleS: 0 }, rate50: { rateHz: 50 }, rate10: { rateHz: 10 }, aggr0cons0: { aggression: 0, consistency: 0 }, aggr1cons1: { aggression: 1, consistency: 1 }, lat0: { gpsLatency: 0 }, gps10Hz: { gpsRateHz: 10 }, vib0loose1: { vibration: 0, looseness: 1 } } as Record<string, SimulateOptions>)) {
  try {
    const r = simulateRun('harbor', { seed: 2, ...opt });
    const nan = r.motion.some((m) => [m.accel.x, m.accel.y, m.accel.z, m.gravity.x, m.gravity.y, m.gravity.z, m.rotationRate.x, m.rotationRate.y, m.rotationRate.z, m.t].some((v) => !Number.isFinite(v))) || r.truth.some((s) => Object.values(s).some((v) => typeof v === 'number' && !Number.isFinite(v))) || r.gps.some((g) => [g.t, g.lat, g.lon, g.speed, g.hAcc].some((v) => !Number.isFinite(v)));
    const tMono = r.motion.every((m, i) => i === 0 || m.t > r.motion[i - 1].t);
    const gMono = r.gps.every((g, i) => i === 0 || g.t >= r.gps[i - 1].t);
    edge[name] = { motion: r.motion.length, gps: r.gps.length, nan, tMono, gMono, lapTimes: r.lapTimes.map(r3), endT: r3(r.truth[r.truth.length - 1].t) };
  } catch (e: any) { edge[name] = { error: String(e.message ?? e) }; }
}
results.edge = edge;
// roll-out consistency: last 4 s — truth vs sensor-derived
{
  const T = base.truth, M = base.motion, R = base.mount as number[];
  const last = T.length - 1;
  const tEnd = T[last].t;
  const rows: any[] = [];
  for (let i = T.length - 1; i >= 0 && T[i].t > tEnd - 4.5; i -= 40) {
    const a = applyM(R, M[i].accel), w = applyM(R, M[i].rotationRate);
    rows.push({ t: r3(T[i].t), v: r3(T[i].speed), truthAx: r3(T[i].ax), sensAx: r3(a.x), truthAy: r3(T[i].ay), sensAy: r3(a.y), truthYaw: r3(radToDeg(T[i].yawRate)), sensYaw: r3(radToDeg(w.z)), truthBeta: r3(radToDeg(T[i].beta)), heading: r3(radToDeg(T[i].heading)) });
  }
  results.rollout = rows.reverse();
  // heading jump at end of main loop
  const jumps: any[] = [];
  for (let i = 1; i < T.length; i++) { const d = Math.abs(wrapAngle(T[i].heading - T[i - 1].heading)); if (d > 0.05) jumps.push({ i, t: r3(T[i].t), jumpDeg: r3(radToDeg(d)), betaBefore: r3(radToDeg(T[i - 1].beta)), betaAfter: r3(radToDeg(T[i].beta)) }); }
  results.headingJumps = jumps;
}
// corners & plan
for (const id of ['harbor', 'touge'] as TrackId[]) {
  const p = buildPath(TRACKS[id]);
  const cs = findCorners(p);
  const plan = planLap(p, cs, 0, { aggression: 0.7, consistency: 0.7, seed: 1 });
  results['corners_' + id] = { length: r3(p.length), corners: cs.map((c) => ({ startS: r3(c.startS), endS: r3(c.endS), apexS: r3(c.apexS), dir: c.direction, R: r3(c.radius) })), segments: plan.segments.map((s) => ({ startS: r3(s.startS), endS: r3(s.endS), betaDeg: r3(radToDeg(s.beta)), linked: s.linked })), vTargetMaxKmh: r3(Math.max(...Array.from(plan.vTarget)) * 3.6), vTargetMinKmh: r3(Math.min(...Array.from(plan.vTarget)) * 3.6) };
}
fs.writeFileSync(`${OUT}/analysis.json`, JSON.stringify(results, null, 1));
console.log(JSON.stringify(results, null, 1));
