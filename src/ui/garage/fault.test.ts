/**
 * What a screen says about storage when storage is the thing that is wrong — and, in the case
 * this file was extracted for, what it lets a driver DO about it.
 *
 * `/settings` derived both from `useSessionIndex().entries.length`, which is 0 when
 * `listSessions()` THREW. So the Data section read "0 stored runs" over six recordings and
 * greyed out DELETE ALL RUNS — the one repair `clearSessions` was written for, since it deletes
 * every body the device can name whether or not the index still names it, and rewrites the
 * index. The count and the button now come from the diagnosis, which asks storage.
 *
 * These are run against the store's own `diagnose()` as well as against hand-made diagnoses, so
 * the shapes cannot drift apart from what the store really returns.
 */
import { describe, expect, it } from 'vitest';

import { createMemoryBackend, createSessionStore, summarizeSession, type StorageDiagnosis } from '../../platform/sessionStore';
import type { Session } from '../../engine/types';
import { canDeleteAll, deleteAllDetail, faultFor, storedRuns, storedRunsText } from './fault';

function diagnosis(over: Partial<StorageDiagnosis> = {}): StorageDiagnosis {
  return { index: 'ok', recordings: 0, ephemeral: false, ...over };
}

/** The smallest thing the store will accept as a session. */
function session(id: string, startedAt: number): Session {
  return {
    version: 1,
    id,
    name: `Run ${id}`,
    startedAt,
    durationS: 60,
    motion: [],
    gps: [],
    states: [],
    drifts: [],
    score: { total: 0, grade: 'D', trusted: true, perDrift: {} },
  } as unknown as Session;
}

describe('what a screen says when storage is at fault', () => {
  it('says nothing when there is nothing to say', () => {
    expect(faultFor(diagnosis(), null)).toBeNull();
    expect(faultFor(null, null)).toBeNull();
  });

  it('names an unreadable list and counts the recordings behind it', () => {
    const fault = faultFor(diagnosis({ index: 'unreadable', recordings: 6 }), null);
    expect(fault?.kind).toBe('unreadable-index');
    expect(fault?.level).toBe('bad');
    expect(fault?.title).toBe('Your run list could not be read');
    expect(fault?.body).toContain('6 recordings are still on this device');
    expect(fault?.action).toBe('Rebuild the list');
    expect(faultFor(diagnosis({ index: 'unreadable', recordings: 1 }), null)?.body).toContain('1 recording is still');
  });

  it('offers no rebuild it cannot perform', () => {
    // Nothing to rebuild FROM, and a device that cannot enumerate what it holds. Offering the
    // button in either case would be offering a repair that fails when it is pressed.
    expect(faultFor(diagnosis({ index: 'unreadable', recordings: 0 }), null)?.action).toBeNull();
    expect(faultFor(diagnosis({ index: 'unreadable', recordings: null }), null)?.action).toBeNull();
    expect(faultFor(diagnosis({ index: 'unreadable', recordings: null }), null)?.body).toContain('still on this device');
  });

  it('carries a listing error through in the words it arrived in', () => {
    const fault = faultFor(diagnosis(), 'the session index is not valid JSON');
    expect(fault?.kind).toBe('error');
    expect(fault?.body).toBe('the session index is not valid JSON');
    expect(fault?.action).toBeNull();
  });

  it('warns about a browser that keeps nothing, and only once nothing worse is wrong', () => {
    expect(faultFor(diagnosis({ ephemeral: true }), null)?.kind).toBe('ephemeral');
    expect(faultFor(diagnosis({ ephemeral: true }), null)?.level).toBe('warn');
    // An unreadable index is the bigger fact, and two notices at once is neither.
    expect(faultFor(diagnosis({ index: 'unreadable', recordings: 2, ephemeral: true }), null)?.kind).toBe('unreadable-index');
  });
});

describe('how many runs a screen may say it is holding', () => {
  it('is the list, when the list can be read', () => {
    expect(storedRuns([1, 2, 3], diagnosis({ recordings: 3 }))).toEqual({ count: 3, counted: 'index' });
    expect(storedRunsText(storedRuns([1, 2, 3], diagnosis()))).toBe('3 stored runs.');
    expect(storedRunsText(storedRuns([1], diagnosis()))).toBe('1 stored run.');
    expect(storedRunsText(storedRuns([], diagnosis()))).toBe('0 stored runs.');
  });

  it('is NOT the list when the list is what is broken', () => {
    // The whole finding: entries is [] because listSessions threw, and six bodies are on disk.
    const d = diagnosis({ index: 'unreadable', recordings: 6 });
    expect(storedRuns([], d)).toEqual({ count: 6, counted: 'recordings' });
    expect(storedRunsText(storedRuns([], d))).toBe('6 recordings on this device.');
    expect(storedRunsText(storedRuns([], d))).not.toMatch(/^0 /);
    expect(storedRunsText(storedRuns([], d))).not.toMatch(/stored runs/);
    // …and the section it heads says WHY the count is of recordings rather than of runs.
    expect(faultFor(d, null)?.title).toMatch(/could not be read/);
    expect(storedRunsText(storedRuns([], diagnosis({ index: 'unreadable', recordings: 1 })))).toBe('1 recording on this device.');
  });

  it('says unknown rather than zero when the device cannot count', () => {
    const d = diagnosis({ index: 'unreadable', recordings: null });
    expect(storedRuns([], d).count).toBeNull();
    expect(storedRunsText(storedRuns([], d))).not.toMatch(/\b0\b/);
  });

  it('tells the confirmation what is actually about to go', () => {
    expect(deleteAllDetail({ count: 6, counted: 'index' })).toBe('6 runs will be deleted');
    expect(deleteAllDetail({ count: 1, counted: 'index' })).toBe('1 run will be deleted');
    expect(deleteAllDetail({ count: 6, counted: 'recordings' })).toBe('6 recordings will be deleted');
    expect(deleteAllDetail({ count: null, counted: 'recordings' })).toBe('Every recording on this device will be deleted');
  });
});

describe('whether DELETE ALL RUNS has anything to do', () => {
  it('is off only when there is genuinely nothing stored', () => {
    expect(canDeleteAll(0, diagnosis())).toBe(false);
    expect(canDeleteAll(3, diagnosis({ recordings: 3 }))).toBe(true);
  });

  it('stays ON over an unreadable index, which is what it was written for', () => {
    // Every rung of the ambiguous case: the list is empty because it threw, so the only honest
    // signal is what is on the device — and even with nothing there, the wipe rewrites the index
    // and is the only repair left once a rebuild has nothing to read.
    expect(canDeleteAll(0, diagnosis({ index: 'unreadable', recordings: 6 }))).toBe(true);
    expect(canDeleteAll(0, diagnosis({ index: 'unreadable', recordings: 1 }))).toBe(true);
    expect(canDeleteAll(0, diagnosis({ index: 'unreadable', recordings: 0 }))).toBe(true);
    expect(canDeleteAll(0, diagnosis({ index: 'unreadable', recordings: null }))).toBe(true);
  });

  it('stays ON over orphaned bodies a readable index does not name', () => {
    expect(canDeleteAll(0, diagnosis({ recordings: 2 }))).toBe(true);
  });

  it('falls back to the list while the diagnosis has not arrived', () => {
    expect(canDeleteAll(0, null)).toBe(false);
    expect(canDeleteAll(4, null)).toBe(true);
  });
});

describe('against the store itself', () => {
  it('reads a truncated index as unreadable, counts the bodies, and lets the wipe repair it', async () => {
    const backend = createMemoryBackend();
    const store = createSessionStore(backend);
    await store.saveSession(session('run-a', 2_000));
    await store.saveSession(session('run-b', 1_000));
    // The harness's own break: the index truncated to 40 characters.
    backend.index = (backend.index ?? '').slice(0, 40);

    const store2 = createSessionStore(backend);
    await expect(store2.listSessions()).rejects.toThrow();
    const d = await store2.diagnose();
    expect(d.index).toBe('unreadable');
    expect(d.recordings).toBe(2);

    // What the screen would have said, and what it says now.
    expect(storedRuns([], d)).toEqual({ count: 2, counted: 'recordings' });
    expect(canDeleteAll(0, d)).toBe(true);
    expect(faultFor(d, 'your run list could not be read.')?.action).toBe('Rebuild the list');

    await store2.clearSessions();
    expect(backend.bodies.size).toBe(0);
    const after = await store2.diagnose();
    expect(after.index).toBe('ok');
    expect(after.recordings).toBe(0);
    expect(canDeleteAll(0, after)).toBe(false);
    expect(storedRunsText(storedRuns(await store2.listSessions(), after))).toBe('0 stored runs.');
  });

  it('summarises a real session into the list the count is taken from', () => {
    // Guards the other half: `storedRuns` counts index ENTRIES, so the entry shape has to be the
    // one `listSessions` returns.
    const entry = summarizeSession(session('run-a', 2_000));
    expect(storedRuns([entry], diagnosis({ recordings: 1 }))).toEqual({ count: 1, counted: 'index' });
  });
});
