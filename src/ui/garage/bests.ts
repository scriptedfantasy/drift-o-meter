/**
 * The board: one row per driver, ranked by the biggest angle they have held.
 *
 * It used to be four records per track — best grade, most points, biggest angle, longest
 * chain — and three of those four were arithmetic the user never asked for. What is left is
 * the one number a driver recognises and the one question several people sharing a car
 * actually argue about: who got it furthest sideways and kept it there.
 *
 * ── THE RANKING RULE ──────────────────────────────────────────────────────────────────────
 * Peak angle decides. Duration breaks ties, then the newer run. "Best drift" is the biggest
 * angle, longest held, and an angle that lasted a tenth of a second is not the same
 * achievement as the same angle carried through a corner — so the tie-break is part of the
 * definition rather than a way of settling a draw.
 *
 * ── THE TRUST GATE ────────────────────────────────────────────────────────────────────────
 * Only a run the engine vouched for can hold a place. This is the oldest rule on this screen
 * and it is the reason the board is worth looking at: a phone waved about in a parked car
 * produces an 85° "angle", bigger than anything any real run on the board holds, and the
 * integrity monitor is the only thing standing between that number and the top of the list
 * (see the contract on `SessionIntegrity.scoreTrusted`). A run it refused is COUNTED as a run
 * and can never be a record.
 *
 * ── THE UNASSIGNED BUCKET ─────────────────────────────────────────────────────────────────
 * A run may have no driver, and that is an answer rather than a gap: the roster starts empty
 * and the first run happens before anyone has typed a name. A run whose driver has since been
 * REMOVED reads the same way, because `driverById` answers null for both — one bucket, one
 * code path, `NO_DRIVER_LABEL` for the name. It is listed and ranked like anybody else. It is
 * never hidden, and it is never quietly reassigned to whoever is holding the phone now.
 *
 * Pure, and index-only: every figure here comes from `SessionIndexEntry`, so a whole season
 * ranks without opening one recording (`npx tsx tools/analysis/storage-census.ts`).
 */
import { driverById, NO_DRIVER_LABEL, type Roster } from '../../platform/drivers';
import type { SessionIndexEntry } from '../../platform';
import { peakHold, sidewaysSeconds } from './runFacts';

export const UNTRACKED = 'Unnamed road';

/** The name a run is filed under when the board names a track. */
export function trackKeyOf(entry: Pick<SessionIndexEntry, 'track'>): string {
  return entry.track && entry.track.trim() ? entry.track : UNTRACKED;
}

export interface DriverStanding {
  /**
   * The driver this row is for, or null for the unassigned bucket. A run whose stored
   * `driverId` names nobody on the roster any more lands here too — same bucket, same row.
   */
  driverId: string | null;
  /** What to print. The driver's name as they typed it, or `NO_DRIVER_LABEL`. */
  name: string;
  /** 1-based place on the board. 0 for a row with no angle to rank, which sorts to the end. */
  rank: number;
  /** Every stored run of theirs, vouched for or not. */
  runs: number;
  /** The ones the engine vouched for — the only ones that can hold the angle. */
  scored: number;
  /** The biggest angle they have held, in degrees. 0 when they hold none. */
  peakDeg: number;
  /**
   * How long the slide that reached it lasted. The tie-break, and the caption under the angle.
   *
   * A slide length, NOT a time at that angle — see `PeakHold.slideS`. The caption says "slide"
   * for that reason, and the day `SessionIndexEntry` carries the engine's `timeAtAngleS` it can
   * say "held" and mean it.
   */
  slideS: number;
  /**
   * Seconds sideways across the runs the engine vouched for, spins included.
   *
   * Gated on `trusted` like everything else on this board, because time sideways is a claim
   * about SLIDING and the monitor did not believe the sliding on a run it threw out. The
   * unassigned row's only run in the `night` set is the hand-held one, and this column read
   * "1:19 sideways" beside an angle the same row refuses to state.
   */
  sidewaysS: number;
  /** The run that holds the angle, for opening it. Empty when there is none. */
  id: string;
  /** When that run was driven, ms since epoch. */
  when: number;
  /** Their most recent run, ms since epoch — how the unranked rows are ordered. */
  lastAt: number;
  /** True when nothing of theirs has been vouched for yet, so the angle is a dash. */
  empty: boolean;
}

interface Bucket {
  driverId: string | null;
  name: string;
  entries: SessionIndexEntry[];
}

/**
 * The best of a driver's runs, by the ranking rule, or null when none of them can hold it.
 *
 * Non-positive angles are skipped rather than ranked at zero: a night of nothing but spins
 * holds no angle at all, and a row reading "0°, 1st" would be the board awarding a place for
 * failing to get sideways.
 */
function bestRun(entries: readonly SessionIndexEntry[]): { entry: SessionIndexEntry; deg: number; slideS: number } | null {
  let best: { entry: SessionIndexEntry; deg: number; slideS: number } | null = null;
  for (const entry of entries) {
    if (!entry.trusted) continue;
    const deg = entry.heldPeakDeg;
    if (!Number.isFinite(deg) || deg <= 0) continue;
    // The angle is the index's own authoritative figure; the trace says how long the slide ran.
    const slideS = peakHold(entry).slideS;
    if (!best || deg > best.deg || (deg === best.deg && slideS > best.slideS) || (deg === best.deg && slideS === best.slideS && entry.startedAt > best.entry.startedAt)) {
      best = { entry, deg, slideS };
    }
  }
  return best;
}

/**
 * Group every stored run by who drove it and rank the drivers by the biggest angle held.
 *
 * Drivers with nothing vouched for keep their row — they have been out, and a board that
 * drops them looks like it lost their runs — but they rank after everyone who holds an angle,
 * most recently driven first, and carry rank 0 so a screen can draw a dash instead of a place.
 */
export function driverStandings(entries: readonly SessionIndexEntry[], roster: Roster): DriverStanding[] {
  const buckets = new Map<string, Bucket>();
  for (const entry of entries) {
    // One lookup decides both cases the product treats alike: never claimed, and claimed by
    // someone since removed. `driverById` answers null for each.
    const driver = driverById(roster, entry.driverId);
    const key = driver?.id ?? '';
    const bucket = buckets.get(key);
    if (bucket) bucket.entries.push(entry);
    else buckets.set(key, { driverId: driver?.id ?? null, name: driver?.name ?? NO_DRIVER_LABEL, entries: [entry] });
  }

  const rows: DriverStanding[] = [];
  for (const bucket of buckets.values()) {
    const best = bestRun(bucket.entries);
    rows.push({
      driverId: bucket.driverId,
      name: bucket.name,
      rank: 0,
      runs: bucket.entries.length,
      scored: bucket.entries.filter((e) => e.trusted).length,
      peakDeg: best?.deg ?? 0,
      slideS: best?.slideS ?? 0,
      sidewaysS: bucket.entries.reduce((a, e) => a + (e.trusted ? sidewaysSeconds(e) : 0), 0),
      id: best?.entry.id ?? '',
      when: best?.entry.startedAt ?? 0,
      lastAt: bucket.entries.reduce((m, e) => Math.max(m, e.startedAt), 0),
      empty: best === null,
    });
  }

  rows.sort((a, b) => {
    if (a.empty !== b.empty) return a.empty ? 1 : -1;
    if (a.empty) return b.lastAt - a.lastAt;
    return b.peakDeg - a.peakDeg || b.slideS - a.slideS || b.when - a.when;
  });
  let place = 0;
  for (const row of rows) row.rank = row.empty ? 0 : ++place;
  return rows;
}

/**
 * What to print beside BIGGEST ANGLE: the track, when there is only one.
 *
 * The board ranks across every stored run, because the question it answers is who has held the
 * biggest angle — not who has held it here. So it may only be captioned with a track name when
 * every run really was driven on that track; otherwise it says how many, which is true. It read
 * "HARBOR CIRCUIT" over a board whose second-placed driver set his angle on a mountain road.
 */
export function boardTrack(entries: readonly SessionIndexEntry[]): string | null {
  if (entries.length === 0) return null;
  const tracks = new Set(entries.map(trackKeyOf));
  return tracks.size === 1 ? trackKeyOf(entries[0]) : `${tracks.size} tracks`;
}

export interface LastRunStanding {
  /** True when the run just done holds its driver's biggest angle. */
  isBest: boolean;
  /** Degrees short of that driver's biggest. Null when this run holds it. */
  behindDeg: number | null;
  /** True when it is the only run of theirs the engine has vouched for. */
  onlyScoredRun: boolean;
  /** The one line the last-run card prints. Never empty — null is returned instead. */
  line: string;
}

/**
 * What the run you just did did to your own biggest angle.
 *
 * A career screen's whole job, and the garage used to say nothing at all: the last run held
 * 56°, the board directly under it read 64°, and not one pixel connected the two.
 *
 * A run the engine would not vouch for gets nothing here. It holds no place and its angle is
 * not an angle the app will state, so there is nothing to compare — saying "4° off your best"
 * under a run whose angle the same card prints as `--` would be the screen quoting a number
 * it has just refused. And a driver's FIRST judged run is their best by arithmetic, which is
 * not an achievement; it says what it is instead.
 */
export function lastRunStanding(standings: readonly DriverStanding[], last: SessionIndexEntry | null, roster: Roster): LastRunStanding | null {
  if (!last || !last.trusted) return null;
  const driverId = driverById(roster, last.driverId)?.id ?? null;
  const row = standings.find((s) => s.driverId === driverId);
  if (!row || row.empty) return null;

  const isBest = row.id === last.id;
  const behindDeg = isBest ? null : Math.max(0, Math.round(row.peakDeg - last.heldPeakDeg));
  const onlyScoredRun = row.scored <= 1;

  const line = onlyScoredRun
    ? `First judged run in here — ${Math.round(row.peakDeg)}° is the bar to beat`
    : isBest
      ? `New biggest angle — ${Math.round(row.peakDeg)}°${row.slideS > 0 ? `, in a ${row.slideS.toFixed(1)} s slide` : ''}`
      : behindDeg === 0
        ? 'Level with the biggest angle on this board'
        : `${behindDeg}° off the biggest angle on this board`;

  return { isBest, behindDeg, onlyScoredRun, line };
}

/**
 * One driver's runs, newest first, in the order the index gave them.
 *
 * FILTER BEFORE GROUPING, never after. `groupByNight` does not sort: it coalesces ADJACENT
 * entries and trusts its input to be newest-first, so filtering a newest-first list keeps
 * that true and each night appears once. Grouping first and then splitting each night by
 * driver would produce the same date heading two and three times down one screen.
 *
 * `null` selects the unassigned bucket — the runs nobody claimed, and the runs whose driver
 * has since been forgotten, which are the same set as far as this screen is concerned.
 */
export function runsOf(entries: readonly SessionIndexEntry[], roster: Roster, driverId: string | null): SessionIndexEntry[] {
  return entries.filter((e) => (driverById(roster, e.driverId)?.id ?? null) === driverId);
}
