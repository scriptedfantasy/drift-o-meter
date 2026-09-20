/**
 * The handful of facts the garage needs about a run that the session INDEX does not carry.
 *
 * `SessionIndexEntry` (src/platform/sessionStore.ts) is deliberately tiny — id, name, date,
 * duration, total, grade, drift count, track — because listing must not read megabytes. The
 * garage needs three more things, and two of them are not optional:
 *
 *   • `trusted` — whether the engine will vouch for the score at all. The contract on
 *     `SessionIntegrity.scoreTrusted` forbids presenting the total OR the grade as an
 *     achievement when it is false, so the list may NOT draw a grade letter until it knows.
 *     That is why a row renders as a skeleton rather than optimistically showing the grade.
 *   • `peakAngleDeg` / `longestChainPoints` — the records the personal bests are made of.
 *
 * Until `summarizeSession` grows those fields (a `src/platform` change), they are read out of
 * the session body: one JSON parse per run, off the render path, memoised for the process and
 * newest-first so the top of the list fills in first.
 */
import type { Session } from '../../engine/types';
import { radToDeg } from '../../engine/types';
import { loadSession, type SessionIndexEntry } from '../../platform';

export interface SessionFacts {
  id: string;
  /** False when the engine refuses to publish this run's score. No grade, no record, no boast. */
  trusted: boolean;
  /** Biggest angle the driver HELD and drove out of, degrees. Spins do not count as a best. */
  peakAngleDeg: number;
  /** Biggest angle anywhere in the run, spins included — what happened, not what was earned. */
  rawPeakAngleDeg: number;
  longestChainPoints: number;
  transitions: number;
  spins: number;
  /** Seconds spent sideways. */
  driftTimeS: number;
  /** Top speed reached inside a drift, km/h. */
  topDriftKmh: number;
  mount: 'rigid' | 'suspect' | 'loose';
  /** Plain-language reason the run was not trusted; empty when it was. */
  message: string;
  calibrationQuality: number;
  /** A run rebuilt from the simulator rather than driven. */
  simulated: boolean;
  /**
   * For a stored demo run, the query that reproduces it on the results screen
   * (`fixture=hero&seed=3`). Empty for a real recording, which loads from storage by id.
   */
  fixtureQuery: string;
}

export function factsOf(session: Session): SessionFacts {
  const drifts = Array.isArray(session.drifts) ? session.drifts : [];
  let held = 0;
  let raw = 0;
  let transitions = 0;
  let spins = 0;
  let driftTimeS = 0;
  let topKmh = 0;
  for (const d of drifts) {
    const deg = Math.abs(radToDeg(d.peakAngle));
    if (deg > raw) raw = deg;
    if (!d.spin && deg > held) held = deg;
    if (d.spin) spins++;
    transitions += d.transitions | 0;
    driftTimeS += Number.isFinite(d.durationS) ? d.durationS : 0;
    const kmh = Math.max(d.entrySpeed, d.meanSpeed) * 3.6;
    if (Number.isFinite(kmh) && kmh > topKmh) topKmh = kmh;
  }
  const integrity = session.integrity;
  const score = session.score;
  const meta = session.meta ?? {};
  return {
    id: session.id,
    // both halves of the verdict have to agree before a score may be shown
    trusted: (integrity?.scoreTrusted ?? true) && (score?.trusted ?? true),
    peakAngleDeg: held,
    rawPeakAngleDeg: raw,
    longestChainPoints: Number.isFinite(score?.longestChainPoints) ? score.longestChainPoints : 0,
    transitions,
    spins,
    driftTimeS,
    topDriftKmh: topKmh,
    mount: integrity?.mount ?? 'rigid',
    message: integrity?.scoreTrusted === false ? (integrity.message ?? '') : '',
    calibrationQuality: session.calibration?.quality ?? 0,
    simulated: meta.source === 'simulation' || typeof meta.fixture === 'string',
    fixtureQuery: typeof meta.fixtureQuery === 'string' ? meta.fixtureQuery : '',
  };
}

/** Facts for a session that could not be read at all: nothing is claimed for it. */
export function unreadableFacts(id: string): SessionFacts {
  return {
    id,
    trusted: false,
    peakAngleDeg: 0,
    rawPeakAngleDeg: 0,
    longestChainPoints: 0,
    transitions: 0,
    spins: 0,
    driftTimeS: 0,
    topDriftKmh: 0,
    mount: 'rigid',
    message: 'The recording could not be read',
    calibrationQuality: 0,
    simulated: false,
    fixtureQuery: '',
  };
}

const cache = new Map<string, SessionFacts>();

export function peekFacts(id: string): SessionFacts | undefined {
  return cache.get(id);
}

export function forgetFacts(id?: string): void {
  if (id === undefined) cache.clear();
  else cache.delete(id);
}

/** Read one run's facts, memoised for the life of the process. */
export async function readFacts(id: string): Promise<SessionFacts> {
  const hit = cache.get(id);
  if (hit) return hit;
  let facts: SessionFacts;
  try {
    const session = await loadSession(id);
    facts = session ? factsOf(session) : unreadableFacts(id);
  } catch {
    facts = unreadableFacts(id);
  }
  cache.set(id, facts);
  return facts;
}

/**
 * Walk the index newest-first, reading each body in turn and reporting as each one lands, so
 * the rows a driver is actually looking at fill in first. `onFacts` is called on the JS thread
 * after every read; `cancelled()` stops the walk when the screen goes away.
 */
export async function readFactsInOrder(
  entries: readonly SessionIndexEntry[],
  onFacts: (facts: SessionFacts) => void,
  cancelled: () => boolean = () => false,
): Promise<void> {
  for (const e of entries) {
    if (cancelled()) return;
    const hit = cache.get(e.id);
    if (hit) {
      onFacts(hit);
      continue;
    }
    const facts = await readFacts(e.id);
    if (cancelled()) return;
    onFacts(facts);
  }
}
