/**
 * The garage's data: the session index, the personal bests derived from it, what the last run
 * did to those bests, and the demo seeding `?demo=` asks for.
 *
 * **It reads NO session bodies at all.** Grade, points, held angle, chain, spins, track, date,
 * duration, the mount verdict, the calibration confidence, the monitor's sentence and the shape
 * of the run's slides all come from `SessionIndexEntry`, so the whole screen is drawn the
 * moment the index is read. The newest run's body used to be parsed on mount — 5.48 MB and
 * 25.5 ms on a real recording, for 70 bytes of text. A body is opened only when a row is
 * TAPPED, and only for a demo run (see `lastRun.ts`).
 *
 * It also reports what is WRONG with storage rather than drawing an empty garage over it: an
 * index that will not parse is not "your first run", and a browser that keeps nothing should
 * say so before a driver trusts it with a season.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';

import { deleteSession, diagnoseSessions, rebuildSessionIndex, useSessionIndex, type SessionIndexEntry, type StorageDiagnosis } from '../../platform';
import { lastRunStanding, personalBests, type LastRunStanding, type TrackBests } from './bests';
import { clearDemoSessions, demoSetPresent, resolveDemoRequest, seedDemoSessions, type SeedProgress } from './demo';
import { forgetDetails } from './lastRun';

/** Something the screen has to explain, with the repair when there is one. */
export interface GarageFault {
  kind: 'unreadable-index' | 'ephemeral' | 'error';
  level: 'bad' | 'warn';
  title: string;
  body: string;
  /** Label for the repair, or null when there is nothing to offer. */
  action: string | null;
}

export interface Garage {
  entries: SessionIndexEntry[];
  bests: TrackBests[];
  /** What the newest run did to the records on its track. Null when there is nothing to say. */
  standing: LastRunStanding | null;
  /** True while the index (or a demo seed) is still being read. */
  loading: boolean;
  /** Non-null while demo sessions are being built. */
  seeding: SeedProgress | null;
  fault: GarageFault | null;
  /** True while the run list is being rebuilt from the recordings. */
  rebuilding: boolean;
  /** Newest run, or null. */
  last: SessionIndexEntry | null;
  earlier: SessionIndexEntry[];
  remove(id: string): Promise<void>;
  rebuild(): Promise<void>;
  refresh(): Promise<void>;
}

function faultFor(d: StorageDiagnosis | null, error: string | null): GarageFault | null {
  if (d && d.index === 'unreadable') {
    const n = d.recordings;
    const kept =
      n === null
        ? 'Your recordings are still on this device.'
        : n === 0
          ? 'There are no recordings on this device to rebuild it from.'
          : n === 1
            ? '1 recording is still on this device.'
            : `${n} recordings are still on this device.`;
    return {
      kind: 'unreadable-index',
      level: 'bad',
      title: 'Your run list could not be read',
      body: `${kept} Rebuilding reads each one and writes a new list. Nothing is deleted, and nothing new is saved until you choose.`,
      action: n !== null && n > 0 ? 'Rebuild the list' : null,
    };
  }
  if (error) {
    return { kind: 'error', level: 'bad', title: 'The run list could not be read', body: error, action: null };
  }
  if (d && d.ephemeral) {
    return {
      kind: 'ephemeral',
      level: 'warn',
      title: 'This browser is not keeping anything',
      body: 'Site data is blocked here, so runs last until the tab closes and no further. Nothing is lost that was not already unsaveable.',
      action: null,
    };
  }
  return null;
}

export function useGarage(demoParam: string | undefined): Garage {
  const index = useSessionIndex();
  const { refresh } = index;
  const [seeding, setSeeding] = useState<SeedProgress | null>(null);
  const [seedSettled, setSeedSettled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [diagnosis, setDiagnosis] = useState<StorageDiagnosis | null>(null);
  const [rebuilding, setRebuilding] = useState(false);
  // Bumped whenever storage changes under us, so the diagnosis is taken again.
  const [revision, setRevision] = useState(0);

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
        await refresh();
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (alive) {
          setSeeding(null);
          setSeedSettled(true);
          setRevision((n) => n + 1);
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [demoParam, refresh]);

  // ---- what state storage is in ------------------------------------------------------------
  // Costs no parsing: the index read is already cached by the listing above, and counting the
  // recordings reads key NAMES, never bodies.
  const settled = !index.loading && seedSettled;
  useEffect(() => {
    if (!settled) return;
    let alive = true;
    diagnoseSessions().then(
      (d) => alive && setDiagnosis(d),
      () => alive && setDiagnosis(null),
    );
    return () => {
      alive = false;
    };
  }, [settled, index.error, revision]);

  const entries = index.entries;
  const bests = useMemo(() => personalBests(entries), [entries]);
  const standing = useMemo(() => lastRunStanding(bests, entries[0] ?? null), [bests, entries]);

  const remove = useCallback(
    async (id: string) => {
      try {
        await deleteSession(id);
        forgetDetails(id);
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setRevision((n) => n + 1);
      }
    },
    [refresh],
  );

  const rebuild = useCallback(async () => {
    setRebuilding(true);
    try {
      await rebuildSessionIndex();
      setError(null);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRebuilding(false);
      setRevision((n) => n + 1);
    }
  }, [refresh]);

  return {
    entries,
    bests,
    standing,
    loading: index.loading || !seedSettled || seeding !== null,
    seeding,
    fault: faultFor(diagnosis, error ?? index.error),
    rebuilding,
    last: entries[0] ?? null,
    earlier: entries.slice(1),
    remove,
    rebuild,
    refresh,
  };
}
