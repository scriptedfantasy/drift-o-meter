/**
 * The driver roster, persisted (AsyncStorage on native, localStorage on web).
 *
 * Same shape as `settings.ts`: one cached blob, a set of subscribers so every screen sees
 * a change at once, and a sanitiser between the disk and everything else. The rules about
 * what a roster may contain live in `driversSchema.ts`, which has no imports, so they can
 * be tested without touching storage.
 *
 * A write that fails is a warning, not a throw. Losing the roster costs the names on the
 * garage's leaderboard; it does not cost a run, because a run stores the driver's id in
 * its own record at the moment it is saved.
 */
import {
  activeDriver,
  addDriver as addToRoster,
  EMPTY_ROSTER,
  removeDriver as removeFromRoster,
  renameDriver as renameInRoster,
  sanitizeRoster,
  setActiveDriver as setActiveInRoster,
  type AddDriverError,
  type Driver,
  type Roster,
} from './driversSchema';
import { kv } from './kv';

export * from './driversSchema';

const KEY = 'dom.drivers.v1';

type Listener = (r: Roster) => void;
const listeners = new Set<Listener>();
let cache: Roster | null = null;

export async function loadRoster(): Promise<Roster> {
  if (cache) return cache;
  try {
    const raw = await kv.getItem(KEY);
    cache = raw ? sanitizeRoster(JSON.parse(raw)) : { ...EMPTY_ROSTER };
  } catch (err) {
    console.warn('[drivers] could not read the roster, starting empty', err);
    cache = { ...EMPTY_ROSTER };
  }
  return cache;
}

async function commit(next: Roster): Promise<Roster> {
  cache = next;
  for (const l of listeners) l(next);
  try {
    await kv.setItem(KEY, JSON.stringify(next));
  } catch (err) {
    console.warn('[drivers] could not persist the roster', err);
  }
  return next;
}

export interface AddOutcome {
  roster: Roster;
  driver: Driver | null;
  error: AddDriverError | null;
}

/** Add a driver and put them at the wheel. An existing name selects them instead. */
export async function addDriver(name: string): Promise<AddOutcome> {
  const result = addToRoster(await loadRoster(), name);
  if (result.roster === cache) return { ...result };
  return { ...result, roster: await commit(result.roster) };
}

export async function renameDriver(id: string, name: string): Promise<{ roster: Roster; error: AddDriverError | null }> {
  const result = renameInRoster(await loadRoster(), id, name);
  if (result.roster === cache) return result;
  return { ...result, roster: await commit(result.roster) };
}

/** Forget a driver. Their runs stay, and become unassigned. */
export async function removeDriver(id: string): Promise<Roster> {
  return commit(removeFromRoster(await loadRoster(), id));
}

export async function setActiveDriver(id: string | null): Promise<Roster> {
  return commit(setActiveInRoster(await loadRoster(), id));
}

export function subscribeRoster(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** The last loaded roster without awaiting (empty before the first load). */
export function peekRoster(): Roster {
  return cache ?? EMPTY_ROSTER;
}

/**
 * Who the next run belongs to, without awaiting.
 *
 * The drive screen calls this at the instant it starts recording, which is the one moment
 * that must not wait on storage. Null is a real answer: nobody has said who is driving,
 * and the run is saved unassigned rather than blocking the start of it.
 */
export function peekActiveDriverId(): string | null {
  return activeDriver(peekRoster())?.id ?? null;
}

/** Test seam: drop the cache so the next load re-reads storage. */
export function resetRosterCache(): void {
  cache = null;
}
