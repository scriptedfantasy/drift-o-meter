/**
 * Run a simulated session through the REAL engine pipeline and save the resulting Session.
 *
 *   npx tsx tools/analysis/run-pipeline.ts harbor 1 2
 *   → artifacts/session-harbor.json   (+ a metrics summary on stderr)
 *
 * usage: npx tsx tools/analysis/run-pipeline.ts <harbor|touge> [seed] [laps] [key=value ...]
 *   simulator:  aggression=0.8 consistency=0.85 mount=portrait-vent looseness=0 vibration=1
 *               gpsLatency=0.5 gpsDropouts=0 idle=3
 *   pipeline:   latency=0.45 motionHz=50 stationary=<s> (tap "calibrate" at t=<s>; 0 = never,
 *               the default — see the report: an early markStationary() currently hurts)
 *   output:     out=artifacts/session-harbor.json truth=1 (attach simulator ground truth)
 *
 * The file is a plain `Session` (src/engine/types.ts): the app's results/replay screens and the
 * visual critics load it directly. Timestamps and ids are derived from the seed, so re-running
 * the same command reproduces the same file byte for byte.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { simulateRun, type SimulateOptions, type TrackId } from '../../src/sim';
import { DriftPipeline, type DriftPipelineOptions } from '../../src/engine/pipeline';
import { radToDeg, type TruthSample } from '../../src/engine/types';

const track = (process.argv[2] ?? 'harbor') as TrackId;
const seed = Number(process.argv[3] ?? 1);
const laps = Number(process.argv[4] ?? 2);

const sim: SimulateOptions = { seed, laps, aggression: 0.8, consistency: 0.85 };
const pipe: DriftPipelineOptions = { gpsLatencyS: 0.45 };
let out = `artifacts/session-${track}.json`;
let withTruth = false;
/** Seconds into the run at which the driver taps "calibrate"; 0 = never. */
let stationaryAt = 0;
let name = '';

for (const arg of process.argv.slice(5)) {
  const [k, v] = arg.split('=');
  const n = Number(v);
  if (k === 'aggression') sim.aggression = n;
  else if (k === 'consistency') sim.consistency = n;
  else if (k === 'mount') sim.mount = v as SimulateOptions['mount'];
  else if (k === 'looseness') sim.looseness = n;
  else if (k === 'vibration') sim.vibration = n;
  else if (k === 'gpsLatency') sim.gpsLatency = n;
  else if (k === 'gpsDropouts') sim.gpsDropouts = v !== '0';
  else if (k === 'idle') sim.idleS = n;
  else if (k === 'latency') pipe.gpsLatencyS = n;
  else if (k === 'motionHz') pipe.storeMotionHz = n;
  else if (k === 'stationary') stationaryAt = v === '1' ? 2 : n;
  else if (k === 'truth') withTruth = v !== '0';
  else if (k === 'out') out = v;
  else if (k === 'name') name = v;
  else throw new Error(`unknown option ${arg}`);
}

const run = simulateRun(track, sim);
const trackName = typeof run.meta.track === 'string' ? run.meta.track : track;
const pipeline = new DriftPipeline({
  ...pipe,
  id: `sim-${track}-s${seed}`,
  name: name || `${trackName} — ${run.meta.laps} lap${run.meta.laps === 1 ? '' : 's'}`,
  // deterministic wall clock: the same command always produces the same file
  startedAt: Date.UTC(2026, 0, 1, 9, 0, 0) + seed * 60_000,
});

// Feed motion and GPS interleaved in timestamp order, exactly as the app's sensor source does.
const gps = run.gps.slice().sort((a, b) => a.t - b.t);
let j = 0;
let calibrated = false;
const t0 = performance.now();
for (let i = 0; i < run.motion.length; i++) {
  const m = run.motion[i];
  while (j < gps.length && gps[j].t <= m.t) pipeline.pushGps(gps[j++]);
  // the driver taps "calibrate" while still parked (the run starts with `idleS` seconds of idle)
  if (stationaryAt > 0 && !calibrated && m.t >= stationaryAt) {
    pipeline.markStationary();
    calibrated = true;
  }
  pipeline.pushMotion(m);
}
const driveMs = performance.now() - t0;

const session = pipeline.finish({
  track,
  trackId: track,
  source: 'simulation',
  seed,
  laps: Number(run.meta.laps ?? laps),
  aggression: sim.aggression ?? 0.8,
  consistency: sim.consistency ?? 0.85,
  simMount: String(sim.mount ?? 'portrait-vent'),
  simGpsLatencyS: Math.round(run.gpsLatency * 1000) / 1000,
});
if (withTruth) session.truth = run.truth as TruthSample[];

const file = resolve(process.cwd(), out);
mkdirSync(dirname(file), { recursive: true });
const json = JSON.stringify(session);
writeFileSync(file, json);

// ---- summary on stderr (stdout stays free for piping) --------------------------------------
const d = pipeline.diagnostics;
const b = pipeline.breakdown;
const peakDeg = radToDeg(session.drifts.reduce((m, x) => Math.max(m, x.peakAngle), 0));
const lines = [
  `${file}  (${(json.length / 1048576).toFixed(2)} MB)`,
  `  run        ${trackName} seed ${seed}, ${run.meta.laps} lap(s), ${session.durationS.toFixed(1)} s, ${d.samples} samples, ${d.gpsSamples} fixes`,
  `  score      ${session.score.total} pts, grade ${session.score.grade}  (angle ${session.score.angle} · consistency ${session.score.consistency} ·` +
    ` quality ${session.score.quality} · speed ${session.score.speed} · style ${session.score.style}${b ? ` · combined ${b.combined}` : ''})`,
  `  drifts     ${session.drifts.length}, peak ${peakDeg.toFixed(1)}°, ${b ? b.transitions : 0} transitions, ${b ? b.spins : 0} spins,` +
    ` ${b ? b.driftTimeS.toFixed(1) : '0'} s sliding`,
  `  track      ${session.track ? `${session.track.closed ? 'closed' : 'open'}, ${session.track.lengthM.toFixed(0)} m, ${session.track.corners.length} corners, ${session.track.laps.length} laps` : 'none'}`,
  `  sensors    calibration q=${d.calibrationQuality.toFixed(2)} forward=${d.calibrationForwardResolved} mount=${d.mount} gps=${d.gps}` +
    ` dropped=${d.droppedSamples} nanGuards=${d.nanGuards}`,
  `  stored     ${session.states.length} states, ${session.motion.length} motion samples (${session.meta.motionHz} Hz), live ${(d.approxBytes / 1048576).toFixed(2)} MB`,
  `  timing     ${driveMs.toFixed(1)} ms for the run = ${((driveMs * 1000) / d.samples).toFixed(2)} µs/sample (budget at 100 Hz: 10 000 µs)`,
  `  integrity  "${d.integrityMessage}"`,
];
process.stderr.write(lines.join('\n') + '\n');
