/**
 * The garage's data: the session index, the personal bests derived from it, and the demo
 * seeding `?demo=` asks for.
 *
 * The list reads NO session bodies. Grade, points, best angle, chain, track, date, duration and
 * the NOT SCORED verdict all come from `SessionIndexEntry`, so every row is drawn the moment
 * the index is read. Exactly one body is fetched, off the render path and after the list is up:
 * the newest run's, for the integrity monitor's own sentence behind the mount notice
 * (see `lastRun.ts`).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';

import { deleteSession, useSessionIndex, type SessionIndexEntry } from '../../platform';
import { personalBests, type TrackBests } from './bests';
import { clearDemoSessions, demoSetPresent, resolveDemoRequest, seedDemoSessions, type SeedProgress } from './demo';
import { forgetDetails, readDetail, type LastRunDetail } from './lastRun';

export interface Garage {
  entries: SessionIndexEntry[];
  /** The newest run's body, once read. Null until then, and for an empty garage. */
  lastDetail: LastRunDetail | null;
  bests: TrackBests[];
  /** True while the index (or a demo seed) is still being read. */
  loading: boolean;
  /** Non-null while demo sessions are being built. */
  seeding: SeedProgress | null;
  error: string | null;
  /** Newest run, or null. */
  last: SessionIndexEntry | null;
  earlier: SessionIndexEntry[];
  remove(id: string): Promise<void>;
  refresh(): Promise<void>;
}

export function useGarage(demoParam: string | undefined): Garage {
  const index = useSessionIndex();
  const { refresh } = index;
  const [lastDetail, setLastDetail] = useState<LastRunDetail | null>(null);
  const [seeding, setSeeding] = useState<SeedProgress | null>(null);
  const [seedSettled, setSeedSettled] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ---- ?demo=: fill (or empty) the garage with real, deterministic runs -------------------
  useEffect(() => {
    const request = resolveDemoRequest(demoParam);
    if (!request) {
      setSeedSettled(true);
      return;
    }
    let alive = true;
    setSeedSettled(false);
    (async () => {
      try {
        if (request.kind === 'clear') {
          await clearDemoSessions();
        } else if (!(await demoSetPresent(request.set))) {
          await seedDemoSessions(request.set, (p) => {
            if (alive) setSeeding(p);
          });
        }
        if (!alive) return;
        setLastDetail(null);
        await refresh();
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (alive) {
          setSeeding(null);
          setSeedSettled(true);
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [demoParam, refresh]);

  // ---- one body, for the words the index cannot hold ---------------------------------------
  const entries = index.entries;
  const lastId = entries[0]?.id ?? null;
  useEffect(() => {
    if (!lastId) {
      setLastDetail(null);
      return;
    }
    let cancelled = false;
    void readDetail(lastId).then((d) => {
      if (!cancelled) setLastDetail(d);
    });
    return () => {
      cancelled = true;
    };
  }, [lastId]);

  const bests = useMemo(() => personalBests(entries), [entries]);

  const remove = useCallback(
    async (id: string) => {
      try {
        await deleteSession(id);
        forgetDetails(id);
        if (id === lastId) setLastDetail(null);
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [lastId, refresh],
  );

  return {
    entries,
    lastDetail,
    bests,
    loading: index.loading || !seedSettled || seeding !== null,
    seeding,
    error: error ?? index.error,
    last: entries[0] ?? null,
    earlier: entries.slice(1),
    remove,
    refresh,
  };
}
