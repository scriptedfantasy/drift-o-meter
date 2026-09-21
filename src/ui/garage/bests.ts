/**
 * Personal bests, per track, derived from what is actually stored.
 *
 * Four records a driver recognises: best grade, most points, biggest angle, longest chain.
 * Only runs the engine vouched for can hold one — a score it refuses to publish is not an
 * achievement (see the contract on `SessionIntegrity.scoreTrusted`), so an untrusted run is
 * counted as a run and never as a record. Pure: a screen can render it, a test can check it.
 *
 * `lastRunStanding` is the other half of a career screen's job: not only what the records are,
 * but what the run you just did DID to them.
 */
import type { Grade } from '../../engine/types';
import type { SessionIndexEntry } from '../../platform';

export type RecordKey = 'grade' | 'points' | 'angle' | 'chain';

export interface BestRecord {
  key: RecordKey;
  /** Uppercase label for the tile. */
  label: string;
  /** The record itself, formatted. */
  value: string;
  /** The record as a number (grade ordinal for `grade`), so a screen can compare against it. */
  amount: number;
  /** The run that holds it. */
  id: string;
  when: number;
  /** Extra params that reproduce a demo run on the results screen. */
  query: string;
  /** True when nothing has been earned yet (the tile is a dash, not a boast). */
  empty: boolean;
  /** Why this number is what it is, when it would otherwise look like a repeat. */
  note?: string;
}

export interface TrackBests {
  track: string;
  /** Every stored run on this track, trusted or not. */
  runs: number;
  /** Runs the engine vouched for — the only ones that can hold a record. */
  scored: number;
  /** Newest run on this track, ms since epoch. */
  lastAt: number;
  records: BestRecord[];
  /**
   * Set when the board is not yet a board. With one scored run every record is that run, so it
   * says so — a record panel that silently repeats the row underneath it is not a record panel.
   */
  framing: string | null;
}

const GRADE_ORDER: Record<Grade, number> = { D: 0, C: 1, B: 2, A: 3, S: 4 };

export const UNTRACKED = 'Unnamed road';

function fmtPoints(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

/** The name a run is filed under on the board. */
export function trackKeyOf(entry: Pick<SessionIndexEntry, 'track'>): string {
  return entry.track && entry.track.trim() ? entry.track : UNTRACKED;
}

interface Candidate {
  entry: SessionIndexEntry;
}

function pick(cands: Candidate[], score: (c: Candidate) => number): { c: Candidate; v: number } | null {
  let best: { c: Candidate; v: number } | null = null;
  for (const c of cands) {
    const v = score(c);
    if (!Number.isFinite(v) || v <= 0) continue;
    if (!best || v > best.v || (v === best.v && c.entry.startedAt > best.c.entry.startedAt)) best = { c, v };
  }
  return best;
}

function record(key: RecordKey, label: string, hit: { c: Candidate; v: number } | null, format: (v: number) => string): BestRecord {
  if (!hit) return { key, label, value: '--', amount: 0, id: '', when: 0, query: '', empty: true };
  return { key, label, value: format(hit.v), amount: hit.v, id: hit.c.entry.id, when: hit.c.entry.startedAt, query: '', empty: false };
}

/**
 * Group the stored runs by track and find the four records on each. Tracks come back with the
 * most recently driven first, so the board reads like a logbook rather than an alphabet.
 *
 * Reads the index and nothing else — `trusted`, `heldPeakDeg` and `longestChainPoints` all
 * live there now, so a board of twenty runs costs no JSON parsing at all.
 */
export function personalBests(entries: readonly SessionIndexEntry[]): TrackBests[] {
  const byTrack = new Map<string, Candidate[]>();
  for (const entry of entries) {
    const track = trackKeyOf(entry);
    const list = byTrack.get(track);
    if (list) list.push({ entry });
    else byTrack.set(track, [{ entry }]);
  }

  const out: TrackBests[] = [];
  for (const [track, all] of byTrack) {
    const scored = all.filter((c) => c.entry.trusted);
    const gradeHit = pick(scored, (c) => GRADE_ORDER[c.entry.grade] + 1);
    const pointsHit = pick(scored, (c) => c.entry.total);
    const chainHit = pick(scored, (c) => c.entry.longestChainPoints);
    const chain = record('chain', 'Longest chain', chainHit, fmtPoints);
    // A chain worth the whole run's points is not the points tile repeating itself — it is a
    // run that never dropped the chain. Say that, or the board looks broken.
    if (chainHit && pointsHit && chainHit.c.entry.id === pointsHit.c.entry.id && Math.round(chainHit.v) === Math.round(pointsHit.v)) {
      chain.note = 'the whole run, unbroken';
    }
    out.push({
      track,
      runs: all.length,
      scored: scored.length,
      lastAt: all.reduce((m, c) => Math.max(m, c.entry.startedAt), 0),
      framing: scored.length === 1 ? 'One scored run, so it holds all four — this is the bar to beat' : null,
      records: [
        {
          ...record('grade', 'Best grade', gradeHit, () => ''),
          value: gradeHit ? gradeHit.c.entry.grade : '--',
        },
        record('points', 'Most points', pointsHit, fmtPoints),
        // The angle the driver HELD and drove out of — which is what the caption under this
        // board has always said it is (`DriftStats.heldPeakDeg`, not `DriftEvent.peakAngle`).
        record('angle', 'Biggest angle', pick(scored, (c) => c.entry.heldPeakDeg), (v) => `${Math.round(v)}°`),
        chain,
      ],
    });
  }
  out.sort((a, b) => b.lastAt - a.lastAt);
  return out;
}

/** The grade a track's best run earned, for colouring the board. `null` when nothing is scored. */
export function bestGradeOf(bests: TrackBests): Grade | null {
  const r = bests.records.find((x) => x.key === 'grade');
  return r && !r.empty ? (r.value as Grade) : null;
}

export interface LastRunStanding {
  /** Records the last run now holds on its own track. */
  records: RecordKey[];
  /** Points short of the track's best. Null when this run holds the points record. */
  pointsBehind: number | null;
  /** True when it is the only scored run on this track, so holding all four means nothing yet. */
  onlyScoredRun: boolean;
  /** The one line the last-run card prints. Null when there is nothing true to say. */
  line: string;
}

/**
 * What the run you just did did to your own numbers.
 *
 * A career screen's whole job, and the garage used to say nothing at all: the last run was an A
 * worth 23,050 with a 56° hold, the board immediately under it read S / 31,519 / 64° / 15,092,
 * and not one pixel connected the two.
 *
 * A run the engine would not vouch for gets nothing here — it holds no record and its total is
 * not a total, so there is nothing to compare. And the FIRST scored run on a track holds all
 * four records by arithmetic, which is not four records; it says what it is instead.
 */
export function lastRunStanding(bests: readonly TrackBests[], last: SessionIndexEntry | null): LastRunStanding | null {
  if (!last || !last.trusted) return null;
  const panel = bests.find((t) => t.track === trackKeyOf(last));
  if (!panel) return null;

  const held = panel.records.filter((r) => !r.empty && r.id === last.id);
  const keys = held.map((r) => r.key);
  const points = panel.records.find((r) => r.key === 'points');
  const pointsBehind = points && !points.empty && points.id !== last.id ? Math.max(0, Math.round(points.amount - last.total)) : null;
  const onlyScoredRun = panel.scored <= 1;

  const line = onlyScoredRun
    ? `First scored run on ${panel.track} — this is the bar to beat`
    : keys.length > 0
      ? `New record — ${listOf(held.map((r) => r.label.toLowerCase()))}`
      : pointsBehind === null
        ? ''
        : pointsBehind === 0
          ? 'Level with your best here'
          : `${fmtPoints(pointsBehind)} off your best here`;

  if (!line) return null;
  return { records: keys, pointsBehind, onlyScoredRun, line };
}

function listOf(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}
