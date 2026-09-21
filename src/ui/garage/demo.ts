/**
 * Demo sessions: `/?demo=night` fills the session list with real, deterministic runs so the
 * garage can be developed, reviewed and photographed without driving anywhere.
 *
 * Nothing here is mocked. Each run is built by the results screen's own fixture builder
 * (`buildFixtureSession` → the simulator, and for the hand-held one the REAL engine pipeline),
 * which puts the REAL engine's own numbers on the session before it is stored — so the angle
 * in the list is the angle the results screen shows. This used to re-run the results model
 * afterwards and write its verdict back over the top, which meant the garage could never
 * depict a disagreement between the pipeline and a re-score, and a real run can.
 *
 * A SET ALSO SEEDS A ROSTER. Several people share one car, the board ranks them, and a demo
 * with six runs and nobody driving them would photograph the one screen where the feature is
 * invisible. Each set names its drivers and leaves at least one run unclaimed, because that
 * is a state the app really has.
 *
 * Two economies keep this honest and cheap:
 *   • the bodies are stored TRIMMED — no motion, GPS, state or truth arrays (10 MB each, far
 *     past a browser's localStorage quota). Everything the garage reads (score, drifts,
 *     integrity, calibration, meta) survives.
 *   • every id is `fixture-<name>`, which is exactly what `/results/fixture-<name>` rebuilds
 *     from the simulator, so tapping a row shows the full run, samples and all. Seed overrides
 *     ride in `Session.meta.fixtureQuery`, which the garage reads when a row is opened.
 *
 * `saveSession` re-summarises through `summarizeSession`, so every seeded run lands in the
 * index with `trusted`, `heldPeakDeg`, `spins`, the mount verdict and the slide trace filled in.
 */
import type { Session } from '../../engine/types';
import { clearSessions, listSessions, saveSession } from '../../platform';
import { addDriver, loadRoster, removeDriver, setActiveDriver } from '../../platform/drivers';
import { buildFixtureSession, FIXTURES, type FixtureSpec } from '../results/fixture';
import { forgetDetails } from './lastRun';

export interface DemoRun {
  /** A key of `FIXTURES` — the id becomes `fixture-<key>`, which the results screen rebuilds. */
  fixture: keyof typeof FIXTURES & string;
  /** Seed override. Also sets the run's clock: the fixture dates it 21:44 + seed minutes. */
  seed: number;
  /**
   * Who drove it, or absent for nobody.
   *
   * Every set leaves at least one run UNCLAIMED on purpose. A run with no driver is the state
   * the app really starts in — the roster is empty and the first run happens before anyone has
   * typed a name — and it is the one the board has to be able to draw without hiding it. A
   * demo set in which everybody had a name would photograph a product that cannot happen.
   */
  driver?: string;
}

/**
 * A believable night out, newest first. The seeds are chosen so no two runs share a minute
 * (the fixture builder dates a run `21:44 + seed` on 19 Sep 2026) and so the set covers what
 * the list has to be able to say: a hero lap, a spin, a scruffy run, a different track, and one
 * recording the engine refuses to judge at all.
 *
 * The names are the ones on the approved mockup. Three drivers is what makes the board a board
 * — with one, "1st" is arithmetic — and the run nobody claimed is what makes it honest.
 */
export const DEMO_SETS: Record<string, DemoRun[]> = {
  /** Six runs across two tracks: three drivers, one run unclaimed, one run not judged. */
  night: [
    { fixture: 'good', seed: 7, driver: 'Lukas' },
    { fixture: 'touge', seed: 5, driver: 'Marco' },
    { fixture: 'spin', seed: 4, driver: 'Lukas' },
    { fixture: 'hero', seed: 3, driver: 'Marco' },
    { fixture: 'sloppy', seed: 1, driver: 'Sam' },
    // Nobody's: the phone was in a hand, and nobody had said who was driving either.
    { fixture: 'handheld', seed: 0 },
  ],
  /** A driver who has been out exactly once. */
  first: [{ fixture: 'good', seed: 7, driver: 'Lukas' }],
  /**
   * The last run was hand-held and thrown out — the one case where the garage has something to
   * say about the mount. Newest first, so the rejected run is the card AND the notice.
   */
  flagged: [
    { fixture: 'handheld', seed: 9, driver: 'Lukas' },
    { fixture: 'good', seed: 7, driver: 'Lukas' },
    { fixture: 'spin', seed: 4, driver: 'Marco' },
    { fixture: 'sloppy', seed: 1 },
  ],
  /**
   * A night that ended in spins. The NEWEST run is the scruffy one — eleven slides, three of
   * them spun — because the slide count on the last-run card is the only place the app can say
   * "8 of 11 · 3 spun", and `night` happens to end on a clean run. Seed 12 dates it 21:56, after
   * everything else in the set.
   */
  spun: [
    { fixture: 'sloppy', seed: 12, driver: 'Lukas' },
    { fixture: 'spin', seed: 4, driver: 'Lukas' },
    { fixture: 'good', seed: 7, driver: 'Marco' },
  ],
  /** One track, four judged runs across three drivers: the board with something to argue about. */
  harbor: [
    { fixture: 'good', seed: 7, driver: 'Lukas' },
    { fixture: 'spin', seed: 4, driver: 'Marco' },
    { fixture: 'hero', seed: 3, driver: 'Lukas' },
    { fixture: 'sloppy', seed: 1, driver: 'Sam' },
  ],
};

/** The drivers a set names, in the order it first names them. First one goes at the wheel. */
export function demoDrivers(set: string): string[] {
  const out: string[] = [];
  for (const run of DEMO_SETS[set] ?? []) if (run.driver && !out.includes(run.driver)) out.push(run.driver);
  return out;
}

export const DEMO_NAMES = Object.keys(DEMO_SETS);

/**
 * Everything a stored session needs except the several megabytes of raw samples.
 *
 * ONE state sample survives. It is the run's clock origin, and `summarizeSession` normalises
 * the slide trace against it — so a trimmed demo run and a full recording summarise to exactly
 * the same shape. Dropping it would have made the shipped screenshots the only ones drawn from
 * a different origin than a real run's, which is the kind of divergence that hides bugs.
 */
function trim(session: Session): Session {
  return { ...session, motion: [], gps: [], states: session.states.length > 0 ? [session.states[0]] : [], truth: undefined };
}

/**
 * Build one demo run and store it, exactly as the engine left it.
 *
 * WHAT GETS STORED matters, and the rule is: whatever a real run would have stored. A
 * `pipeline` fixture has been through the real `DriftPipeline`; a `sim` one is re-measured by
 * the real engine inside `buildFixtureSession`. Either way the session that reaches storage is
 * the producer's own, and this function does not second-guess it.
 *
 * It used to: it re-ran the results screen's model over every `sim` fixture and wrote the
 * verdict back onto `Session.score`. That coupled seeding a demo to the shape of a screen's
 * view model — a field renamed on the results screen silently changed what the garage had in
 * storage — and it guaranteed agreement between the two, which is the one thing a real run
 * does not guarantee. Both reasons outlived the fields it was copying.
 */
export async function seedDemoRun(run: DemoRun, driverId: string | null = null): Promise<void> {
  const base = FIXTURES[run.fixture];
  if (!base) return;
  const spec: FixtureSpec = { ...base, seed: run.seed };
  const session = buildFixtureSession(spec);
  session.driverId = driverId;
  session.meta = { ...session.meta, source: 'simulation', demo: true };
  await saveSession(trim(session));
  forgetDetails(session.id);
}

export interface SeedProgress {
  done: number;
  total: number;
}

/**
 * Replace the roster with the one this set names, and hand back name → id.
 *
 * It wipes first, because a set is a whole state rather than an addition: re-seeding over a
 * roster left by another set would leave a driver on the board with no runs under them and no
 * way to tell that from a driver who has been out and had everything thrown out.
 *
 * The first name goes at the wheel. `addDriver` makes each new driver active as it goes, so
 * without that last line the active driver would be whoever the set happens to list last.
 */
async function seedRoster(names: readonly string[]): Promise<Map<string, string>> {
  for (const existing of (await loadRoster()).drivers) await removeDriver(existing.id);
  const ids = new Map<string, string>();
  for (const name of names) {
    const { driver } = await addDriver(name);
    if (driver) ids.set(name, driver.id);
  }
  await setActiveDriver(ids.get(names[0] ?? '') ?? null);
  return ids;
}

/**
 * Put a demo set into storage, replacing whatever is there. Reports progress after each run
 * (a set takes 1–2 s: the hand-held one goes through the whole engine pipeline).
 */
export async function seedDemoSessions(set: string, onProgress?: (p: SeedProgress) => void): Promise<number> {
  const runs = DEMO_SETS[set];
  if (!runs) return 0;
  await clearSessions();
  forgetDetails();
  const ids = await seedRoster(demoDrivers(set));
  onProgress?.({ done: 0, total: runs.length });
  // oldest first, so the index is written in the order a driver would have made them
  const ordered = [...runs].reverse();
  let done = 0;
  for (const run of ordered) {
    await seedDemoRun(run, run.driver ? (ids.get(run.driver) ?? null) : null);
    done++;
    onProgress?.({ done, total: runs.length });
    // let the screen paint between runs
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  return runs.length;
}

/** Empty the garage (`/?demo=none`) — the runs and the names that were only there for them. */
export async function clearDemoSessions(): Promise<void> {
  await clearSessions();
  await seedRoster([]);
  forgetDetails();
}

/**
 * Resolve the `?demo=` parameter. `none`/`clear`/`empty` wipes, a set name seeds it, anything
 * else is ignored. Returns null when the URL does not ask for anything.
 */
export function resolveDemoRequest(value: string | undefined | null): { kind: 'clear' } | { kind: 'seed'; set: string } | null {
  if (value === undefined || value === null) return null;
  const v = value.trim().toLowerCase();
  if (v === '') return null;
  if (v === 'none' || v === 'clear' || v === 'empty' || v === '0' || v === 'false') return { kind: 'clear' };
  if (v === '1' || v === 'true' || v === 'on' || v === 'yes') return { kind: 'seed', set: 'night' };
  return DEMO_SETS[v] ? { kind: 'seed', set: v } : null;
}

/** True when storage already holds exactly this set, so a re-render does not rebuild it. */
export async function demoSetPresent(set: string): Promise<boolean> {
  const runs = DEMO_SETS[set];
  if (!runs) return false;
  // A damaged index throws rather than reading as empty; re-seeding repairs it, so say no.
  let stored;
  try {
    stored = await listSessions();
  } catch {
    return false;
  }
  if (stored.length !== runs.length) return false;
  const ids = new Set(stored.map((e) => e.id));
  if (!runs.every((r) => ids.has(`fixture-${r.fixture}`))) return false;
  // The roster is half of a set. Runs present but nobody on the board means the names were
  // cleared under us — every row would read as unassigned, which is a real state of the app
  // but not the one this set is for, so say no and let it re-seed.
  const claimed = new Set(stored.map((e) => e.driverId).filter((id): id is string => id !== null));
  return claimed.size === demoDrivers(set).length;
}
