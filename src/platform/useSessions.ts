import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';

import type { Session } from '../engine/types';
import { diagnoseSessions, listSessions, loadSession, type SessionIndexEntry } from './storage';
import type { StorageDiagnosis } from './sessionStore';

export interface UseSessionIndex {
  entries: SessionIndexEntry[];
  loading: boolean;
  error: string | null;
  refresh(): Promise<void>;
}

/** The session index, refreshed whenever the screen gains focus. */
export function useSessionIndex(): UseSessionIndex {
  const [entries, setEntries] = useState<SessionIndexEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setEntries(await listSessions());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void refresh();
    }, [refresh]),
  );

  return { entries, loading, error, refresh };
}

/**
 * What state storage is in, for the screens that have to explain themselves rather than draw an
 * empty list over a full disk.
 *
 * Costs no parsing: the index read is cached by whatever already listed it, and counting the
 * recordings reads key NAMES, never bodies (`npx tsx tools/analysis/storage-census.ts`).
 *
 * `ready` holds it back until the thing that might CHANGE storage has finished — the garage's
 * `?demo=` seeding writes a whole set before the diagnosis means anything. `revision` retakes
 * it: any value the caller changes when storage might have moved under it — a delete, a wipe, a
 * rebuild, or the listing itself starting to fail. It returns null while it has no answer, and
 * on failure, because "we could not ask" is not "nothing is wrong".
 */
export function useStorageDiagnosis(ready: boolean, revision: string | number): StorageDiagnosis | null {
  const [diagnosis, setDiagnosis] = useState<StorageDiagnosis | null>(null);
  useEffect(() => {
    if (!ready) return;
    let alive = true;
    diagnoseSessions().then(
      (d) => alive && setDiagnosis(d),
      () => alive && setDiagnosis(null),
    );
    return () => {
      alive = false;
    };
  }, [ready, revision]);
  return diagnosis;
}

export interface UseSession {
  session: Session | null;
  loading: boolean;
  error: string | null;
}

/** One stored session by id (`null` when it does not exist). */
export function useSession(id: string | undefined): UseSession {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    if (!id) {
      setSession(null);
      setLoading(false);
      return;
    }
    loadSession(id)
      .then((s) => {
        if (!alive) return;
        setSession(s);
        setError(null);
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setSession(null);
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [id]);

  return { session, loading, error };
}
