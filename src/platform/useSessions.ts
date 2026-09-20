import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';

import type { Session } from '../engine/types';
import { listSessions, loadSession, type SessionIndexEntry } from './storage';

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
