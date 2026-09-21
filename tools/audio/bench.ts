/**
 * Drives a REAL simulated run through the REAL engine pipeline into the REAL feel layer, and
 * measures what the sound costs and when it speaks.
 *
 *   npx tsx tools/audio/bench.ts [track] [seed] [laps] [key=value ...]
 *     looseness=1 dropouts=1 aggression=0.95 consistency=0.5 voices=2 log=1 emit=1
 *
 * Reports four things:
 *
 *  1. DISPATCH LATENCY — nanoseconds between the frame arriving at `DriftFeel.frame()` and
 *     `SoundPort.play()` being called for it. This is the delay the feel layer itself adds
 *     between an event's timestamp and the play call; everything before it (sensor → pipeline)
 *     is the same path the drive display's flash and haptic already take, and everything after
 *     it belongs to the OS audio stack.
 *  2. THE 100 Hz BUDGET — the cost of a frame that fires nothing, which is the common case.
 *  3. THE RUN, AS HEARD — every decision the mixer took, in order, so the taxonomy and the
 *     voice stealing can be read rather than trusted.
 *  4. SEQUENCES — the real moments the `/sound` lab replays, FOUND in the run rather than typed
 *     out beside it, with the absolute time they happened at and the gaps between their cues.
 *
 * `emit=1` runs the same search over a declared grid of runs and writes
 * `src/ui/audio/sequences.ts`, which is what the lab reads. That file is generated for one
 * reason: the lab used to state "lap 2 at 100.08 s", "47.75 s" and "65.60 s: CHAIN LOST and SPIN
 * fire on the SAME frame" and cite this command for them, and none of the three was true of this
 * command's output — the flick triplet is at 30.40 s and 88.47 s, the exit→bank→link at 36.14 s,
 * and harbour seed 1 contains no spin at all. The relative offsets were right; the provenance was
 * invented. A screen asserting a measurement that did not happen is the failure this project has
 * been sent back for more than once, so the numbers now come out of the search and the file
 * records the exact command that reproduces each one.
 *
 * Nothing here is mocked except the two ports: the pipeline, the scorer, the detector, the bank
 * and the mixer are the ones the app ships.
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { DriftPipeline, type LiveFrame } from '../../src/engine/pipeline';
import { simulateRun, type TrackId } from '../../src/sim';
import { SOUND_BANK, specFor, type SoundId } from '../../src/ui/audio/bank';
import { DriftFeel } from '../../src/ui/audio/mixer';
import { CLIP_MEASUREMENTS } from '../../src/ui/audio/waveforms';

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
  // The whole run, not the last 64 decisions: this used to print "the first 60" of a window that
  // had already rotated past the start of the run.
  logLimit: Number.POSITIVE_INFINITY,
});
feel.attach(sound, haptics);
feel.setSettings(true, true);

// ── the run ───────────────────────────────────────────────────────────────────────────────────
const cueLatenciesNs: number[] = [];
const idleFrameNs: number[] = [];
let gi = 0;
let cues = 0;

let drifts = 0;
const sameFrameSpin: number[] = [];
for (const m of run.motion) {
  while (gi < run.gps.length && run.gps[gi].t <= m.t) pipe.pushGps(run.gps[gi++]);
  const f = pipe.pushMotion(m);
  if (f.completed !== null) drifts++;
  if (f.completed?.spin && f.score.lost) sameFrameSpin.push(f.t);
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
console.log(`\nCLIPS PLAYED  (${drifts} drifts completed)`);
for (const spec of SOUND_BANK) {
  const n = byClip[spec.id] ?? 0;
  if (n === 0) continue;
  const perDrift = drifts > 0 ? (n / drifts).toFixed(2) : '—';
  console.log(
    `  ${spec.id.padEnd(11)} x${String(n).padStart(3)}   every ${(durationS / n).toFixed(1)} s   ${perDrift}/drift   tier ${CLIP_MEASUREMENTS[spec.id]?.tier ?? '—'}   prio ${spec.priority}   ${spec.haptic ?? '—'}`,
  );
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

// ── 4. the sequences the `/sound` lab replays ─────────────────────────────────────────────────
/**
 * A pattern is a run of cues the mixer actually PLAYED, in order, inside a window — or, for the
 * spin, one frame carrying two events. Nothing here knows what the answer should be; it looks.
 */
interface RunSpec {
  track: TrackId;
  seed: number;
  laps: number;
  aggression?: number;
  consistency?: number;
}

const command = (r: RunSpec): string =>
  `npx tsx tools/audio/bench.ts ${r.track} ${r.seed} ${r.laps}` +
  (r.aggression !== undefined ? ` aggression=${r.aggression}` : '') +
  (r.consistency !== undefined ? ` consistency=${r.consistency}` : '');

interface Hit {
  atS: number;
  steps: Array<{ id: SoundId; atS: number }>;
}

/** Play a run and return what the mixer played, plus the frames where SPIN and CHAIN LOST met. */
function listen(r: RunSpec): { played: Array<{ id: SoundId; t: number }>; spinFrames: number[] } {
  const sim = simulateRun(r.track, { seed: r.seed, laps: r.laps, aggression: r.aggression, consistency: r.consistency });
  const p = new DriftPipeline({ id: 'seq', name: 'seq', startedAt: 0 });
  const out: Array<{ id: SoundId; t: number }> = [];
  const spinFrames: number[] = [];
  let t = 0;
  const f = new DriftFeel({ now: () => t, maxVoices: opts.voices ?? 2, log: false });
  f.attach({ play: (id: string) => (out.push({ id: id as SoundId, t }), true), stop: () => {}, setBed: () => {} }, { impact: () => {}, notify: () => {} });
  f.setSettings(true, true);
  let g = 0;
  for (const m of sim.motion) {
    while (g < sim.gps.length && sim.gps[g].t <= m.t) p.pushGps(sim.gps[g++]);
    const frame: LiveFrame = p.pushMotion(m);
    t = frame.t;
    if (frame.completed?.spin && frame.score.lost) spinFrames.push(frame.t);
    f.frame(frame);
  }
  return { played: out, spinFrames };
}

function findRun(played: Array<{ id: SoundId; t: number }>, ids: SoundId[], withinS: number): Hit | null {
  for (let i = 0; i + ids.length <= played.length; i++) {
    let ok = true;
    for (let k = 0; k < ids.length; k++) if (played[i + k].id !== ids[k]) ok = false;
    if (!ok) continue;
    const span = played[i + ids.length - 1].t - played[i].t;
    if (span > withinS) continue;
    return { atS: played[i].t, steps: ids.map((id, k) => ({ id, atS: +(played[i + k].t - played[i].t).toFixed(3) })) };
  }
  return null;
}

/** The runs the search walks, in order. The first one that contains a pattern is the one cited. */
const SEARCH: RunSpec[] = [
  { track: 'harbor', seed: 1, laps: 2 },
  { track: 'harbor', seed: 2, laps: 2 },
  { track: 'harbor', seed: 3, laps: 2 },
  { track: 'touge', seed: 1, laps: 2 },
  { track: 'touge', seed: 10, laps: 2 },
];

interface Found {
  key: string;
  label: string;
  command: string;
  atS: number | null;
  note: string;
  steps: Array<{ id: SoundId; atS: number }>;
}

const ms = (v: number) => (v < 1 ? `${Math.round(v * 1000)} ms` : `${v.toFixed(2)} s`);

function search(): Found[] {
  const found: Found[] = [];
  const heard = new Map<string, ReturnType<typeof listen>>();
  const hear = (r: RunSpec) => {
    const k = command(r);
    if (!heard.has(k)) heard.set(k, listen(r));
    return heard.get(k)!;
  };

  for (const r of SEARCH) {
    if (found.some((x) => x.key === 'flick')) break;
    const hit = findRun(hear(r).played, ['transition', 'manji', 'extreme'], 1.5);
    if (hit) {
      found.push({
        key: 'flick',
        label: 'The flick',
        command: command(r),
        atS: +hit.atS.toFixed(2),
        note: `at ${hit.atS.toFixed(2)} s: the whip on the phase edge, MANJI ${ms(hit.steps[1].atS)} later where the callout lands, gold at ${ms(hit.steps[2].atS)}`,
        steps: hit.steps,
      });
    }
  }
  for (const r of SEARCH) {
    if (found.some((x) => x.key === 'bank')) break;
    const hit = findRun(hear(r).played, ['exit', 'banked', 'link'], 4);
    if (hit) {
      found.push({
        key: 'bank',
        label: 'The bank',
        command: command(r),
        atS: +hit.atS.toFixed(2),
        note: `at ${hit.atS.toFixed(2)} s: the exit verdict, the chain banking ${ms(hit.steps[1].atS)} later, then the next drift opening as a LINK at ${ms(hit.steps[2].atS)}`,
        steps: hit.steps,
      });
    }
  }
  for (const r of SEARCH) {
    if (found.some((x) => x.key === 'lost')) break;
    const spins = hear(r).spinFrames;
    if (spins.length > 0) {
      found.push({
        key: 'lost',
        label: 'The spin',
        command: command(r),
        atS: +spins[0].toFixed(2),
        note: `at ${spins[0].toFixed(2)} s: CHAIN LOST and SPIN fire on the SAME frame — the cause outranks the consequence, so you hear one`,
        steps: [
          { id: 'lost', atS: 0 },
          { id: 'spin', atS: 0 },
        ],
      });
    }
  }
  // The only CONSTRUCTED entry, and it says so: three cues inside 150 ms is what the mixer is
  // for, and no run is obliged to hand one over.
  found.push({
    key: 'mud',
    label: 'Three at once',
    command: '',
    atS: null,
    note: 'constructed, not measured: three cues inside 150 ms against two voices — read the decisions below',
    steps: [
      { id: 'long', atS: 0 },
      { id: 'lap', atS: 0.07 },
      { id: 'spin', atS: 0.14 },
    ],
  });
  return found;
}

console.log('\nSEQUENCES ON THIS RUN  (what the /sound lab replays; `emit=1` writes src/ui/audio/sequences.ts)');
{
  const here = { played: played.map((x) => ({ id: x.id, t: x.at })), spinFrames: sameFrameSpin };
  const rows: Array<[string, Hit | null]> = [
    ['transition -> manji -> extreme', findRun(here.played, ['transition', 'manji', 'extreme'], 1.5)],
    ['exit -> banked -> link', findRun(here.played, ['exit', 'banked', 'link'], 4)],
  ];
  for (const [name, hit] of rows) {
    if (hit) console.log(`  ${name.padEnd(32)} at ${hit.atS.toFixed(2)} s   +${hit.steps.map((x) => x.atS.toFixed(3)).join(' +')}`);
    else console.log(`  ${name.padEnd(32)} not on this run`);
  }
  console.log(`  ${'lost + spin on one frame'.padEnd(32)} ${sameFrameSpin.length ? sameFrameSpin.map((t) => `${t.toFixed(2)} s`).join(', ') : 'not on this run'}`);
}

if ((opts.emit ?? 0) > 0) {
  const found = search();
  const lines: string[] = [];
  lines.push('/**');
  lines.push(' * GENERATED by `npx tsx tools/audio/bench.ts emit=1` — do not edit by hand.');
  lines.push(' *');
  lines.push(' * The sequences the `/sound` lab replays, FOUND in real runs through the real pipeline and');
  lines.push(' * the real mixer. Each one carries the command that reproduces it and the second of that run');
  lines.push(' * it happened at, because the lab used to state three timings that its own cited command did');
  lines.push(' * not produce — including a spin on a run that has none.');
  lines.push(' */');
  lines.push("import type { SoundId } from './bank';");
  lines.push('');
  lines.push('export interface SoundSequence {');
  lines.push('  key: string;');
  lines.push('  label: string;');
  lines.push('  /** The command that reproduces the run this was measured on. Empty when constructed. */');
  lines.push('  command: string;');
  lines.push('  /** Recording second of that run, or null for a constructed demonstration. */');
  lines.push('  atS: number | null;');
  lines.push('  note: string;');
  lines.push('  steps: ReadonlyArray<{ id: SoundId; atS: number }>;');
  lines.push('}');
  lines.push('');
  lines.push('export const SOUND_SEQUENCES: readonly SoundSequence[] = [');
  for (const f of found) {
    lines.push('  {');
    lines.push(`    key: ${JSON.stringify(f.key)},`);
    lines.push(`    label: ${JSON.stringify(f.label)},`);
    lines.push(`    command: ${JSON.stringify(f.command)},`);
    lines.push(`    atS: ${f.atS === null ? 'null' : f.atS},`);
    lines.push(`    note: ${JSON.stringify(f.note)},`);
    lines.push(`    steps: [${f.steps.map((s) => `{ id: ${JSON.stringify(s.id)}, atS: ${s.atS} }`).join(', ')}],`);
    lines.push('  },');
  }
  lines.push('];');
  lines.push('');
  const out = path.resolve(import.meta.dirname, '..', '..', 'src', 'ui', 'audio', 'sequences.ts');
  writeFileSync(out, lines.join('\n'));
  console.log('\nEMITTED');
  for (const f of found) console.log(`  ${f.key.padEnd(6)} ${f.command || '(constructed)'}   ${f.note}`);
  console.log('  -> src/ui/audio/sequences.ts');
}
