/**
 * The garage's data: the session index, the facts the index does not carry, the personal bests
 * derived from both, and the demo seeding the harness (and a demo on a laptop) asks for with
 * `?demo=`.
 *
 * Rows appear as soon as the index is read and fill in, newest first, as each run's verdict
 * comes off disk — see `facts.ts` for why a row may not show a grade before then.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';

import { deleteSession, useSessionIndex, type SessionIndexEntry } from '../../platform';
import { personalBests, type TrackBests } from './bests';
import { clearDemoSessions, demoSetPresent, resolveDemoRequest, seedDemoSessions, type SeedProgress } from './demo';
import { forgetFacts, readFactsInOrder, type SessionFacts } from './facts';

export interface Garage {
  entries: SessionIndexEntry[];
  facts: ReadonlyMap<string, SessionFacts>;
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
  const [facts, setFacts] = useState<ReadonlyMap<string, SessionFacts>>(() => new Map());
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
        setFacts(new Map());
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

  // ---- the facts the index does not carry, newest first -----------------------------------
  const entries = index.entries;
  useEffect(() => {
    if (entries.length === 0) return;
    let cancelled = false;
    void readFactsInOrder(
      entries,
      (f) => {
        if (!cancelled) setFacts((prev) => new Map(prev).set(f.id, f));
      },
      () => cancelled,
    );
    return () => {
      cancelled = true;
    };
  }, [entries]);

  const bests = useMemo(() => personalBests(entries, facts), [entries, facts]);

  const remove = useCallback(
    async (id: string) => {
      try {
        await deleteSession(id);
        forgetFacts(id);
        setFacts((prev) => {
          const next = new Map(prev);
          next.delete(id);
          return next;
        });
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [refresh],
  );

  return {
    entries,
    facts,
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
