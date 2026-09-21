import { afterEach, describe, expect, it } from 'vitest';

import type { DriftEvent, Session } from '../engine/types';
import { StorageError } from './kvTypes';
import { backend as webBackend } from './sessionBackend.web';
import { createMemoryBackend, createSessionStore, isValidSessionId, newSessionId, summarizeSession } from './sessionStore';

function fakeDrift(id: number, startT: number, endT: number, peakDeg: number, spin = false): DriftEvent {
  return {
    id,
    startT,
    endT,
    durationS: endT - startT,
    peakAngle: (peakDeg * Math.PI) / 180,
    peakAngleT: (startT + endT) / 2,
    meanAngle: (peakDeg * 0.6 * Math.PI) / 180,
    angleStdDev: 0.05,
    transitions: 0,
    entrySpeed: 22,
    meanSpeed: 20,
    minSpeed: 16,
    distanceM: 60,
    peakYawRate: 0.9,
    peakLateralAccel: 8,
    initialDirection: 1,
    suppressedS: 0,
    spin,
    sampleStart: 0,
    sampleEnd: 0,
  };
}

/** A `ScoredDrift`-shaped entry, which is what the pipeline really writes into `perDrift`. */
function fakeScored(id: number, heldPeakDeg: number, spun: boolean) {
  return {
    base: 100,
    multiplier: 1,
    bonus: 0,
    total: 100,
    angle: 50,
    consistency: 50,
    speed: 50,
    style: 50,
    callouts: [],
    stats: { id, heldPeakDeg, spun },
  };
}

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

/** A run with one clean 48° hold and one spin whose instantaneous peak is much bigger. */
function sessionWithSpin(): Session {
  const s = fakeSession('mix', 1000, 5000, 'B');
  s.durationS = 100;
  s.drifts = [fakeDrift(1, 10, 22, 55, false), fakeDrift(2, 50, 58, 96, true)];
  s.score.perDrift = { 1: fakeScored(1, 48, false), 2: fakeScored(2, 91, true) } as unknown as Session['score']['perDrift'];
  return s;
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

  it('keeps the junk rows out of a well-formed index, and no index is an empty garage', async () => {
    const backend = createMemoryBackend();
    backend.index = '{"version":1,"entries":[{"id":"ok","startedAt":5},{"id":"../x","startedAt":1},null]}';
    expect((await createSessionStore(backend).listSessions()).map((e) => e.id)).toEqual(['ok']);
    backend.index = null;
    expect(await createSessionStore(backend).listSessions()).toEqual([]);
  });

  it('fills in the fields an entry written by an older build does not have', async () => {
    const backend = createMemoryBackend();
    backend.index = '{"version":1,"entries":[{"id":"old","startedAt":5,"peakAngleDeg":64}]}';
    const [e] = await createSessionStore(backend).listSessions();
    expect(e.heldPeakDeg).toBe(0);
    expect(e.spins).toBe(0);
    expect(e.slides).toEqual([]);
    expect(e.mount).toBe('rigid');
    // NOT 0: a legacy entry knows nothing about calibration, and 0 would read as "never
    // calibrated" and put a warning on the garage for every run stored before the field existed.
    expect(e.calibrationQuality).toBeLessThan(0);
  });

  it('an index that will not parse is a fault, not an empty garage', async () => {
    const backend = createMemoryBackend();
    backend.bodies.set('keep', JSON.stringify(fakeSession('keep', 7000, 4200, 'A')));
    backend.index = 'garbage';
    const store = createSessionStore(backend);

    // It used to return [] here, which drew "FIRST RUN · NOTHING TO BEAT YET" over a stored run.
    await expect(store.listSessions()).rejects.toMatchObject({ code: 'corrupt' });
    expect(await store.diagnose()).toMatchObject({ index: 'unreadable', recordings: 1 });

    // And the next save must NOT write a fresh one-entry index over the top of it.
    await expect(store.saveSession(fakeSession('new', 9000, 100, 'C'))).rejects.toMatchObject({ code: 'corrupt' });
    expect(backend.index).toBe('garbage');
    // The recording itself is kept, so a rebuild can still find it.
    expect(backend.bodies.has('new')).toBe(true);

    const rebuilt = await store.rebuildIndex();
    expect(rebuilt.map((e) => e.id)).toEqual(['new', 'keep']);
    expect((await store.listSessions()).map((e) => e.id)).toEqual(['new', 'keep']);
    expect(await store.diagnose()).toMatchObject({ index: 'ok', recordings: 2 });
  });

  it('a rebuild keeps the bodies it can read and drops the ones it cannot', async () => {
    const backend = createMemoryBackend();
    backend.bodies.set('good1', JSON.stringify(fakeSession('good1', 100, 10, 'D')));
    backend.bodies.set('torn', '{"version":1,"id":"torn"');
    backend.index = '{';
    const store = createSessionStore(backend);
    expect((await store.rebuildIndex()).map((e) => e.id)).toEqual(['good1']);
    expect(backend.bodies.has('torn')).toBe(true);
  });

  it('generates valid ids and summaries', () => {
    const id = newSessionId(Date.UTC(2026, 8, 20, 13, 42, 1));
    expect(isValidSessionId(id)).toBe(true);
    expect(id).toMatch(/^\d{8}-\d{6}-[a-z0-9]{4}$/);
    expect(isValidSessionId('a/b')).toBe(false);
    const s = summarizeSession(fakeSession('z', 7, 42, 'B'));
    expect(s).toEqual({
      id: 'z', name: 'Run z', startedAt: 7, durationS: 120, total: 42, grade: 'B', drifts: 0, track: 'Harbor',
      trusted: true, heldPeakDeg: 0, longestChainPoints: 0, spins: 0, slides: [], mount: 'rigid',
      calibrationQuality: 0, integrityMessage: '',
    });
  });

  it('a row can refuse a grade without loading the body', () => {
    // The index carries the trust verdict precisely so a list never prints a grade the
    // engine refused to publish. A session missing the flag counts as untrusted, because a
    // row that cannot tell must not award one.
    const trusted = summarizeSession(fakeSession('t', 1, 100, 'A'));
    expect(trusted.trusted).toBe(true);
    const refused = fakeSession('u', 1, 100, 'A');
    refused.score.trusted = false;
    expect(summarizeSession(refused).trusted).toBe(false);
    const withheld = fakeSession('v', 1, 100, 'A');
    withheld.integrity.scoreTrusted = false;
    expect(summarizeSession(withheld).trusted).toBe(false);
    const legacy = fakeSession('w', 1, 100, 'A');
    delete (legacy.score as { trusted?: boolean }).trusted;
    expect(summarizeSession(legacy).trusted).toBe(false);
  });

  describe('the angle a summary carries', () => {
    it('is the HELD peak of the drifts that did not spin, never the instantaneous one', () => {
      const s = sessionWithSpin();
      const e = summarizeSession(s);
      // The spun drift's instantaneous peak (96°) is the biggest number in the session and the
      // one the garage used to print under a caption that says "held".
      const biggestInstantaneous = Math.max(...s.drifts.map((d) => (Math.abs(d.peakAngle) * 180) / Math.PI));
      expect(biggestInstantaneous).toBeGreaterThan(e.heldPeakDeg);
      // It is also not the clean drift's instantaneous peak: the held figure is lower again.
      const cleanInstantaneous = (Math.abs(s.drifts[0].peakAngle) * 180) / Math.PI;
      expect(e.heldPeakDeg).toBeLessThan(cleanInstantaneous);
      expect(e.heldPeakDeg).toBe(48);
      expect(e.spins).toBe(1);
      expect(e.drifts).toBe(2);
    });

    it('claims nothing at all when the per-drift statistics were never stored', () => {
      const s = sessionWithSpin();
      s.score.perDrift = {};
      // The instantaneous peaks are still right there in `drifts`, and are still not an answer.
      expect(summarizeSession(s).heldPeakDeg).toBe(0);
    });

    it('counts a spin the scorer flagged even when the event does not say so', () => {
      const s = sessionWithSpin();
      s.drifts[1].spin = false;
      const e = summarizeSession(s);
      expect(e.spins).toBe(1);
      expect(e.heldPeakDeg).toBe(48);
    });
  });

  describe('the slide trace a summary carries', () => {
    it('places every slide on the run, in order, with the spins marked', () => {
      const e = summarizeSession(sessionWithSpin());
      expect(e.slides).toHaveLength(2);
      const [clean, spun] = e.slides;
      expect(spun[3]).toBe(1);
      expect(clean[3]).toBe(0);
      // fractions of the recording, in range and in order
      for (const [a, b] of e.slides) {
        expect(a).toBeGreaterThanOrEqual(0);
        expect(b).toBeLessThanOrEqual(1);
        expect(b).toBeGreaterThanOrEqual(a);
      }
      expect(clean[1]).toBeLessThan(spun[0]);
      // the clean slide is drawn at the angle it HELD; the spun one at the angle it reached
      expect(clean[2]).toBe(48);
      expect(spun[2]).toBeCloseTo(96, 0);
    });

    it('is normalised against the same origin whether or not the states survived trimming', () => {
      const full = sessionWithSpin();
      full.states = [{ t: 0, beta: 0, betaSigma: 0, heading: 0, course: 0, speed: 20, yawRate: 0, ay: 0, ax: 0, valid: true }] as unknown as Session['states'];
      const trimmed = { ...full, states: [full.states[0]], motion: [], gps: [] };
      expect(summarizeSession(trimmed).slides).toEqual(summarizeSession(full).slides);
    });
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
      get length() {
        return map.size;
      },
      key: (i: number) => [...map.keys()][i] ?? null,
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

  it('finds the stored recordings from the key names alone', async () => {
    const ls = installFakeLocalStorage(1_000_000);
    const store = createSessionStore(webBackend);
    await store.saveSession(fakeSession('w1', 10, 5, 'D'));
    await store.saveSession(fakeSession('w2', 20, 6, 'D'));
    ls.map.set('dom.sessions.index.v1', 'not json at all');
    const fresh = createSessionStore(webBackend);
    await expect(fresh.listSessions()).rejects.toMatchObject({ code: 'corrupt' });
    expect(await fresh.diagnose()).toMatchObject({ index: 'unreadable', recordings: 2, ephemeral: false });
    expect((await fresh.rebuildIndex()).map((e) => e.id)).toEqual(['w2', 'w1']);
  });

  it('surfaces quota errors with a useful message', async () => {
    installFakeLocalStorage(2_000);
    const store = createSessionStore(webBackend);
    await expect(store.saveSession(fakeSession('big', 1, 1, 'D', 200))).rejects.toMatchObject({ code: 'quota' });
  });
});
