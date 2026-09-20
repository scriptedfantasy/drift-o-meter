/**
 * Dump a simulated run (sensor streams + ground truth) as JSON for analysis/plotting.
 * usage: npx tsx tools/analysis/dump-run.ts <harbor|touge> [seed] [laps] [mount] > artifacts/run.json
 */
import { simulateRun, type TrackId } from '../../src/sim';

const track = (process.argv[2] ?? 'harbor') as TrackId;
const seed = Number(process.argv[3] ?? 1);
const laps = Number(process.argv[4] ?? 1);
const mount = (process.argv[5] ?? 'portrait-vent') as 'portrait-vent' | 'landscape-dash' | 'flat-console' | 'random';
const run = simulateRun(track, { seed, laps, mount });
process.stdout.write(JSON.stringify(run));
