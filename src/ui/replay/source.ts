/**
 * Which session the replay screen plays, resolved from the id + the URL.
 *
 * A fixture id (or `?fixture=`) rebuilds the same deterministic session the results screen shows,
 * so a deep link from a fixture result lands on the same run; anything else is looked up in
 * storage. The VIEW MODEL itself — trust, warnings, gap windows — lives in `./view`, which has no
 * platform import and is therefore testable.
 */
import { useEffect, useMemo, useRef, useState } from 'react';

import { loadSession } from '../../platform';
import { buildFixtureSession, resolveFixture } from '../results/fixture';
import type { ReplayParams } from './params';
import { buildReplayView, type ReplayView } from './view';

export { buildReplayView, gapWindows } from './view';
export type { GapWindow, ReplayView } from './view';

export interface UseReplaySource {
  view: ReplayView | null;
  loading: boolean;
  error: string | null;
}

/**
 * Resolve `/replay/<id>?...` to a scene. A fixture id (or `?fixture=`) rebuilds the same session
 * the results screen shows — the deep link from a fixture result has to land on the same run —
 * and anything else is looked up in storage.
 */
export function useReplaySource(id: string | undefined, params: ReplayParams, query: Record<string, string | string[] | undefined>): UseReplaySource {
  const spec = useMemo(() => resolveFixture(id, flatten(query)), [id, query]);
  const [view, setView] = useState<ReplayView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // the params object is rebuilt every render; the build only cares about these few fields
  const key = `${spec ? JSON.stringify(spec) : id}|${params.ghost}|${params.noGhost}|${params.gaps}`;
  const paramsRef = useRef(params);
  paramsRef.current = params;

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    // Give React one frame to paint the loading state: a pipeline fixture takes about a second,
    // and a blank white-to-black flash is worse than a stated wait.
    const timer = setTimeout(() => {
      if (!alive) return;
      const run = async () => {
        const session = spec ? buildFixtureSession(spec) : await loadSession(id ?? '');
        if (!alive) return;
        if (!session) {
          setView(null);
          setError(null);
          setLoading(false);
          return;
        }
        setView(buildReplayView(session, paramsRef.current, spec));
        setLoading(false);
      };
      run().catch((err: unknown) => {
        if (!alive) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
    }, 16);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return { view, loading, error };
}

function flatten(query: Record<string, string | string[] | undefined>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const k of Object.keys(query)) {
    const v = query[k];
    out[k] = Array.isArray(v) ? v[0] : v;
  }
  return out;
}
