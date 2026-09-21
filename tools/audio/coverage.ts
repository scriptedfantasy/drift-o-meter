/**
 * Asks the REAL pipeline and the REAL mixer three questions the feel layer has been wrong about,
 * across several seeds and both tracks rather than one fixture.
 *
 *   npx tsx tools/audio/coverage.ts
 *
 *  1. CADENCE — how often each clip fires per DRIFT, which is the number that decides its tier.
 *     A clip in tier A (the loudest) that fires on most drifts is the rule in `src/ui/callouts.ts`
 *     — "an event that fires on every drift carries no news" — applied to colour and broken on
 *     loudness. This is the measurement that moved BANKED from tier A to tier B.
 *  2. THE LANDING — how many exit phase edges end with no beat, heard OR felt, inside 1.0 s and
 *     2.5 s. The exit used to have neither: its only row was bound to the `perfect-exit` callout,
 *     which the scorer withholds on most slides.
 *  3. A HAND-HELD RUN — how much the belief gate drops, and whether the driver is ever told why.
 *
 * Nothing here is mocked but the two ports. One fixture is not an answer: every row below is a
 * different seed, driver or track, and the columns are meant to be read against each other.
 */
import { DriftPipeline, type LiveFrame } from '../../src/engine/pipeline';
import { simulateRun, type TrackId } from '../../src/sim';
import { SOUND_BANK, type SoundId } from '../../src/ui/audio/bank';
import { DriftFeel } from '../../src/ui/audio/mixer';
import { CLIP_MEASUREMENTS } from '../../src/ui/audio/waveforms';

interface Case {
  track: TrackId;
  seed: number;
  laps: number;
  looseness?: number;
  dropouts?: boolean;
  aggression?: number;
  consistency?: number;
  label?: string;
}

const ACTIVE = new Set(['entry', 'drifting', 'transition']);

interface Beat {
  id: SoundId;
  t: number;
  /** True when it made a sound; a felt-only cue is still a beat. */
  heard: boolean;
}

function drive(c: Case) {
  const run = simulateRun(c.track, {
    seed: c.seed,
    laps: c.laps,
    looseness: c.looseness ?? 0,
    gpsDropouts: !!c.dropouts,
    aggression: c.aggression,
    consistency: c.consistency,
  });
  const pipe = new DriftPipeline({ id: 'cov', name: 'cov', startedAt: 0 });
  let t = 0;
  const beats: Beat[] = [];
  const haptics: Array<{ shape: string; t: number }> = [];
  const feel = new DriftFeel({ now: () => t, maxVoices: 2, log: false });
  feel.attach(
    {
      play: (id: string) => {
        beats.push({ id: id as SoundId, t, heard: true });
        return true;
      },
      stop: () => {},
      setBed: () => {},
    },
    {
      impact: (shape: string) => haptics.push({ shape, t }),
      notify: (shape: string) => haptics.push({ shape, t }),
    },
  );
  feel.setSettings(true, true);

  let gi = 0;
  let prevPhase = 'idle';
  let drifts = 0;
  const exitEdges: Array<{ t: number; believable: boolean }> = [];
  let entryEdges = 0;
  let initiationCallouts = 0;
  for (const m of run.motion) {
    while (gi < run.gps.length && run.gps[gi].t <= m.t) pipe.pushGps(run.gps[gi++]);
    const f: LiveFrame = pipe.pushMotion(m);
    t = f.t;
    const before = haptics.length;
    feel.frame(f);
    // A cue with no clip never reaches `play()`, so the haptic it fired IS the beat.
    for (let i = before; i < haptics.length; i++) {
      if (!beats.some((b) => b.t === haptics[i].t && b.heard)) beats.push({ id: 'exit-edge', t: haptics[i].t, heard: false });
    }
    const active = ACTIVE.has(f.phase);
    if (active && !ACTIVE.has(prevPhase)) entryEdges++;
    if (!active && ACTIVE.has(prevPhase)) exitEdges.push({ t: f.t, believable: f.integrity.believable });
    if (f.completed !== null) drifts++;
    for (const co of f.score.callouts) if (co.kind === 'initiation') initiationCallouts++;
    prevPhase = f.phase;
  }
  const durationS = run.motion[run.motion.length - 1].t - run.motion[0].t;
  return { feel, beats, haptics, exitEdges, entryEdges, drifts, durationS, initiationCallouts };
}

const label = (c: Case) =>
  c.label ??
  `${c.track} s${c.seed} ${c.laps}L` +
    (c.aggression !== undefined ? ` agg=${c.aggression}` : '') +
    (c.consistency !== undefined ? ` con=${c.consistency}` : '') +
    (c.looseness ? ` loose=${c.looseness}` : '') +
    (c.dropouts ? ' drop' : '');

const CLEAN: Case[] = [
  { track: 'harbor', seed: 1, laps: 2 },
  { track: 'harbor', seed: 2, laps: 2 },
  { track: 'harbor', seed: 3, laps: 2 },
  { track: 'touge', seed: 1, laps: 2 },
  { track: 'touge', seed: 3, laps: 2 },
  { track: 'touge', seed: 7, laps: 2 },
  { track: 'harbor', seed: 5, laps: 2, aggression: 0.05, label: 'harbor s5 timid' },
  { track: 'touge', seed: 10, laps: 2, label: 'touge s10 (spins)' },
];

const HANDHELD: Case[] = [
  { track: 'harbor', seed: 1, laps: 2, looseness: 1, dropouts: true },
  { track: 'touge', seed: 1, laps: 2, looseness: 1, dropouts: true },
  { track: 'harbor', seed: 1, laps: 2, looseness: 1 },
  { track: 'touge', seed: 1, laps: 2, looseness: 1 },
  { track: 'harbor', seed: 1, laps: 1, looseness: 1, dropouts: true },
];

const pad = (v: unknown, n: number) => String(v).padEnd(n);
const padL = (v: unknown, n: number) => String(v).padStart(n);

// ── 1. cadence ────────────────────────────────────────────────────────────────────────────────
console.log('\n1. CADENCE — plays per completed drift, by clip and tier');
{
  const runs = CLEAN.map((c) => ({ c, r: drive(c) }));
  const header = ['clip', 'tier', ...runs.map(({ c }) => label(c).split(' ').slice(0, 2).join(''))];
  console.log(pad(header[0], 12) + pad(header[1], 6) + header.slice(2).map((h) => padL(h, 11)).join('') + padL('worst', 8));
  console.log('-'.repeat(12 + 6 + runs.length * 11 + 8));
  for (const spec of SOUND_BANK) {
    const per = runs.map(({ r }) => {
      const n = r.beats.filter((b) => b.id === spec.id && b.heard).length;
      return r.drifts > 0 ? n / r.drifts : 0;
    });
    const worst = Math.max(...per);
    if (worst === 0) continue;
    console.log(
      pad(spec.id, 12) +
        pad(CLIP_MEASUREMENTS[spec.id]?.tier ?? '—', 6) +
        per.map((v) => padL(v.toFixed(2), 11)).join('') +
        padL(worst.toFixed(2), 8),
    );
  }
  console.log('\n   runs: ' + runs.map(({ c, r }) => `${label(c)} (${r.drifts} drifts, ${r.durationS.toFixed(0)} s)`).join(' · '));
  const tierA = SOUND_BANK.filter((s) => CLIP_MEASUREMENTS[s.id]?.tier === 'A');
  const worstA = Math.max(
    0,
    ...tierA.map((s) => Math.max(...runs.map(({ r }) => (r.drifts > 0 ? r.beats.filter((b) => b.id === s.id && b.heard).length / r.drifts : 0)))),
  );
  console.log(`   tier A is ${tierA.map((s) => s.id).join(', ')} — worst cadence across these runs: ${worstA.toFixed(2)} per drift`);
}

// ── 2. the landing ────────────────────────────────────────────────────────────────────────────
console.log('\n2. THE LANDING — exit phase edges with no beat (heard OR felt) after them');
console.log(pad('case', 22) + padL('exits', 7) + padL('believed', 9) + padL('felt beats', 11) + padL('p-exit', 8) + padL('none<1.0s', 11) + padL('none<2.5s', 11));
console.log('-'.repeat(79));
for (const c of CLEAN) {
  const r = drive(c);
  let none1 = 0;
  let none25 = 0;
  const believed = r.exitEdges.filter((e) => e.believable);
  for (const e of believed) {
    const within = (w: number) => r.beats.some((b) => b.t >= e.t - 1e-9 && b.t <= e.t + w);
    if (!within(1.0)) none1++;
    if (!within(2.5)) none25++;
  }
  console.log(
    pad(label(c), 22) +
      padL(r.exitEdges.length, 7) +
      padL(believed.length, 9) +
      padL(r.haptics.filter((h) => h.shape === 'light').length, 11) +
      padL(r.beats.filter((b) => b.id === 'exit').length, 8) +
      padL(none1, 11) +
      padL(none25, 11),
  );
}

// ── 3. a hand-held run ────────────────────────────────────────────────────────────────────────
console.log('\n3. A HAND-HELD RUN — what the belief gate drops, and whether the driver is told');
console.log(pad('case', 30) + padL('cues', 7) + padL('played', 8) + padL('haptics', 9) + padL('entryEdges', 12) + padL('FAULT at', 10) + padL('clips', 14));
console.log('-'.repeat(90));
for (const c of HANDHELD) {
  const r = drive(c);
  const fault = r.beats.find((b) => b.id === 'fault');
  const clips = [...new Set(r.beats.filter((b) => b.heard).map((b) => b.id))].join(',') || '—';
  console.log(
    pad(label(c), 30) +
      padL(r.feel.stats.cues, 7) +
      padL(r.beats.filter((b) => b.heard).length, 8) +
      padL(r.haptics.length, 9) +
      padL(r.entryEdges, 12) +
      padL(fault ? `${fault.t.toFixed(2)}s` : 'never', 10) +
      padL(clips, 14),
  );
}
console.log('\n   and the same question of a run the engine DOES believe (a FAULT here would be a false alarm):');
for (const c of CLEAN.slice(0, 4)) {
  const r = drive(c);
  const fault = r.beats.find((b) => b.id === 'fault');
  console.log(`   ${pad(label(c), 22)} FAULT ${fault ? `at ${fault.t.toFixed(2)} s` : 'never'}   RECOVERED ${r.beats.some((b) => b.id === 'recovered') ? 'yes' : 'never'}`);
}
console.log('');
