/**
 * What a season of driving costs this phone, and what drawing the garage reads to show it.
 *
 *   npx tsx tools/analysis/storage-census.ts            # every section
 *   npx tsx tools/analysis/storage-census.ts reads      # one section
 *   npx tsx tools/analysis/storage-census.ts --runs 100 # a bigger season
 *
 * This file exists because of `docs/DESIGN.md`'s correction block. The garage's own docstrings
 * carry numbers — "5.75 MB of JSON per run where it needed 87 KB", "about 31 ms of parsing
 * each", "no session body is read to draw a row" — and the last time a measured claim lived only
 * in a comment (the calibrator's 0.74 ceiling) it was wrong, it travelled into two more files,
 * and it survived two rounds. The rule that came out of that episode is that a measurement is a
 * committed, re-runnable tool rather than a number someone remembers.
 *
 * The claim that matters most is an ABSENCE — that drawing the home screen parses no session
 * body at all — and an absence cannot be shown by an example (docs/CRITIC.md, rule 15). So the
 * store here is built over a backend that COUNTS every read, the whole index-only render path is
 * run over it, and the count is printed. `bodyReads` is the number to read.
 *
 * Everything is the app's own code: `createSessionStore` is the store the app runs,
 * `summarizeSession` writes the entries, and the render path below is the set of pure functions
 * `useGarage`, `SessionCards` and `BestsBoard` call. The body-reading path (`lastRun.ts`) is
 * deliberately absent, because it only runs when a row is TAPPED.
 */
import { createMemoryBackend, createSessionStore, summarizeSession, type SessionBackend, type SessionIndexEntry } from '../../src/platform/sessionStore';
import type { Session } from '../../src/engine/types';
import { mountAdvice } from '../../src/ui/garage/advice';
import { lastRunStanding, personalBests } from '../../src/ui/garage/bests';
import { gradeStateOf } from '../../src/ui/garage/grade';
import { groupByNight } from '../../src/ui/garage/groups';
import { angleText, pointsText, rowFootnote, slidesText } from '../../src/ui/garage/labels';
import { traceBars, traceLegend } from '../../src/ui/garage/trace';
import { buildFixtureSession, FIXTURES } from '../../src/ui/results/fixture';

// ---- the counting backend -------------------------------------------------------------------

interface Counts {
  indexReads: number;
  bodyReads: number;
  bodyIdLists: number;
  bytesRead: number;
}

function countingBackend(): { backend: SessionBackend; counts: Counts; bodies: Map<string, string>; indexJson(): string | null } {
  const inner = createMemoryBackend();
  const counts: Counts = { indexReads: 0, bodyReads: 0, bodyIdLists: 0, bytesRead: 0 };
  const backend: SessionBackend = {
    async readIndex() {
      counts.indexReads++;
      const raw = await inner.readIndex();
      counts.bytesRead += raw ? Buffer.byteLength(raw, 'utf8') : 0;
      return raw;
    },
    writeIndex: (json) => inner.writeIndex(json),
    async readBody(id) {
      counts.bodyReads++;
      const raw = await inner.readBody(id);
      counts.bytesRead += raw ? Buffer.byteLength(raw, 'utf8') : 0;
      return raw;
    },
    writeBody: (id, json) => inner.writeBody(id, json),
    deleteBody: (id) => inner.deleteBody(id),
    async listBodyIds() {
      counts.bodyIdLists++;
      return inner.listBodyIds();
    },
  };
  return { backend, counts, bodies: inner.bodies, indexJson: () => inner.index };
}

// ---- a season of runs -----------------------------------------------------------------------

/**
 * The cheap ground-truth fixtures, cycled with a distinct seed per run so no two sessions are
 * the same recording. Bodies are TRIMMED exactly as `src/ui/garage/demo.ts` trims them and as a
 * stored demo run really is — the sample arrays are what makes a full session ~10 MB, and they
 * are not what the garage reads.
 */
const FLAVOURS = ['spin', 'sloppy', 'touge', 'clean'] as const;

function trim(session: Session): Session {
  return { ...session, motion: [], gps: [], states: session.states.length > 0 ? [session.states[0]] : [], truth: undefined };
}

function buildSeason(runs: number, trimmed: boolean): Session[] {
  const out: Session[] = [];
  for (let i = 0; i < runs; i++) {
    const flavour = FLAVOURS[i % FLAVOURS.length];
    const session = buildFixtureSession({ ...FIXTURES[flavour], seed: i + 1 });
    // Distinct ids: the fixtures all build as `fixture-<name>`, and a season has distinct runs.
    const dated = { ...session, id: `season-${String(i).padStart(3, '0')}`, startedAt: session.startedAt + i * 60_000 };
    out.push(trimmed ? trim(dated) : dated);
  }
  return out;
}

interface Drawn {
  rows: number;
  nights: number;
  records: number;
  /** Total marks on all the slide traces — the plot really is built, not just counted. */
  marks: number;
}

/** Everything the garage draws, from the index alone. */
function drawGarage(entries: SessionIndexEntry[]): Drawn {
  const bests = personalBests(entries);
  const last = entries[0] ?? null;
  lastRunStanding(bests, last);
  mountAdvice(last);
  const nights = groupByNight(entries.slice(1));
  let rows = 0;
  let marks = 0;
  for (const entry of entries) {
    const state = gradeStateOf(entry.grade, entry.trusted);
    const untrusted = state.kind === 'void';
    angleText(entry, untrusted);
    slidesText(entry, untrusted);
    pointsText(entry, state.kind);
    rowFootnote(entry, state.kind);
    traceLegend(entry.slides, { believed: !untrusted });
    marks += traceBars(entry.slides, { believed: !untrusted }).length;
    rows++;
  }
  return { rows, nights: nights.length, records: bests.reduce((a, t) => a + t.records.length, 0), marks };
}

/**
 * The same device opened cold: same index, same bodies, nothing cached, counters at zero. The
 * copy happens before the counters are reset, so only what the RENDER does is counted.
 */
async function coldOpen(source: SessionBackend): Promise<ReturnType<typeof countingBackend> & { store: ReturnType<typeof createSessionStore> }> {
  const fresh = countingBackend();
  await fresh.backend.writeIndex((await source.readIndex()) ?? '');
  for (const id of (await source.listBodyIds?.()) ?? []) {
    const raw = await source.readBody(id);
    if (raw !== null) await fresh.backend.writeBody(id, raw);
  }
  const store = createSessionStore(fresh.backend);
  fresh.counts.indexReads = 0;
  fresh.counts.bodyReads = 0;
  fresh.counts.bodyIdLists = 0;
  fresh.counts.bytesRead = 0;
  return { ...fresh, store };
}

// ---- reporting -------------------------------------------------------------------------------

function kb(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
  return sorted[i];
}

// ---- sections --------------------------------------------------------------------------------

async function census(runs: number): Promise<void> {
  const { backend, bodies, indexJson } = countingBackend();
  const store = createSessionStore(backend);
  const season = buildSeason(runs, true);
  for (const session of season) await store.saveSession(session);

  let bodyBytes = 0;
  let biggestBody = 0;
  for (const raw of bodies.values()) {
    const n = Buffer.byteLength(raw, 'utf8');
    bodyBytes += n;
    biggestBody = Math.max(biggestBody, n);
  }
  const index = indexJson() ?? '';
  const indexBytes = Buffer.byteLength(index, 'utf8');
  const entries = await store.listSessions();
  const slideBytes = entries.reduce((a, e) => a + Buffer.byteLength(JSON.stringify(e.slides), 'utf8'), 0);

  // What the index would have cost if the garage still had to read bodies to draw a row.
  const untrimmed = buildFixtureSession({ ...FIXTURES.spin, seed: 1 });
  const fullBytes = Buffer.byteLength(JSON.stringify(untrimmed), 'utf8');

  console.log(`\nSTORAGE CENSUS — ${runs} stored runs (bodies trimmed, as a stored run is)`);
  console.log(`  bodies on device      ${mb(bodyBytes)}   (${kb(bodyBytes / runs)} each, biggest ${kb(biggestBody)})`);
  console.log(`  index                 ${indexBytes.toLocaleString()} B   (${Math.round(indexBytes / runs)} B per entry)`);
  console.log(`  of which slide traces ${slideBytes.toLocaleString()} B   (${Math.round(slideBytes / runs)} B per entry, ${Math.round((slideBytes / indexBytes) * 100)}% of the index)`);
  console.log(`  index / bodies        ${((indexBytes / bodyBytes) * 100).toFixed(2)}%`);
  console.log(`  an UNTRIMMED session  ${mb(fullBytes)}   — what a row cost to draw before the index carried the facts`);
  console.log(`                        ${mb(fullBytes * runs)} parsed per open, at ${runs} runs`);
}

async function reads(runs: number): Promise<void> {
  const { backend } = countingBackend();
  const store = createSessionStore(backend);
  for (const session of buildSeason(runs, true)) await store.saveSession(session);

  const cold = await coldOpen(backend);
  const t0 = performance.now();
  const entries = await cold.store.listSessions();
  const listMs = performance.now() - t0;
  const drawn = drawGarage(entries);
  const diagnosis = await cold.store.diagnose();

  console.log(`\nWHAT DRAWING THE GARAGE READS — ${runs} stored runs, cold open`);
  console.log(`  rows drawn            ${drawn.rows}   (${drawn.nights} night${drawn.nights === 1 ? '' : 's'}, ${drawn.records} records, ${drawn.marks} slide marks)`);
  console.log(`  bodyReads             ${cold.counts.bodyReads}        <- the claim: a row is drawn from the index alone`);
  console.log(`  indexReads            ${cold.counts.indexReads}`);
  console.log(`  bodyIdLists           ${cold.counts.bodyIdLists}        (diagnose() reads key NAMES, never bodies)`);
  console.log(`  bytes read            ${cold.counts.bytesRead.toLocaleString()} B  (${mb(cold.counts.bytesRead)})`);
  console.log(`  listSessions()        ${listMs.toFixed(3)} ms`);
  console.log(`  diagnosis             index ${diagnosis.index}, ${diagnosis.recordings} recordings, ephemeral ${diagnosis.ephemeral}`);
  if (cold.counts.bodyReads !== 0) console.log('  *** A BODY WAS READ TO DRAW THE LIST — the garage is parsing recordings again ***');
}

async function orphans(runs: number): Promise<void> {
  const { backend, bodies } = countingBackend();
  const store = createSessionStore(backend);
  for (const session of buildSeason(runs, true)) await store.saveSession(session);

  // Every body deleted from under a perfectly good index: the rows still have to draw, because
  // everything a row says lives in the index. This is the state the garage is in after a
  // browser evicts site data, and the one that used to blank the list.
  const keep = Math.max(1, Math.floor(runs / 8));
  const ids = [...bodies.keys()];
  for (const id of ids.slice(keep)) await backend.deleteBody(id);

  const cold = await coldOpen(backend);
  const entries = await cold.store.listSessions();
  const drawn = drawGarage(entries);
  const withAngle = entries.filter((e) => angleText(e, !e.trusted) !== '--').length;
  const diagnosis = await cold.store.diagnose();

  console.log(`\nROWS WITH NO RECORDING BEHIND THEM — ${runs - keep} of ${runs} bodies deleted`);
  console.log(`  rows drawn            ${drawn.rows} of ${entries.length}`);
  console.log(`  bodies left on device ${diagnosis.recordings}`);
  console.log(`  rows printing an angle ${withAngle}`);
  console.log(`  slide marks drawn     ${drawn.marks}`);
  console.log(`  bodyReads             ${cold.counts.bodyReads}`);
}

async function parse(runs: number): Promise<void> {
  const { backend, indexJson } = countingBackend();
  const store = createSessionStore(backend);
  for (const session of buildSeason(runs, true)) await store.saveSession(session);
  const base = JSON.parse(indexJson() ?? '{}') as { version: 1; entries: SessionIndexEntry[] };

  console.log(`\nWHAT THE INDEX COSTS TO PARSE — the one parse a cold open does`);
  console.log('  runs    index bytes    median ms     p95 ms');
  for (const n of [10, 25, 50, 100, 200].filter((n) => n <= Math.max(runs, 200))) {
    // Entries cycled to length: an entry's SIZE is what a parse costs, and they differ only in
    // id, date and trace, all of which are carried through from the real ones.
    const entries: SessionIndexEntry[] = [];
    for (let i = 0; i < n; i++) {
      const src = base.entries[i % base.entries.length];
      entries.push({ ...src, id: `season-${String(i).padStart(3, '0')}`, startedAt: src.startedAt + i * 60_000 });
    }
    const json = JSON.stringify({ version: 1, entries });
    const bytes = Buffer.byteLength(json, 'utf8');
    const samples: number[] = [];
    for (let k = 0; k < 200; k++) {
      const t = performance.now();
      JSON.parse(json);
      samples.push(performance.now() - t);
    }
    samples.sort((a, b) => a - b);
    console.log(`  ${String(n).padStart(4)}  ${String(bytes.toLocaleString()).padStart(12)}   ${quantile(samples, 0.5).toFixed(4).padStart(9)}  ${quantile(samples, 0.95).toFixed(4).padStart(9)}`);
  }
}

// ---- entry point ------------------------------------------------------------------------------

const SECTIONS: Record<string, (runs: number) => Promise<void>> = { census, reads, orphans, parse };

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const runsAt = argv.indexOf('--runs');
  const runs = runsAt >= 0 ? Math.max(1, Math.round(Number(argv[runsAt + 1]))) : 50;
  const wanted = argv.filter((a) => a in SECTIONS);
  const names = wanted.length ? wanted : Object.keys(SECTIONS);
  for (const name of names) await SECTIONS[name](runs);
  console.log('');
}

void main();
