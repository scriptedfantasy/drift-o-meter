/**
 * The few things about a run that the session INDEX still does not carry.
 *
 * It used to be five, and the garage parsed every session body on mount to get them: 5.75 MB of
 * JSON per run where 87 KB was needed, ~31 ms of parsing each, so twenty stored runs meant
 * 115 MB parsed on the UI thread every time the screen opened. `SessionIndexEntry` now carries
 * `trusted`, `peakAngleDeg` and `longestChainPoints`, so **the list reads nothing at all** —
 * grade, points, best angle, track, date, duration and the NOT SCORED state all come from the
 * index.
 *
 * What is left needs a body, and needs it for one run at a time:
 *   • the integrity monitor's own SENTENCE about what went wrong, which the garage's mount
 *     notice prints verbatim rather than inventing copy for the same condition;
 *   • the mount verdict and the calibration confidence behind that notice;
 *   • for a demo run, the query that reproduces it on the results screen.
 *
 * So exactly one body is read on mount — the newest run's, off the render path — and one more
 * when a row is actually opened. Both memoised for the process.
 */
import type { Session } from '../../engine/types';
import { loadSession } from '../../platform';

export interface LastRunDetail {
  id: string;
  mount: 'rigid' | 'suspect' | 'loose';
  /** `IntegrityMonitor`'s own sentence. Empty when the engine had no objection. */
  message: string;
  /** 0..1 from `Session.calibration`. */
  calibrationQuality: number;
  /**
   * For a stored demo run, the query that reproduces it on the results screen
   * (`fixture=touge&seed=5`). Empty for a real recording, which loads by id.
   */
  fixtureQuery: string;
}

export function detailOf(session: Session): LastRunDetail {
  const integrity = session.integrity;
  const meta = session.meta ?? {};
  return {
    id: session.id,
    mount: integrity?.mount ?? 'rigid',
    message: integrity?.scoreTrusted === false ? (integrity.message ?? '') : '',
    calibrationQuality: session.calibration?.quality ?? 0,
    fixtureQuery: typeof meta.fixtureQuery === 'string' ? meta.fixtureQuery : '',
  };
}

/** Nothing could be read: claim nothing, and say why in the one field that shows. */
export function unreadableDetail(id: string): LastRunDetail {
  return { id, mount: 'rigid', message: 'The recording could not be read', calibrationQuality: 0, fixtureQuery: '' };
}

const cache = new Map<string, LastRunDetail>();

export function peekDetail(id: string): LastRunDetail | undefined {
  return cache.get(id);
}

export function forgetDetails(id?: string): void {
  if (id === undefined) cache.clear();
  else cache.delete(id);
}

/** Read one run's detail, memoised for the life of the process. */
export async function readDetail(id: string): Promise<LastRunDetail> {
  const hit = cache.get(id);
  if (hit) return hit;
  let detail: LastRunDetail;
  try {
    const session = await loadSession(id);
    detail = session ? detailOf(session) : unreadableDetail(id);
  } catch {
    detail = unreadableDetail(id);
  }
  cache.set(id, detail);
  return detail;
}
