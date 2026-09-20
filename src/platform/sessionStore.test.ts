import { afterEach, describe, expect, it } from 'vitest';

import type { Session } from '../engine/types';
import { StorageError } from './kvTypes';
import { backend as webBackend } from './sessionBackend.web';
import { createMemoryBackend, createSessionStore, isValidSessionId, newSessionId, summarizeSession } from './sessionStore';

function fakeSession(id: string, startedAt: number, total: number, grade: Session['score']['grade'], samples = 3): Session {
  return {
    version: 1,
    id,
    name: `Run ${id}`,
    startedAt,
    durationS: 120,
    motion: Array.from({ length: samples }, (_, i) => ({ t: i / 100, accel: { x: 0, y: 0, z: 0 }, gravity: { x: 0, y: 0, z: -9.81 }, rotationRate: { x: 0, y: 0, z: 0 } })),
    gps: [],
    states: [],
    drifts: [],
    score: { total, grade, angle: 50, consistency: 50, quality: 50, speed: 50, style: 50, bestDriftId: null, longestChainPoints: 0, perDrift: {}, trusted: true },
    track: null,
    calibration: { r: [1, 0, 0, 0, 1, 0, 0, 0, 1], quality: 0, forwardResolved: false, t: 0 },
    integrity: { mount: 'rigid', physics: 'ok', gps: 'good', implausibleDriftFraction: 0, suppressedS: 0, scoreTrusted: true, message: '' },
    meta: { track: 'Harbor' },
  };
}

describe('session store (memory backend)', () => {
  it('saves, lists newest-first, loads and deletes', async () => {
    const backend = createMemoryBackend();
    const store = createSessionStore(backend);
    expect(await store.listSessions()).toEqual([]);

    await store.saveSession(fakeSession('a', 1000, 100, 'C'));
    await store.saveSession(fakeSession('b', 3000, 300, 'S'));
    await store.saveSession(fakeSession('c', 2000, 200, 'A'));

    const list = await store.listSessions();
    expect(list.map((e) => e.id)).toEqual(['b', 'c', 'a']);
    expect(list[0]).toMatchObject({ name: 'Run b', total: 300, grade: 'S', durationS: 120, drifts: 0, track: 'Harbor' });
    // index does not contain bodies
    expect(backend.index).not.toContain('gravity');
    expect(backend.bodies.size).toBe(3);

    const b = await store.loadSession('b');
    expect(b?.motion.length).toBe(3);
    expect(await store.loadSession('missing')).toBeNull();

    // re-saving replaces the index entry instead of duplicating it
    await store.saveSession(fakeSession('b', 3000, 999, 'S'));
    expect((await store.listSessions()).filter((e) => e.id === 'b')).toHaveLength(1);
    expect((await store.listSessions())[0].total).toBe(999);

    await store.deleteSession('b');
    expect((await store.listSessions()).map((e) => e.id)).toEqual(['c', 'a']);
    expect(backend.bodies.has('b')).toBe(false);

    await store.clearSessions();
    expect(await store.listSessions()).toEqual([]);
    expect(backend.bodies.size).toBe(0);
  });

  it('rejects unsafe ids and reports corrupt bodies', async () => {
    const backend = createMemoryBackend();
    const store = createSessionStore(backend);
    await expect(store.loadSession('../etc/passwd')).rejects.toBeInstanceOf(StorageError);
    await expect(store.saveSession(fakeSession('bad id', 1, 1, 'D'))).rejects.toMatchObject({ code: 'invalid-id' });
    backend.bodies.set('x', '{not json');
    await expect(store.loadSession('x')).rejects.toMatchObject({ code: 'corrupt' });
    backend.bodies.set('y', JSON.stringify({ version: 2, id: 'y' }));
    await expect(store.loadSession('y')).rejects.toMatchObject({ code: 'corrupt' });
  });

  it('survives a garbage index', async () => {
    const backend = createMemoryBackend();
    backend.index = '{"version":1,"entries":[{"id":"ok","startedAt":5},{"id":"../x","startedAt":1},null]}';
    const store = createSessionStore(backend);
    expect((await store.listSessions()).map((e) => e.id)).toEqual(['ok']);
    backend.index = 'garbage';
    expect(await createSessionStore(backend).listSessions()).toEqual([]);
  });

  it('generates valid ids and summaries', () => {
    const id = newSessionId(Date.UTC(2026, 8, 20, 13, 42, 1));
    expect(isValidSessionId(id)).toBe(true);
    expect(id).toMatch(/^\d{8}-\d{6}-[a-z0-9]{4}$/);
    expect(isValidSessionId('a/b')).toBe(false);
    const s = summarizeSession(fakeSession('z', 7, 42, 'B'));
    expect(s).toEqual({ id: 'z', name: 'Run z', startedAt: 7, durationS: 120, total: 42, grade: 'B', drifts: 0, track: 'Harbor' });
  });
});

describe('web backend (localStorage)', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

  function installFakeLocalStorage(limitBytes: number) {
    const map = new Map<string, string>();
    const fake = {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => {
        let total = v.length;
        for (const [key, val] of map) if (key !== k) total += val.length;
        if (total > limitBytes) {
          const err = new Error('The quota has been exceeded.');
          err.name = 'QuotaExceededError';
          throw err;
        }
        map.set(k, v);
      },
      removeItem: (k: string) => {
        map.delete(k);
      },
      map,
    };
    Object.defineProperty(globalThis, 'localStorage', { value: fake, configurable: true, writable: true });
    return fake;
  }

  afterEach(() => {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  it('stores the index and bodies under separate keys', async () => {
    const ls = installFakeLocalStorage(1_000_000);
    const store = createSessionStore(webBackend);
    await store.saveSession(fakeSession('w1', 10, 5, 'D'));
    expect([...ls.map.keys()].sort()).toEqual(['dom.session.v1.w1', 'dom.sessions.index.v1']);
    expect((await store.loadSession('w1'))?.id).toBe('w1');
    await store.deleteSession('w1');
    expect([...ls.map.keys()]).toEqual(['dom.sessions.index.v1']);
  });

  it('surfaces quota errors with a useful message', async () => {
    installFakeLocalStorage(2_000);
    const store = createSessionStore(webBackend);
    await expect(store.saveSession(fakeSession('big', 1, 1, 'D', 200))).rejects.toMatchObject({ code: 'quota' });
  });
});
