/**
 * The one thing about a run that the session INDEX cannot hold, and the only reason the garage
 * ever opens a session body: the query that reproduces a DEMO run on the results screen.
 *
 * It used to be five things, and the garage parsed a body on MOUNT to get them. The measured
 * cost of that on a real untrimmed session was 5.48 MB and 25.5 ms of `JSON.parse` — on a
 * phone's JS thread, every time the home screen opened — for `{mount, message,
 * calibrationQuality}`, which serialise to 70 bytes. The demo bodies are trimmed to 87 KB, so
 * the shipped screenshots never paid it and nobody noticed. All three now live in
 * `SessionIndexEntry` beside `trusted`, `heldPeakDeg` and `longestChainPoints`, and
 * **the home screen reads no session body at all**.
 *
 * What is left happens on a TAP, on one run, memoised for the process: a stored `fixture-<name>`
 * id is rebuilt from the simulator by the results screen, so any seed override has to travel
 * with it (`Session.meta.fixtureQuery`). A real recording loads by id and needs nothing.
 */
import type { Session } from '../../engine/types';
import { loadSession } from '../../platform';

export interface LastRunDetail {
  id: string;
  /**
   * For a stored demo run, the query that reproduces it on the results screen
   * (`fixture=touge&seed=5`). Empty for a real recording, which loads by id.
   */
  fixtureQuery: string;
}

export function detailOf(session: Session): LastRunDetail {
  const meta = session.meta ?? {};
  return { id: session.id, fixtureQuery: typeof meta.fixtureQuery === 'string' ? meta.fixtureQuery : '' };
}

const cache = new Map<string, LastRunDetail>();

export function peekDetail(id: string): LastRunDetail | undefined {
  return cache.get(id);
}

export function forgetDetails(id?: string): void {
  if (id === undefined) cache.clear();
  else cache.delete(id);
}

/**
 * Read one run's detail, memoised for the life of the process. Called when a row is OPENED,
 * never while drawing the list. A body that cannot be read still opens the run: the results
 * screen loads by id and reports its own failure, which is where that sentence belongs.
 */
export async function readDetail(id: string): Promise<LastRunDetail> {
  const hit = cache.get(id);
  if (hit) return hit;
  let detail: LastRunDetail = { id, fixtureQuery: '' };
  try {
    const session = await loadSession(id);
    if (session) detail = detailOf(session);
  } catch {
    // leave the query empty; the results screen says what went wrong
  }
  cache.set(id, detail);
  return detail;
}
