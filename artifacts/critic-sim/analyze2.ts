import { simulateRun } from '../../src/sim';
import { BetaTracker } from '../../src/sim/driver';
import { wrapAngle, radToDeg } from '../../src/engine/types';
const r3 = (x: number) => Math.round(x * 1000) / 1000;
const out: any = {};
// 1. BetaTracker step response, no wobble/corrections (consistency 1)
function stepResp(from: number, to: number) {
  const tr = new BetaTracker({ aggression: 0.7, consistency: 1, seed: 1 });
  const dt = 0.01; let t = 0;
  for (let i = 0; i < 300; i++) { tr.step(from, t, dt); t += dt; }
  const b: number[] = []; let peak = 0, tPeak = 0, t10 = -1, t90 = -1, tSettle = -1;
  const sgn = Math.sign(to - from);
  for (let i = 0; i < 400; i++) { tr.step(to, t, dt); t += dt; b.push(tr.beta);
    const prog = (tr.beta - from) / (to - from);
    if (t10 < 0 && prog >= 0.1) t10 = i * dt; if (t90 < 0 && prog >= 0.9) t90 = i * dt;
    if (sgn * tr.beta > sgn * peak) { peak = tr.beta; tPeak = i * dt; } }
  const overshoot = to !== 0 ? (peak - to) / (to - from) : NaN;
  // peak beta-dot
  let bdMax = 0; for (let i = 1; i < b.length; i++) bdMax = Math.max(bdMax, Math.abs(b[i] - b[i - 1]) / dt);
  return { fromDeg: r3(radToDeg(from)), toDeg: r3(radToDeg(to)), rise10to90_s: r3(t90 - t10), peakDeg: r3(radToDeg(peak)), tPeak: r3(tPeak), overshootPct: r3(overshoot * 100), peakBetaDot_degps: r3(radToDeg(bdMax)) };
}
out.tracker = [stepResp(0, 0.6), stepResp(0, 0.35), stepResp(-0.5, 0.5), stepResp(0.6, 0)];
// what the initiation WOULD be with the underdamped branch held (reference): simulate 2nd-order wn=2pi*1.1 zeta=0.55
{ const wn = 2 * Math.PI * 1.1, z = 0.55; let b = 0, bd = 0, peak = 0; const dt = 0.01; for (let i = 0; i < 400; i++) { const acc = wn * wn * (0.6 - b) - 2 * z * wn * bd; bd += acc * dt; b += bd * dt; peak = Math.max(peak, b); } out.trackerIfUnderdampedHeld = { overshootPct: r3((peak - 0.6) / 0.6 * 100) }; }

// 2. yaw residual excluding roll-out, and integrated heading inconsistency
for (const [label, run] of [['harbor s1', simulateRun('harbor', { seed: 1, laps: 1 })], ['touge s9', simulateRun('touge', { seed: 9 })], ['harbor s3 a1c0', simulateRun('harbor', { seed: 3, laps: 1, aggression: 1, consistency: 0 })]] as const) {
  const T = run.truth; const dt = 0.01; const n = T.length;
  const tEndMain = T.filter((s) => s.drifting || s.speed > 0.6).slice(-1)[0].t;
  // end of main loop: find last index before rollout = first index where truth.ax === -4 and beta===0 after speed>5
  let iRoll = n - 1; for (let i = n - 1; i > 0; i--) { if (!(T[i].ax === -4 && T[i].beta === 0)) { iRoll = i + 1; break; } }
  const hU: number[] = [T[0].heading]; for (let i = 1; i < n; i++) hU.push(hU[i - 1] + wrapAngle(T[i].heading - T[i - 1].heading));
  const res: number[] = []; let integ = 0, integMax = 0, integMin = 0; const integSeries: number[] = [];
  for (let i = 1; i < iRoll - 1; i++) { if (T[i].speed > 1) { const hd = (hU[i + 1] - hU[i - 1]) / (2 * dt); const r = T[i].yawRate - hd; res.push(radToDeg(r)); integ += r * dt; integSeries.push(integ); integMax = Math.max(integMax, integ); integMin = Math.min(integMin, integ); } }
  const rms = Math.sqrt(res.reduce((a, b) => a + b * b, 0) / res.length);
  const sorted = res.map(Math.abs).sort((a, b) => a - b);
  // gyro-integrated heading vs truth heading over the run (pure model inconsistency, no noise)
  out['yawConsistency_' + label] = { iRoll, tRoll: r3(T[iRoll].t), rms_degps: r3(rms), p95_degps: r3(sorted[Math.floor(0.95 * sorted.length)]), max_degps: r3(sorted[sorted.length - 1]), integratedHeadingError_deg: { max: r3(radToDeg(integMax)), min: r3(radToDeg(integMin)), end: r3(radToDeg(integ)) } };
  // 3. bang-bang throttle: vDot from truth.ax on straights and general ax distribution
  const axs = T.slice(300, iRoll).filter((s) => s.speed > 3).map((s) => s.ax * Math.cos(s.beta) + s.ay * Math.sin(s.beta)); // vdot = ax cos b + ay sin b
  const nearBrk = axs.filter((a) => a < -5.5).length, nearAcc = axs.filter((a) => a > 2.5).length, mid = axs.filter((a) => a >= -1 && a <= 1).length;
  let switches = 0, state = 0; for (const a of axs) { const s = a < -3 ? -1 : a > 2 ? 1 : 0; if (s !== 0 && state !== 0 && s !== state) switches++; if (s !== 0) state = s; }
  const secs = axs.length * dt;
  out['throttle_' + label] = { seconds: r3(secs), pctHardBrake_lt_m5p5: r3(100 * nearBrk / axs.length), pctHardAccel_gt_2p5: r3(100 * nearAcc / axs.length), pctCoast_abs_lt_1: r3(100 * mid / axs.length), brakeAccelSwitches: switches, switchesPerMinute: r3(switches / secs * 60) };
  // speed staircase: numeric dv/dt per sample
  const dv: number[] = []; for (let i = 301; i < iRoll; i++) dv.push((T[i].speed - T[i - 1].speed) / dt);
  const zeros = dv.filter((d) => d === 0).length; const big = dv.filter((d) => Math.abs(d) > 8).length;
  out['speedStaircase_' + label] = { pctSamplesWithZeroDv: r3(100 * zeros / dv.length), pctSamples_dv_gt_8mps2: r3(100 * big / dv.length), maxAbs_dv_dt: r3(Math.max(...dv.map(Math.abs))) };
  // 4. where does position-derived direction disagree with course
  const bad: any[] = []; for (let i = 1; i < iRoll - 1; i++) { if (T[i].speed > 3) { const vx = (T[i + 1].x - T[i - 1].x) / (2 * dt), vy = (T[i + 1].y - T[i - 1].y) / (2 * dt); const d = radToDeg(wrapAngle(Math.atan2(vy, vx) - T[i].course)); const sp = Math.hypot(vx, vy) - T[i].speed; if (Math.abs(d) > 2 || Math.abs(sp) > 1) bad.push({ t: r3(T[i].t), x: r3(T[i].x), y: r3(T[i].y), v: r3(T[i].speed), dirErrDeg: r3(d), speedErr: r3(sp) }); } }
  out['posVsCourseOutliers_' + label] = { count: bad.length, first: bad.slice(0, 4), worst: bad.sort((a, b) => Math.abs(b.dirErrDeg) - Math.abs(a.dirErrDeg)).slice(0, 3) };
  // 6. transitions: zero crossings of beta with >=15deg on both sides within 1.5 s
  const swings: any[] = [];
  for (let q = 1; q < iRoll; q++) { if ((T[q].beta > 0) !== (T[q - 1].beta > 0)) { let a = q - 1; while (a > 0 && Math.abs(T[a].beta) < 0.26 && (q - a) * dt < 1.5) a--; let b = q; while (b < iRoll - 1 && Math.abs(T[b].beta) < 0.26 && (b - q) * dt < 1.5) b++; if (Math.abs(T[a].beta) >= 0.26 && Math.abs(T[b].beta) >= 0.26) { let rmax = 0, bdmax = 0; for (let k = a; k <= b; k++) { rmax = Math.max(rmax, Math.abs(T[k].yawRate)); if (k > a) bdmax = Math.max(bdmax, Math.abs(T[k].beta - T[k - 1].beta) / dt); } swings.push({ t: r3(T[q].t), swing15to15_s: r3((b - a) * dt), fromDeg: r3(radToDeg(T[a].beta)), toDeg: r3(radToDeg(T[b].beta)), peakYaw_degps: r3(radToDeg(rmax)), peakBetaDot_degps: r3(radToDeg(bdmax)), speedKmh: r3(T[q].speed * 3.6) }); } } }
  // near-zero dwell: for each zero crossing, how long |beta|<5deg around it
  const dwell: number[] = []; for (let q = 1; q < iRoll; q++) { if ((T[q].beta > 0) !== (T[q - 1].beta > 0) && Math.abs(T[q - 5]?.beta ?? 1) < 0.5) { let a = q; while (a > 0 && Math.abs(T[a].beta) < 0.087) a--; let b = q; while (b < iRoll && Math.abs(T[b].beta) < 0.087) b++; dwell.push(r3((b - a) * dt)); } }
  out['transitions_' + label] = { swings, dwellBelow5deg_s: dwell };
  // 7. yaw accel excluding rollout
  const ya: number[] = []; for (let i = 1; i < iRoll - 1; i++) if (T[i].speed > 3) ya.push(Math.abs((T[i + 1].yawRate - T[i - 1].yawRate) / (2 * dt)));
  ya.sort((a, b) => a - b);
  out['yawAccel_' + label] = { p95_radps2: r3(ya[Math.floor(0.95 * ya.length)]), p99: r3(ya[Math.floor(0.99 * ya.length)]), max: r3(ya[ya.length - 1]), leverArm1m_p99_mps2: r3(ya[Math.floor(0.99 * ya.length)]) };
}
console.log(JSON.stringify(out, null, 1));
