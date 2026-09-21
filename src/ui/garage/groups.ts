/**
 * The earlier runs, grouped by the night they were driven.
 *
 * Fifty identical rows in one list is where a garage starts to look like a file manager. A
 * heading per night is what a driver actually navigates by — "the Friday I finally got the
 * hairpin" — and it costs one pass over the index.
 *
 * A night ends at 05:00, not at midnight: a run at 01:30 belongs to the evening before it, and
 * splitting a session across two headings because the clock rolled over would be wrong in the
 * one case this app is built for.
 */
import type { SessionIndexEntry } from '../../platform';

/** Hour of the morning at which one night becomes the next. */
export const NIGHT_ROLLOVER_H = 5;

export interface RunGroup {
  /** Stable key: the night's calendar date. */
  key: string;
  /** `Fri 19 Sep` — absolute, so a screenshot of it says the same thing tomorrow. */
  label: string;
  runs: SessionIndexEntry[];
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** The date a run's night started on, as a local-time `Date` at midnight. */
function nightOf(ms: number): Date {
  const d = new Date(ms);
  if (d.getHours() < NIGHT_ROLLOVER_H) d.setDate(d.getDate() - 1);
  d.setHours(0, 0, 0, 0);
  return d;
}

export function groupByNight(entries: readonly SessionIndexEntry[]): RunGroup[] {
  const out: RunGroup[] = [];
  for (const entry of entries) {
    if (!Number.isFinite(entry.startedAt)) {
      // No date is its own group rather than a silent member of whichever came before it.
      out.push({ key: `undated-${entry.id}`, label: 'Undated', runs: [entry] });
      continue;
    }
    const night = nightOf(entry.startedAt);
    const key = `${night.getFullYear()}-${night.getMonth() + 1}-${night.getDate()}`;
    const tail = out[out.length - 1];
    if (tail && tail.key === key) tail.runs.push(entry);
    else out.push({ key, label: `${DAYS[night.getDay()]} ${night.getDate()} ${MONTHS[night.getMonth()]}`, runs: [entry] });
  }
  return out;
}
