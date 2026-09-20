/**
 * Every StorageError message is shown to the driver verbatim — the drive display puts it on
 * screen when a finished run fails to save, and the results screen completes a sentence with it.
 * So these tests assert the PROSE, not just the code: no quoted keys, no function names, no
 * internal ids. The technical string belongs in `detail`, which is what a log gets.
 *
 * This guards a real regression: the native save path used to tell a driver who had just
 * finished the run of their life `Could not save session "20260920-134201-k3f9".`
 */
import { afterEach, describe, expect, it } from 'vitest';

import type { Session } from '../engine/types';
import { StorageError } from './kvTypes';
import { backend as webBackend } from './sessionBackend.web';
import { createSessionStore, type SessionBackend } from './sessionStore';

/** Nothing a driver can act on: quoted identifiers, storage keys, call names, type jargon. */
const JARGON = /["`]|dom\.|setItem|getItem|writeBody|readBody|deleteBody|JSON|undefined|null|Error|\bid\b/i;

function expectDriverProse(err: unknown): StorageError {
  expect(err).toBeInstanceOf(StorageError);
  const e = err as StorageError;
  expect(e.message, `message is shown to the driver: ${e.message}`).not.toMatch(JARGON);
  // Reads as a sentence, not as a token. A fragment is fine — the results screen completes it —
  // but it has to be words, and it has to end.
  expect(e.message.trim().split(/\s+/).length, `not a sentence: ${e.message}`).toBeGreaterThanOrEqual(4);
  expect(e.message.trim(), `no full stop: ${e.message}`).toMatch(/\.$/);
  return e;
}

function fakeSession(id: string, samples = 3): Session {
  return {
    version: 1,
    id,
    name: 'Run',
    startedAt: 1,
    durationS: 120,
    motion: Array.from({ length: samples }, (_, i) => ({ t: i / 100, accel: { x: 0, y: 0, z: 0 }, gravity: { x: 0, y: 0, z: -9.81 }, rotationRate: { x: 0, y: 0, z: 0 } })),
    gps: [],
    states: [],
    drifts: [],
    score: { total: 1, grade: 'D', angle: 0, consistency: 0, quality: 0, speed: 0, style: 0, bestDriftId: null, longestChainPoints: 0, perDrift: {}, trusted: true },
    track: null,
    calibration: { r: [1, 0, 0, 0, 1, 0, 0, 0, 1], quality: 0, forwardResolved: false, t: 0 },
    integrity: { mount: 'rigid', physics: 'ok', gps: 'good', implausibleDriftFraction: 0, suppressedS: 0, scoreTrusted: true, message: '' },
    meta: { track: 'Harbor' },
  };
}

/** A localStorage that runs out of room at `limit` bytes, the way a full phone does. */
function installFakeLocalStorage(limit: number) {
  const map = new Map<string, string>();
  const ls = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      let used = 0;
      for (const [mk, mv] of map) if (mk !== k) used += mk.length + mv.length;
      if (used + k.length + v.length > limit) {
        const e = new Error('exceeded the quota');
        e.name = 'QuotaExceededError';
        throw e;
      }
      map.set(k, v);
    },
    removeItem: (k: string) => void map.delete(k),
  };
  (globalThis as { localStorage?: unknown }).localStorage = ls;
  return map;
}

/** A backend that hands back whatever body you give it, however broken. */
function backendServing(body: string | null): SessionBackend {
  return {
    readIndex: async () => null,
    writeIndex: async () => {},
    readBody: async () => body,
    writeBody: async () => {},
    deleteBody: async () => {},
  };
}

afterEach(() => {
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

describe('storage failures speak to the driver', () => {
  it('a full device names the space, not the key', async () => {
    installFakeLocalStorage(2_000);
    const store = createSessionStore(webBackend);
    const err = await store.saveSession(fakeSession('big', 400)).catch((e: unknown) => e);
    const e = expectDriverProse(err);
    expect(e.code).toBe('quota');
    expect(e.message).toMatch(/out of space/);
    expect(e.message, 'a size the driver can act on').toMatch(/\d+ KB/);
    // and the engineer still gets the key
    expect(e.detail).toContain('setItem');
  });

  it('a refused write says so without naming the call', async () => {
    const map = installFakeLocalStorage(1_000_000);
    (globalThis as { localStorage: { setItem: unknown } }).localStorage.setItem = () => {
      throw new Error('access denied');
    };
    void map;
    const store = createSessionStore(webBackend);
    const err = await store.saveSession(fakeSession('x')).catch((e: unknown) => e);
    const e = expectDriverProse(err);
    expect(e.code).toBe('io');
    expect(e.detail).toContain('setItem');
  });

  it('a bad link, a damaged file and an old file each complete the sentence the screen writes', async () => {
    // The results screen renders: `That session could not be read: ${error}`
    const compose = (m: string) => `That session could not be read: ${m}`;

    const store = createSessionStore(backendServing(null));
    const bad = await store.loadSession('../etc/passwd').catch((e: unknown) => e);
    const e1 = expectDriverProse(bad);
    expect(e1.code).toBe('invalid-id');
    expect(compose(e1.message)).toBe('That session could not be read: that is not a valid run link.');

    const damaged = await createSessionStore(backendServing('{not json')).loadSession('a').catch((e: unknown) => e);
    const e2 = expectDriverProse(damaged);
    expect(e2.code).toBe('corrupt');
    expect(compose(e2.message)).toBe('That session could not be read: the file is damaged.');

    const old = await createSessionStore(backendServing('{"version":0,"id":"a"}')).loadSession('a').catch((e: unknown) => e);
    const e3 = expectDriverProse(old);
    expect(e3.code).toBe('corrupt');
    expect(compose(e3.message)).toBe('That session could not be read: it was saved by a different version of the app.');

    // every one of them still carries the technical string for a log
    for (const e of [e1, e2, e3]) expect(e.detail, `no detail on ${e.code}`).toBeTruthy();
  });
});
