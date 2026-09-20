/**
 * Run the slip estimator on a simulated run and dump truth vs estimate as JSON for plotting.
 * usage: npx tsx tools/analysis/slip-eval.ts [harbor|touge] [seed] [laps] [key=value ...] > artifacts/slip-harbor.json
 *   key=value options: gpsLatency=0.8 vibration=2 gpsDropouts=1 looseness=0.5 leverArm=1.6 (simulator)
 *                      latency=0.45 adapt=0 leverArmX=0 (estimator: gpsLatencyS / adaptLatency / leverArmX)
 * Prints the metrics table to stderr.
 */
import { simulateRun, type SimulateOptions, type TrackId } from '../../src/sim';
import { SlipEstimator, type SlipOptions } from '../../src/engine/slip';
import { evaluate, formatMetricsTable, originOffset, vehicleSamplesFromRun } from '../../src/engine/slip/testkit';
import { radToDeg, wrapAngle } from '../../src/engine/types';

const track = (process.argv[2] ?? 'harbor') as TrackId;
const seed = Number(process.argv[3] ?? 1);
const laps = Number(process.argv[4] ?? 2);
const simOpts: SimulateOptions = { seed, laps };
const estOpts: Partial<SlipOptions> = {};
for (const arg of process.argv.slice(5)) {
  const [k, v] = arg.split('=');
  if (k === 'gpsLatency') simOpts.gpsLatency = Number(v);
  else if (k === 'vibration') simOpts.vibration = Number(v);
  else if (k === 'gpsDropouts') simOpts.gpsDropouts = v !== '0';
  else if (k === 'looseness') simOpts.looseness = Number(v);
  else if (k === 'leverArm') simOpts.leverArm = { x: Number(v), y: 0, z: 0.35 };
  else if (k === 'latency') estOpts.gpsLatencyS = Number(v);
  else if (k === 'adapt') estOpts.adaptLatency = v !== '0';
  else if (k === 'leverArmX') estOpts.leverArmX = Number(v);
  else if (k === 'mount') simOpts.mount = v as SimulateOptions['mount'];
}

const run = simulateRun(track, simOpts);
const est = new SlipEstimator(estOpts);
// the same interleaving runEstimator() does, but sampling the estimator's internal parameter
// states as it goes so the plot can show the filter learning them
const motion = vehicleSamplesFromRun(run, true);
const gps = [...run.gps].sort((a, b) => a.t - b.t);
const states = [];
const ayScale: number[] = [];
const axBias: number[] = [];
const gyroBias: number[] = [];
let j = 0;
for (let i = 0; i < motion.length; i++) {
  while (j < gps.length && gps[j].t <= motion[i].t) est.pushGps(gps[j++]);
  states.push(est.pushMotion(motion[i]));
  ayScale.push(est.ayScaleError.value);
  axBias.push(est.axBias);
  gyroBias.push(est.gyroBias.value);
}
const off = originOffset(run, est);
const m = evaluate(`${track} s${seed}`, run, states, { originOffset: off });
process.stderr.write(formatMetricsTable([m]) + '\n');
process.stderr.write(
  `assumed GPS latency at end: ${est.gpsLatency.toFixed(3)} s (simulated ${run.gpsLatency.toFixed(3)} s), ` +
    `gyro bias est ${radToDeg(est.gyroBias.value).toFixed(3)} ± ${radToDeg(est.gyroBias.sigma).toFixed(3)} °/s, ` +
    `lateral scale ${(100 * est.ayScaleError.value).toFixed(1)} ± ${(100 * est.ayScaleError.sigma).toFixed(1)} %, ` +
    `longitudinal bias ${est.axBias.toFixed(2)} m/s²\n`,
);

const out = {
  track,
  seed,
  simOpts,
  estOpts,
  metrics: m,
  gpsLatencyTrue: run.gpsLatency,
  gpsLatencyEst: est.gpsLatency,
  t: states.map((s) => s.t),
  betaTrue: run.truth.map((s) => s.beta),
  betaEst: states.map((s) => s.beta),
  betaSigma: states.map((s) => s.betaSigma),
  speedTrue: run.truth.map((s) => s.speed),
  speedEst: states.map((s) => s.speed),
  yawRateTrue: run.truth.map((s) => s.yawRate),
  yawRateEst: states.map((s) => s.yawRate),
  headingErr: states.map((s, i) => wrapAngle(s.heading - run.truth[i].heading)),
  valid: states.map((s) => (s.valid ? 1 : 0)),
  xTrue: run.truth.map((s) => s.x),
  yTrue: run.truth.map((s) => s.y),
  xEst: states.map((s) => s.x + off.x),
  yEst: states.map((s) => s.y + off.y),
  headingTrue: run.truth.map((s) => s.heading),
  headingEst: states.map((s) => s.heading),
  ayScale,
  axBias,
  gyroBias,
  gpsT: run.gps.map((g) => g.t),
  gpsSpeed: run.gps.map((g) => g.speed),
};
process.stdout.write(JSON.stringify(out));
