/**
 * Who is driving.
 *
 * Several people share one car and one phone, so a run belongs to a person, not to the
 * device. This is the whole of that idea: a list of names kept on this phone, and which
 * of them is currently at the wheel. No accounts, no server, no identity — two drivers
 * called Sam on two different phones are simply two different people and nothing here
 * pretends otherwise.
 *
 * A run may have NO driver, and that is a real answer rather than a gap to be filled.
 * The roster starts empty, the first run happens before anyone has typed a name, and
 * forcing a name out of someone who is sitting in a car about to drive is exactly the
 * wrong moment to ask. So `driverId` is nullable everywhere it appears, an unassigned run
 * is listed rather than hidden, and the garage offers to put a name to it afterwards.
 *
 * Pure and dependency-free so the tests and the sanitiser can be exercised without
 * touching storage; `drivers.ts` adds persistence and subscribers on top.
 */

export interface Driver {
  /** Stable, opaque, and only meaningful on this phone. */
  id: string;
  /** What the driver typed. Shown verbatim; uppercased by the styles, not by the data. */
  name: string;
  /** ms since epoch. Ties in the roster order break by this, so it has to be stored. */
  createdAt: number;
}

export interface Roster {
  version: 1;
  drivers: Driver[];
  /**
   * Who the next run is recorded as, or null for nobody.
   *
   * Always either null or an id present in `drivers` — the sanitiser guarantees it, so a
   * screen may look the active driver up without handling a dangling id. Removing the
   * active driver clears this rather than leaving it pointing at a ghost.
   */
  activeId: string | null;
}

export const EMPTY_ROSTER: Roster = { version: 1, drivers: [], activeId: null };

/**
 * Longest name we will store.
 *
 * The garage lays the roster out as a row of chips across a 390 pt screen; at the chip's
 * type size about sixteen characters fit before a third chip stops fitting on the line.
 * Longer names are not rejected — someone typing their full name should not be argued
 * with — they are cut here, once, so that every screen downstream can lay out without
 * measuring text.
 */
export const MAX_NAME = 16;

/** The most drivers one phone holds. Past this the chip row stops being a way to choose. */
export const MAX_DRIVERS = 12;

/**
 * Trim, collapse inner whitespace, and cut to `MAX_NAME`.
 *
 * Deliberately NOT uppercased. The garage draws names in condensed caps, which is a
 * styling decision the display layer is free to change its mind about; storing them
 * shouted would throw away what the person actually typed and there is no getting it back.
 */
export function normalizeName(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
}

/**
 * Two names collide when they differ only by case, spacing or accent.
 *
 * "sam", "Sam" and "SAM " are one person at the track, and a roster that lists them three
 * times is useless for the one thing it exists to do. `localeCompare` with sensitivity
 * 'base' is what treats é and e as the same letter; a plain lowercase comparison does not.
 */
export function sameName(a: string, b: string): boolean {
  return normalizeName(a).localeCompare(normalizeName(b), undefined, { sensitivity: 'base' }) === 0;
}

/**
 * A short, collision-resistant, sortable-ish id.
 *
 * Time prefix so that ids from one phone sort roughly by creation, and four random
 * characters so two drivers added in the same millisecond do not collide. Not a UUID:
 * this never leaves the device and never joins anything, so 20 bits of entropy against
 * a roster capped at twelve is ample.
 */
export function newDriverId(now: number = Date.now()): string {
  const t = Math.max(0, Math.floor(now)).toString(36);
  let r = '';
  for (let i = 0; i < 4; i++) r += Math.floor(Math.random() * 36).toString(36);
  return `d${t}${r}`;
}

function sanitizeDriver(raw: unknown, fallbackTime: number): Driver | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const name = normalizeName(r.name);
  if (!name) return null;
  const id = typeof r.id === 'string' && r.id.length > 0 && r.id.length <= 64 ? r.id : newDriverId(fallbackTime);
  const createdAt = typeof r.createdAt === 'number' && Number.isFinite(r.createdAt) && r.createdAt > 0 ? r.createdAt : fallbackTime;
  return { id, name, createdAt };
}

/**
 * Coerce anything — an older version, hand-edited JSON, a half-written file — into a
 * valid roster.
 *
 * Drops nameless and malformed entries, de-duplicates by name and by id keeping the
 * earliest, caps the length, and clears `activeId` when it does not name a surviving
 * driver. Never throws: a corrupt roster costs the names, not the app.
 */
export function sanitizeRoster(raw: unknown, now: number = Date.now()): Roster {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const list = Array.isArray(r.drivers) ? r.drivers : [];

  const out: Driver[] = [];
  const ids = new Set<string>();
  for (const entry of list) {
    if (out.length >= MAX_DRIVERS) break;
    const d = sanitizeDriver(entry, now);
    if (!d) continue;
    if (ids.has(d.id)) continue;
    if (out.some((existing) => sameName(existing.name, d.name))) continue;
    ids.add(d.id);
    out.push(d);
  }

  const wanted = typeof r.activeId === 'string' ? r.activeId : null;
  return { version: 1, drivers: out, activeId: wanted && ids.has(wanted) ? wanted : null };
}

/** The active driver, or null. Safe against a dangling id even on an unsanitised roster. */
export function activeDriver(roster: Roster): Driver | null {
  if (!roster.activeId) return null;
  return roster.drivers.find((d) => d.id === roster.activeId) ?? null;
}

/** Look a driver up by id. Null for null, and null for an id nobody holds. */
export function driverById(roster: Roster, id: string | null | undefined): Driver | null {
  if (!id) return null;
  return roster.drivers.find((d) => d.id === id) ?? null;
}

/**
 * What to print where a driver's name goes when there is no driver.
 *
 * One string, in one place, because "no driver" shows up in the garage list, the
 * leaderboard and the run review, and three screens inventing three different words for
 * the same absence is how a product starts to feel unfinished.
 */
export const NO_DRIVER_LABEL = 'Unassigned';

export type AddDriverError = 'empty' | 'duplicate' | 'full';

export interface AddResult {
  roster: Roster;
  driver: Driver | null;
  error: AddDriverError | null;
}

/**
 * Add a driver and make them active.
 *
 * Adding a name that is already in the roster is not an error worth a dialog — it is
 * almost always someone re-picking themselves — so it selects the existing driver and
 * reports `duplicate` for a caller that wants to say so quietly.
 */
export function addDriver(roster: Roster, rawName: string, now: number = Date.now()): AddResult {
  const name = normalizeName(rawName);
  if (!name) return { roster, driver: null, error: 'empty' };

  const existing = roster.drivers.find((d) => sameName(d.name, name));
  if (existing) return { roster: { ...roster, activeId: existing.id }, driver: existing, error: 'duplicate' };

  if (roster.drivers.length >= MAX_DRIVERS) return { roster, driver: null, error: 'full' };

  const driver: Driver = { id: newDriverId(now), name, createdAt: now };
  return { roster: { ...roster, drivers: [...roster.drivers, driver], activeId: driver.id }, driver, error: null };
}

/** Rename in place. A name that collides with someone else is refused, not merged. */
export function renameDriver(roster: Roster, id: string, rawName: string): { roster: Roster; error: AddDriverError | null } {
  const name = normalizeName(rawName);
  if (!name) return { roster, error: 'empty' };
  if (roster.drivers.some((d) => d.id !== id && sameName(d.name, name))) return { roster, error: 'duplicate' };
  return { roster: { ...roster, drivers: roster.drivers.map((d) => (d.id === id ? { ...d, name } : d)) }, error: null };
}

/**
 * Remove a driver from the roster.
 *
 * Their runs are NOT touched. A run records the id it was driven under, and deleting the
 * name must not silently reassign a season of someone's runs to whoever is holding the
 * phone now — the garage lists those runs as unassigned, which is true, and they can be
 * put back by adding the name again only if the id survives, which it does not. That is
 * the honest cost of removing a driver and the confirmation copy says so.
 */
export function removeDriver(roster: Roster, id: string): Roster {
  const drivers = roster.drivers.filter((d) => d.id !== id);
  return { version: 1, drivers, activeId: roster.activeId === id ? null : roster.activeId };
}

/** Put someone at the wheel, or nobody. An unknown id clears the selection. */
export function setActiveDriver(roster: Roster, id: string | null): Roster {
  if (id === null) return { ...roster, activeId: null };
  return { ...roster, activeId: roster.drivers.some((d) => d.id === id) ? id : null };
}
