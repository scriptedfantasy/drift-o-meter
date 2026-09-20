/**
 * Run the slip estimator on a simulated run and dump truth vs estimate as JSON for plotting.
 * usage: npx tsx tools/analysis/slip-eval.ts [harbor|touge] [seed] [laps] [key=value ...] > artifacts/slip-harbor.json
 *   key=value options: gpsLatency=0.8 vibration=2 gpsDropouts=1 looseness=0.5 (simulator)
 *                      latency=0.45 adapt=0 (estimator: gpsLatencyS / adaptLatency)
 * Prints the metrics table to stderr.
 */
import { simulateRun, type SimulateOptions, type TrackId } from '../../src/sim';
import { SlipEstimator, type SlipOptions } from '../../src/engine/slip';
import { evaluate, formatMetricsTable, originOffset, runEstimator } from '../../src/engine/slip/testkit';

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
  else if (k === 'looseness') (simOpts as Record<string, unknown>).looseness = Number(v);
  else if (k === 'latency') estOpts.gpsLatencyS = Number(v);
  else if (k === 'adapt') estOpts.adaptLatency = v !== '0';
  else if (k === 'mount') simOpts.mount = v as SimulateOptions['mount'];
}

const run = simulateRun(track, simOpts);
const est = new SlipEstimator(estOpts);
const states = runEstimator(run, estOpts, est);
const off = originOffset(run, est);
const m = evaluate(`${track} s${seed}`, run, states, { originOffset: off });
process.stderr.write(formatMetricsTable([m]) + '\n');
process.stderr.write(`assumed GPS latency at end: ${est.gpsLatency.toFixed(3)} s, gyro bias est ${est.gyroBias.value.toFixed(5)} ± ${est.gyroBias.sigma.toFixed(5)} rad/s\n`);

const out = {
  track,
  seed,
  simOpts,
  estOpts,
  metrics: m,
  t: states.map((s) => s.t),
  betaTrue: run.truth.map((s) => s.beta),
  betaEst: states.map((s) => s.beta),
  betaSigma: states.map((s) => s.betaSigma),
  speedTrue: run.truth.map((s) => s.speed),
  speedEst: states.map((s) => s.speed),
  valid: states.map((s) => (s.valid ? 1 : 0)),
  xTrue: run.truth.map((s) => s.x),
  yTrue: run.truth.map((s) => s.y),
  xEst: states.map((s) => s.x + off.x),
  yEst: states.map((s) => s.y + off.y),
  headingTrue: run.truth.map((s) => s.heading),
  headingEst: states.map((s) => s.heading),
  gpsT: run.gps.map((g) => g.t),
  gpsSpeed: run.gps.map((g) => g.speed),
};
process.stdout.write(JSON.stringify(out));
