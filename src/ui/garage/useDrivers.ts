/**
 * The roster, as a screen sees it: who is on it, who is at the wheel, and the four edits.
 *
 * Shaped exactly like `platform/useSettings.ts` — load once, subscribe, and hand back
 * functions that write through the store rather than into local state — because the roster
 * has the same problem settings do: two screens can be mounted at once (the garage and a
 * run's review), and a name added on one has to appear on the other without a reload. The
 * store is the single copy; this is a window onto it.
 *
 * It lives in `ui/garage/` rather than beside the store because it is a rendering concern.
 * `platform/drivers.ts` is what the DRIVE screen calls at the instant it starts recording,
 * and that path must not wait on React (`peekActiveDriverId`); nothing here is on it.
 *
 * `error` is the last refused edit, held until the next one, so an input can say "that name
 * is already on the list" without the caller having to remember which call refused.
 */
import { useCallback, useEffect, useState } from 'react';

import {
  addDriver as addToRoster,
  activeDriver,
  loadRoster,
  peekRoster,
  removeDriver as removeFromRoster,
  renameDriver as renameInRoster,
  setActiveDriver as setActiveInRoster,
  subscribeRoster,
  type AddDriverError,
  type Driver,
  type Roster,
} from '../../platform/drivers';

export interface UseDrivers {
  roster: Roster;
  drivers: Driver[];
  /** Who the next run is recorded as, or null for nobody. */
  active: Driver | null;
  /** False until the roster has been read off the device once. */
  loaded: boolean;
  /** Why the last edit was refused, or null. Cleared by the next edit that succeeds. */
  error: AddDriverError | null;
  add(name: string): Promise<Driver | null>;
  rename(id: string, name: string): Promise<boolean>;
  remove(id: string): Promise<void>;
  select(id: string | null): Promise<void>;
}

export function useDrivers(): UseDrivers {
  const [roster, setRoster] = useState<Roster>(peekRoster);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<AddDriverError | null>(null);

  useEffect(() => {
    let alive = true;
    void loadRoster().then((r) => {
      if (!alive) return;
      setRoster(r);
      setLoaded(true);
    });
    const unsubscribe = subscribeRoster((r) => {
      if (alive) setRoster(r);
    });
    return () => {
      alive = false;
      unsubscribe();
    };
  }, []);

  const add = useCallback(async (name: string) => {
    const result = await addToRoster(name);
    // A name already on the list is not a failure worth a dialog — the store selects that
    // driver instead, which is almost always what was meant — so it reports no error here.
    setError(result.error === 'duplicate' ? null : result.error);
    return result.driver;
  }, []);

  const rename = useCallback(async (id: string, name: string) => {
    const result = await renameInRoster(id, name);
    setError(result.error);
    return result.error === null;
  }, []);

  const remove = useCallback(async (id: string) => {
    await removeFromRoster(id);
    setError(null);
  }, []);

  const select = useCallback(async (id: string | null) => {
    await setActiveInRoster(id);
    setError(null);
  }, []);

  return { roster, drivers: roster.drivers, active: activeDriver(roster), loaded, error, add, rename, remove, select };
}
