/**
 * Drives a REAL simulated run through the REAL engine pipeline into the REAL feel layer, and
 * measures what the sound costs and when it speaks.
 *
 *   npx tsx tools/audio/bench.ts [track] [seed] [laps] [key=value ...]
 *     looseness=1 dropouts=1 aggression=0.95 consistency=0.5 voices=2 log=1
 *
 * Reports three things:
 *
 *  1. DISPATCH LATENCY — nanoseconds between the frame arriving at `DriftFeel.frame()` and
 *     `SoundPort.play()` being called for it. This is the delay the feel layer itself adds
 *     between an event's timestamp and the play call; everything before it (sensor → pipeline)
 *     is the same path the drive display's flash and haptic already take, and everything after
 *     it belongs to the OS audio stack.
 *  2. THE 100 Hz BUDGET — the cost of a frame that fires nothing, which is the common case.
 *  3. THE RUN, AS HEARD — every decision the mixer took, in order, so the taxonomy and the
 *     voice stealing can be read rather than trusted.
 *
 * Nothing here is mocked except the two ports: the pipeline, the scorer, the detector, the bank
 * and the mixer are the ones the app ships.
 */
import { performance } from 'node:perf_hooks';

import { DriftPipeline } from '../../src/engine/pipeline';
import { simulateRun, type TrackId } from '../../src/sim';
import { SOUND_BANK, specFor, type SoundId } from '../../src/ui/audio/bank';
import { DriftFeel } from '../../src/ui/audio/mixer';

const args = process.argv.slice(2);
const track = ((args[0] && !args[0].includes('=') ? args[0] : 'harbor') as TrackId) ?? 'harbor';
const opts: Record<string, number> = {};
for (const a of args) {
  const [k, v] = a.split('=');
  if (v !== undefined) opts[k] = Number(v);
}
const seed = args[1] && !args[1].includes('=') ? Number(args[1]) : 1;
const laps = args[2] && !args[2].includes('=') ? Number(args[2]) : 2;

const run = simulateRun(track, {
  seed,
  laps,
  looseness: opts.looseness ?? 0,
  gpsDropouts: (opts.dropouts ?? 0) > 0,
  aggression: opts.aggression,
  consistency: opts.consistency,
});
const pipe = new DriftPipeline({ id: 'bench', name: 'bench', startedAt: 0 });

// ── the ports, instrumented ───────────────────────────────────────────────────────────────────
let playCount = 0;
let stopCount = 0;
let bedPushes = 0;
/** Set by the port the instant `play()` is entered — the end of the interval being measured. */
let playAt = 0;
const played: Array<{ id: SoundId; at: number }> = [];
let frameT = 0;

const sound = {
  play(id: string): boolean {
    playAt = performance.now();
    playCount++;
    played.push({ id: id as SoundId, at: frameT });
    return true;
  },
  stop(_id: string): void {
    stopCount++;
  },
  setBed(_low: number, _high: number): void {
    bedPushes++;
  },
};

const haptics = {
  impact(shape: string): void {
    hapticCount[shape] = (hapticCount[shape] ?? 0) + 1;
  },
  notify(shape: string): void {
    hapticCount[shape] = (hapticCount[shape] ?? 0) + 1;
  },
};
const hapticCount: Record<string, number> = {};

/**
 * The clock the mixer sees is the RECORDING clock, which is what a 1x playback on a phone gives
 * it: the device sensor adapter stamps every sample with `clock.now()` at delivery, so recording
 * time and wall time are the same thing there. Driving the mixer off `performance.now()` here
 * instead would replay 130 s of run in 0.3 s and every debounce window and voice lifetime would
 * be a hundred times too long — which is a real property of the design (see MAX_PLAY_RATE), not
 * something to measure the design with.
 *
 * The LATENCY numbers are still taken from `performance.now()`, because they are about how long
 * the code takes, not about when the run happened.
 */
const feel = new DriftFeel({
  now: () => frameT,
  maxVoices: opts.voices ?? 2,
  log: true,
});
feel.attach(sound, haptics);
feel.setSettings(true, true);

// ── the run ───────────────────────────────────────────────────────────────────────────────────
const cueLatenciesNs: number[] = [];
const idleFrameNs: number[] = [];
let gi = 0;
let cues = 0;

for (const m of run.motion) {
  while (gi < run.gps.length && run.gps[gi].t <= m.t) pipe.pushGps(run.gps[gi++]);
  const f = pipe.pushMotion(m);
  frameT = f.t;
  const before = playCount;
  playAt = 0;
  const t0 = performance.now();
  feel.frame(f);
  const t1 = performance.now();
  if (playCount > before) {
    cues++;
    cueLatenciesNs.push((playAt - t0) * 1e6);
  } else {
    idleFrameNs.push((t1 - t0) * 1e6);
  }
}

// ── the numbers ───────────────────────────────────────────────────────────────────────────────
function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}
const cueSorted = cueLatenciesNs.slice().sort((a, b) => a - b);
const idleSorted = idleFrameNs.slice().sort((a, b) => a - b);
const durationS = run.motion[run.motion.length - 1].t - run.motion[0].t;

const head = `${track} seed=${seed} laps=${laps}${opts.looseness ? ` looseness=${opts.looseness}` : ''}${opts.dropouts ? ' dropouts=1' : ''}`;
console.log(`\n=== ${head} — ${durationS.toFixed(1)} s, ${run.motion.length} frames at ${(run.motion.length / durationS).toFixed(0)} Hz`);

console.log('\nDISPATCH LATENCY  (frame arrives at DriftFeel.frame() -> SoundPort.play() entered)');
console.log(`  n=${cueSorted.length}   p50 ${pct(cueSorted, 0.5).toFixed(0)} ns   p90 ${pct(cueSorted, 0.9).toFixed(0)} ns   p99 ${pct(cueSorted, 0.99).toFixed(0)} ns   max ${Math.max(...cueLatenciesNs).toFixed(0)} ns`);
console.log(`  = p50 ${(pct(cueSorted, 0.5) / 1e6).toFixed(4)} ms, max ${(Math.max(...cueLatenciesNs) / 1e6).toFixed(4)} ms`);

console.log('\n100 Hz BUDGET  (a frame that fires nothing: the common case)');
console.log(`  n=${idleSorted.length}   p50 ${pct(idleSorted, 0.5).toFixed(0)} ns   p99 ${pct(idleSorted, 0.99).toFixed(0)} ns   max ${Math.max(...idleFrameNs).toFixed(0)} ns`);
console.log(`  total time in DriftFeel.frame() over the whole run: ${((idleFrameNs.reduce((a, b) => a + b, 0) + cueLatenciesNs.reduce((a, b) => a + b, 0)) / 1e9).toFixed(4)} s of ${durationS.toFixed(1)} s`);

console.log('\nWHAT THE MIXER DID');
console.log(`  cues offered ${feel.stats.cues}   played ${feel.stats.played}   dropped ${feel.stats.dropped}   voices stolen ${feel.stats.stolen}`);
console.log(`  port: play ${playCount}  stop ${stopCount}  setBed ${bedPushes} (${(bedPushes / durationS).toFixed(1)}/s)`);
console.log(`  haptics: ${Object.entries(hapticCount).map(([k, v]) => `${k}=${v}`).join(' ') || 'none'}`);

const byClip: Record<string, number> = {};
for (const p of played) byClip[p.id] = (byClip[p.id] ?? 0) + 1;
console.log('\nCLIPS PLAYED');
for (const spec of SOUND_BANK) {
  const n = byClip[spec.id] ?? 0;
  if (n === 0) continue;
  console.log(`  ${spec.id.padEnd(11)} x${String(n).padStart(3)}   every ${(durationS / n).toFixed(1)} s   prio ${spec.priority}   ${spec.haptic ?? '—'}`);
}
const silent = SOUND_BANK.filter((s) => (byClip[s.id] ?? 0) === 0).map((s) => s.id);
if (silent.length > 0) console.log(`  never fired on this run: ${silent.join(', ')}`);

if ((opts.log ?? 1) > 0) {
  console.log('\nTHE RUN, AS HEARD  (first 60 decisions)');
  const t0 = feel.decisions.length > 0 ? feel.decisions[0].t : 0;
  for (const d of feel.decisions.slice(0, 60)) {
    const spec = specFor(d.id);
    const against = d.against ? ` vs ${d.against}` : '';
    console.log(`  +${(d.t - t0).toFixed(2).padStart(7)} s  ${d.id.padEnd(11)} ${d.outcome.padEnd(9)}${against.padEnd(16)} ${d.haptic ? `haptic:${d.haptic}` : ''}  ${spec ? `prio ${spec.priority}` : ''}`);
  }
  if (feel.decisions.length > 60) console.log(`  … ${feel.decisions.length - 60} more (the log keeps the last 64)`);
}
