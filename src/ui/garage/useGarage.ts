/**
 * The garage's data: the session index, the board of drivers derived from it, what the last run
 * did to that board, the roster itself, and the demo seeding `?demo=` asks for.
 *
 * **It reads NO session bodies at all.** Who drove it, the held angle, the spins, the track,
 * the date, the duration, the mount verdict, the calibration confidence, the monitor's sentence
 * and the shape of the run's slides all come from `SessionIndexEntry`, so the whole screen is drawn the
 * moment the index is read. The newest run's body used to be parsed on mount — 5.48 MB and
 * 25.5 ms on a real recording, for 70 bytes of text. A body is opened only when a row is
 * TAPPED, and only for a demo run (see `lastRun.ts`). That claim is re-runnable rather than
 * remembered: `npx tsx tools/analysis/storage-census.ts` counts the body reads a full render
 * makes over a stored season, and prints what the index costs to hold and to parse.
 *
 * `driverId` is in the index for exactly this reason. The board groups and ranks by driver,
 * and a leaderboard that had to open twenty recordings to find out whose they were would break
 * the one property this screen is built on, on the screen that matters most.
 *
 * It also reports what is WRONG with storage rather than drawing an empty garage over it: an
 * index that will not parse is not "your first run", and a browser that keeps nothing should
 * say so before a driver trusts it with a season. That wording lives in `fault.ts`, because
 * `/settings` counts the same runs and has to say the same thing about them.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';

import { deleteSession, rebuildSessionIndex, useSessionIndex, useStorageDiagnosis, type SessionIndexEntry } from '../../platform';
import { boardTrack, driverStandings, lastRunStanding, runsOf, type DriverStanding, type LastRunStanding } from './bests';
import { clearDemoSessions, demoSetPresent, resolveDemoRequest, seedDemoSessions, type SeedProgress } from './demo';
import { faultFor, type GarageFault } from './fault';
import { forgetDetails } from './lastRun';
import { useDrivers, type UseDrivers } from './useDrivers';

export type { GarageFault } from './fault';

export interface Garage {
  entries: SessionIndexEntry[];
  /** The roster, and the four edits a screen can make to it. */
  drivers: UseDrivers;
  /** One row per driver, ranked by the biggest angle held. */
  standings: DriverStanding[];
  /** The track the board is about — the one the newest run was driven on. */
  track: string | null;
  /**
   * The runs the list should show: the active driver's, or every run when nobody is at the
   * wheel. Newest first, so `groupByNight` can be run over it directly.
   */
  shown: SessionIndexEntry[];
  /** What the card's run did to its driver's biggest angle. Null when there is nothing to say. */
  standing: LastRunStanding | null;
  /**
   * The newest run in the whole garage, whoever drove it.
   *
   * Separate from `last` because the mount notice is about the drive that just happened, and
   * `last` is about whoever's list is on screen. They are the same run whenever the person who
   * drove is the person selected, which is the normal case — but a notice saying "your last
   * run was thrown out" over somebody else's week-old run would be untrue in the one state
   * where the screen most needs to be believed.
   */
  newest: SessionIndexEntry | null;
  /** True while the index (or a demo seed) is still being read. */
  loading: boolean;
  /** Non-null while demo sessions are being built. */
  seeding: SeedProgress | null;
  fault: GarageFault | null;
  /** True while the run list is being rebuilt from the recordings. */
  rebuilding: boolean;
  /** Newest of `shown`, or null — the run the big card is drawn from. */
  last: SessionIndexEntry | null;
  /** The rest of `shown`, still newest-first. */
  earlier: SessionIndexEntry[];
  remove(id: string): Promise<void>;
  rebuild(): Promise<void>;
  refresh(): Promise<void>;
}

export function useGarage(demoParam: string | undefined): Garage {
  const index = useSessionIndex();
  const { refresh } = index;
  const [seeding, setSeeding] = useState<SeedProgress | null>(null);
  const [seedSettled, setSeedSettled] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
  // Taken again whenever storage may have moved: a delete, a wipe, a rebuild, a demo seed — and
  // whenever the listing itself starts or stops failing, which is the state this is here for.
  const settled = !index.loading && seedSettled;
  const diagnosis = useStorageDiagnosis(settled, `${revision}:${index.error ?? ''}`);

  const entries = index.entries;
  const drivers = useDrivers();
  const { roster } = drivers;
  const standings = useMemo(() => driverStandings(entries, roster), [entries, roster]);
  // Nobody at the wheel shows everything, so the runs nobody claimed are always one tap from
  // being visible rather than stranded behind a name that no longer exists.
  const shown = useMemo(() => (roster.activeId ? runsOf(entries, roster, roster.activeId) : entries), [entries, roster]);
  // About the run the CARD draws, not about the newest run in the garage: the sentence sits
  // inside that card, and a line describing a different run than the one above it is worse
  // than no line at all.
  const standing = useMemo(() => lastRunStanding(standings, shown[0] ?? null, roster), [standings, shown, roster]);

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
    drivers,
    standings,
    track: boardTrack(entries),
    shown,
    standing,
    newest: entries[0] ?? null,
    loading: index.loading || !seedSettled || seeding !== null,
    seeding,
    fault: faultFor(diagnosis, error ?? index.error),
    rebuilding,
    last: shown[0] ?? null,
    earlier: shown.slice(1),
    remove,
    rebuild,
    refresh,
  };
}
