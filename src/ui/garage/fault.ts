/**
 * What a screen says when STORAGE itself is the problem, in one place, so that every screen
 * which counts stored runs says the same thing about them.
 *
 * The state this exists for: recordings on the device and an index that will not parse. The
 * garage used to draw "THE GARAGE · EMPTY · FIRST RUN · NOTHING TO BEAT YET" over it, and the
 * next save wrote a fresh one-entry index and orphaned every body permanently. `/settings` then
 * made the same mistake one tap away and worse: `sessions.entries.length` is 0 when
 * `listSessions()` THREW, so the Data section read "0 stored runs" over six recordings and
 * greyed out DELETE ALL RUNS — the one repair that deletes orphaned bodies, refused in the exact
 * case it was written for.
 *
 * Pure, and free of React, so both screens derive their copy from the same diagnosis rather than
 * from whatever their own list happens to have in it.
 */
import type { StorageDiagnosis } from '../../platform/sessionStore';

/** Something a screen has to explain, with the repair when there is one. */
export interface GarageFault {
  kind: 'unreadable-index' | 'ephemeral' | 'error';
  level: 'bad' | 'warn';
  title: string;
  body: string;
  /** Label for the repair, or null when there is nothing to offer. */
  action: string | null;
}

/** "6 recordings are still on this device", and what to say when the device cannot count. */
function keptText(n: number | null): string {
  if (n === null) return 'Your recordings are still on this device.';
  if (n === 0) return 'There are no recordings on this device to rebuild it from.';
  return n === 1 ? '1 recording is still on this device.' : `${n} recordings are still on this device.`;
}

export function faultFor(d: StorageDiagnosis | null, error: string | null): GarageFault | null {
  if (d && d.index === 'unreadable') {
    const n = d.recordings;
    return {
      kind: 'unreadable-index',
      level: 'bad',
      title: 'Your run list could not be read',
      body: `${keptText(n)} Rebuilding reads each one and writes a new list. Nothing is deleted, and nothing new is saved until you choose.`,
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

/**
 * How many runs a screen may honestly say are stored, and whether that figure is the RUN LIST or
 * the recordings behind it.
 *
 * When the index parses, the list is the answer. When it does not, the list is empty for a
 * reason that has nothing to do with what is on the device, so the bodies are counted instead —
 * and `counted: 'recordings'` tells the screen to say which number it is showing. A device that
 * cannot enumerate its bodies gets `null`: unknown, which is not zero.
 */
export interface StoredRuns {
  count: number | null;
  counted: 'index' | 'recordings';
}

export function storedRuns(entries: readonly unknown[], d: StorageDiagnosis | null): StoredRuns {
  if (d && d.index === 'unreadable') return { count: d.recordings, counted: 'recordings' };
  return { count: entries.length, counted: 'index' };
}
