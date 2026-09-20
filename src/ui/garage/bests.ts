/**
 * Personal bests, per track, derived from what is actually stored.
 *
 * Four records a driver recognises: best grade, most points, biggest angle, longest chain.
 * Only runs the engine vouched for can hold one — a score it refuses to publish is not an
 * achievement (see the contract on `SessionIntegrity.scoreTrusted`), so an untrusted run is
 * counted as a run and never as a record. Pure: a screen can render it, a test can check it.
 */
import type { Grade } from '../../engine/types';
import type { SessionIndexEntry } from '../../platform';
import type { SessionFacts } from './facts';

export type RecordKey = 'grade' | 'points' | 'angle' | 'chain';

export interface BestRecord {
  key: RecordKey;
  /** Uppercase label for the tile. */
  label: string;
  /** The record itself, formatted. */
  value: string;
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

interface Candidate {
  entry: SessionIndexEntry;
  facts: SessionFacts;
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
  if (!hit) return { key, label, value: '--', id: '', when: 0, query: '', empty: true };
  return { key, label, value: format(hit.v), id: hit.c.entry.id, when: hit.c.entry.startedAt, query: hit.c.facts.fixtureQuery, empty: false };
}

/**
 * Group the stored runs by track and find the four records on each. Tracks come back with the
 * most recently driven first, so the board reads like a logbook rather than an alphabet.
 * Entries whose facts have not been read yet are skipped: a record must not be claimed from
 * half the evidence.
 */
export function personalBests(entries: readonly SessionIndexEntry[], facts: ReadonlyMap<string, SessionFacts>): TrackBests[] {
  const byTrack = new Map<string, Candidate[]>();
  for (const entry of entries) {
    const f = facts.get(entry.id);
    if (!f) continue;
    const track = entry.track && entry.track.trim() ? entry.track : UNTRACKED;
    const list = byTrack.get(track);
    if (list) list.push({ entry, facts: f });
    else byTrack.set(track, [{ entry, facts: f }]);
  }

  const out: TrackBests[] = [];
  for (const [track, all] of byTrack) {
    const scored = all.filter((c) => c.facts.trusted);
    const gradeHit = pick(scored, (c) => GRADE_ORDER[c.entry.grade] + 1);
    const pointsHit = pick(scored, (c) => c.entry.total);
    const chainHit = pick(scored, (c) => c.facts.longestChainPoints);
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
        record('angle', 'Biggest angle', pick(scored, (c) => c.facts.peakAngleDeg), (v) => `${Math.round(v)}°`),
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
