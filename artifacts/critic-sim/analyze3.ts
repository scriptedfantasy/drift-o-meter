import { SensorModel } from '../../src/sim/sensors';
import { simulateRun, buildPath, TRACKS } from '../../src/sim';
import { radToDeg } from '../../src/engine/types';
const r3 = (x: number) => Math.round(x * 1000) / 1000;
// A. Isolated sway-sign test: parked car, looseness=1, vibration=0, no bias. Only the sway moves the phone.
{
  const sm = new SensorModel({ mount: 'flat-console', seed: 3, looseness: 1, vibration: 0, gyroBias: 0 });
  const dt = 0.01; const N = 2000; const g: number[][] = []; const w: number[][] = [];
  for (let i = 0; i < N; i++) { const st = { t: i * dt, x: 0, y: 0, heading: 0, speed: 0, ax: 0, ay: 0, yawRate: 0, rollRate: 0, pitchRate: 0, roll: 0, pitch: 0 }; const m = sm.motion(st, dt, 0, 0); g.push([m.gravity.x, m.gravity.y, m.gravity.z]); w.push([m.rotationRate.x, m.rotationRate.y, m.rotationRate.z]); }
  let plus = 0, minus = 0, dg = 0;
  for (let i = 1; i < N - 1; i++) { const d = [0, 1, 2].map((k) => (g[i + 1][k] - g[i - 1][k]) / (2 * dt)); const c = [w[i][1] * g[i][2] - w[i][2] * g[i][1], w[i][2] * g[i][0] - w[i][0] * g[i][2], w[i][0] * g[i][1] - w[i][1] * g[i][0]]; plus += Math.hypot(d[0] + c[0], d[1] + c[1], d[2] + c[2]) ** 2; minus += Math.hypot(d[0] - c[0], d[1] - c[1], d[2] - c[2]) ** 2; dg += Math.hypot(...d) ** 2; }
  console.log('A. sway sign (parked, looseness 1, vib 0): rms|dg/dt + w x g| =', r3(Math.sqrt(plus / N)), ' rms|dg/dt - w x g| =', r3(Math.sqrt(minus / N)), ' rms|dg/dt| =', r3(Math.sqrt(dg / N)), ' (correct physics => first ~0)');
  const wr = w.map((v) => Math.hypot(...v)); console.log('   sway gyro |w| peak deg/s', r3(radToDeg(Math.max(...wr))), ' gravity tilt peak deg', r3(radToDeg(Math.max(...g.map((v) => Math.atan2(Math.hypot(v[0], v[1]), -v[2]))))));
}
// A2. same for the rigid mount wobble only (looseness 0, vib 0): is the 0.2 Hz cradle wobble in the gyro?
{
  const sm = new SensorModel({ mount: 'flat-console', seed: 3, looseness: 0, vibration: 0, gyroBias: 0 });
  const dt = 0.01; const N = 2000; let gyroRms = 0, dgRms = 0;
  for (let i = 0; i < N; i++) { const st = { t: i * dt, x: 0, y: 0, heading: 0, speed: 0, ax: 0, ay: 0, yawRate: 0, rollRate: 0, pitchRate: 0, roll: 0, pitch: 0 }; const m = sm.motion(st, dt, 0, 0); gyroRms += m.rotationRate.x ** 2 + m.rotationRate.y ** 2; }
  console.log('A2. parked rigid: gyro x,y rms deg/s =', r3(radToDeg(Math.sqrt(gyroRms / N))), '(pure noise 0.003 rad/s = 0.17 deg/s => the +-1.5deg 0.2 Hz cradle wobble (peak rate 1.9 deg/s) is NOT in the gyro)');
}
// B. harbor geometry vs comments
{
  const p = buildPath(TRACKS.harbor);
  const sumK = p.samples.reduce((a, s) => a + s.kappa * p.ds, 0);
  console.log('B. harbor total turning = ', r3(radToDeg(sumK)), 'deg (positive = CCW loop, all net left)');
  const region = (a: number, b: number) => { const ss = p.samples.filter((s) => s.s >= a && s.s <= b); const kmax = ss.reduce((m, s) => Math.abs(s.kappa) > Math.abs(m.kappa) ? s : m, ss[0]); return { sRange: [a, b], kappaAtMaxAbs: r3(kmax.kappa), minRadius: r3(1 / Math.abs(kmax.kappa)), at: [r3(kmax.x), r3(kmax.y)] }; };
  console.log('   "long right-hand sweeper" region (s 350-450):', JSON.stringify(region(350, 450)));
  console.log('   "hairpin right at the top" region (s 680-780):', JSON.stringify(region(680, 780)));
  console.log('   "left-right chicane" region (s 500-640):', JSON.stringify(region(500, 640)), 'signs:', [...new Set(p.samples.filter((s) => s.s >= 500 && s.s <= 640 && Math.abs(s.kappa) > 1 / 70).map((s) => Math.sign(s.kappa)))]);
  console.log('   tightest corner on the whole lap:', JSON.stringify(region(0, p.length)));
  const t = buildPath(TRACKS.touge); console.log('   touge tightest:', JSON.stringify((() => { const ss = t.samples; const k = ss.reduce((m, s) => Math.abs(s.kappa) > Math.abs(m.kappa) ? s : m, ss[0]); return { s: k.s, minRadius: r3(1 / Math.abs(k.kappa)) }; })()), ' banking at that kappa (deg):', r3(radToDeg(TRACKS.touge.banking!(0, -1 / 48))), '(negative roll = left side down = banked INTO a left turn, comment says off-camber)');
}
// C. truth/motion alignment and vacuous test check
{
  const run = simulateRun('harbor', { seed: 3, laps: 1 });
  const aligned = run.motion.length === run.truth.length && run.motion.every((m, i) => m.t === run.truth[i].t);
  console.log('C. motion/truth aligned by t:', aligned, 'len', run.motion.length);
  const r0 = simulateRun('harbor', { seed: 3, laps: 1, gpsLatency: 0 });
  console.log('   sim.test latency assertion gps[10].t > 9 with gpsLatency=0:', r0.gps[10].t > 9, '(t =', r3(r0.gps[10].t), ') => assertion cannot fail');
  // start-of-run jump
  const i3 = run.truth.findIndex((s) => s.speed > 0.1);
  console.log('   first moving sample: t', run.truth[i3].t, 'speed jumps', run.truth[i3 - 1].speed, '->', r3(run.truth[i3].speed), 'm/s (', r3(run.truth[i3].speed * 3.6), 'km/h) in one 10 ms step; truth.ax there =', r3(run.truth[i3].ax));
  // gps speed around it
  console.log('   GPS speeds 2..6 s:', run.gps.filter((g) => g.t > 2 && g.t < 6.5).map((g) => r3(g.t) + ':' + r3(g.speed * 3.6) + 'km/h').join(' '));
  // instantaneous beta-ddot at a command step (tracker acceleration)
  const T = run.truth; let maxYawAcc = 0, tMax = 0; for (let i = 1; i < T.length - 1; i++) { if (T[i].t > 4 && T[i].t < 60) { const ya = Math.abs((T[i + 1].yawRate - T[i - 1].yawRate) / 0.02); if (ya > maxYawAcc) { maxYawAcc = ya; tMax = T[i].t; } } }
  console.log('   peak yaw acceleration in the run (4-60 s):', r3(maxYawAcc), 'rad/s^2 =', r3(radToDeg(maxYawAcc)), 'deg/s^2 at t', r3(tMax));
}
