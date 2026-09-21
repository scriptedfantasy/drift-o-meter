/**
 * The drive display's pure logic, under test.
 *
 * There was not one test under `src/ui` before this file: `npx vitest run src/ui` answered
 * "No test files found, exiting with code 1". That absence is why a finding survived a round —
 * `readIntegrity` (the function that decides whether this screen says NOT SCORING, which a
 * previous critic had already failed the screen over) had nothing checking a single string.
 *
 * Everything here is deliberately reachable from node: the integrity table, the trail store,
 * the query parser and the g-vector geometry are all pure modules, imported without React
 * Native. Anything that needs a renderer is verified in the capture harness instead.
 *
 * THE ODOMETER'S TESTS WENT WITH THE ODOMETER. Two suites here swept the digit columns and the
 * value filter of the score drum that used to sit under the gauge; the drive display shows no
 * score at all now, and `odometerColumns.ts` / `odometerValue.ts` are deleted. Nothing they
 * asserted moved somewhere else — the behaviour itself is gone.
 */
import { describe, expect, it } from 'vitest';

import { colors } from '../theme';
import { DriftPipeline } from '../../engine/pipeline';
import { simulateRun } from '../../sim';
import { readIntegrity, CALIBRATION_GRACE_S } from './integrityView';
import { createTrail, fitTrail, pushTrail, resetTrail } from './trail';
import { DEFAULT_HUD_PARAMS, parseHudParams } from './hudParams';
import { gToFace } from './gVector';
import type { HudSnapshot } from './useDriveRun';

// ── readIntegrity: the words on the screen ─────────────────────────────────────────────────

const BASE: HudSnapshot = {
  phase: 'idle',
  integrity: { mount: 'rigid', physics: 'ok', gps: 'good', message: 'Tracking', believable: true },
  speedKmh: 60,
  transitions: 0,
  peakDeg: 0,
  driftDurationS: 0,
  runPeakDeg: 42,
  elapsedS: 30,
  lapCount: 0,
  lapProgress: 0,
  driftCount: 0,
  valid: true,
  calibrationQuality: 0.8,
  forwardResolved: true,
  gpsEverGood: true,
  trust: 1,
  counting: true,
  trailCount: 0,
};

type SnapOverrides = Partial<Omit<HudSnapshot, 'integrity'>> & { integrity?: Partial<HudSnapshot['integrity']> };

const snap = (o: SnapOverrides): HudSnapshot => ({
  ...BASE,
  ...o,
  integrity: { ...BASE.integrity, ...(o.integrity ?? {}) },
});

describe('readIntegrity', () => {
  /**
   * Every combination that reaches a different line, with the EXACT string. A screen has been
   * failed twice over what this function says — once for saying NOT SCORING while the scorer
   * was paying through a GPS dropout, once for saying nothing while it was not — so the strings
   * are the assertion, not a shape.
   */
  const cases: [string, HudSnapshot, { tier: string; heading: string; countingNote: string | null; noteTone: string }][] = [
    ['clean and counting', snap({}), { tier: 'ok', heading: '', countingNote: null, noteTone: colors.muted }],
    [
      'clean but not counting (parked, crawling, between slides) — not a fault, says nothing',
      snap({ counting: false }),
      { tier: 'ok', heading: '', countingNote: null, noteTone: colors.muted },
    ],
    [
      'loose mount, scorer refusing: the reason AND that it has stopped',
      snap({ counting: false, integrity: { mount: 'loose', believable: false, message: 'Phone is moving in its mount — tighten it' } }),
      { tier: 'severe', heading: 'LOOSE MOUNT', countingNote: 'MOUNT LOOSE — NOT SCORING', noteTone: colors.red },
    ],
    [
      'loose mount while the scorer somehow still pays: the points are the doubt, not the scoring',
      snap({ counting: true, integrity: { mount: 'loose', believable: false } }),
      { tier: 'severe', heading: 'LOOSE MOUNT', countingNote: 'MOUNT LOOSE — THESE POINTS MAY NOT STAND', noteTone: colors.text },
    ],
    [
      'impossible physics, not counting',
      snap({ counting: false, integrity: { physics: 'implausible', believable: false } }),
      { tier: 'severe', heading: 'IMPLAUSIBLE READINGS', countingNote: 'IMPLAUSIBLE READINGS — NOT SCORING', noteTone: colors.red },
    ],
    [
      'impossible physics while counting',
      snap({ counting: true, integrity: { physics: 'implausible', believable: false } }),
      { tier: 'severe', heading: 'IMPLAUSIBLE READINGS', countingNote: 'READINGS ARE NOT PHYSICALLY POSSIBLE', noteTone: colors.text },
    ],
    [
      'a fix was held and is now gone, but the engine is still paying — the dropout line',
      snap({ counting: true, gpsEverGood: true, integrity: { gps: 'none' } }),
      { tier: 'severe', heading: 'GPS LOST', countingNote: 'NO FIX — DEAD-RECKONED FROM THE GYRO', noteTone: colors.text },
    ],
    [
      'the course lock is gone too: now it really has stopped',
      snap({ counting: false, gpsEverGood: true, integrity: { gps: 'none' }, valid: false }),
      { tier: 'severe', heading: 'GPS LOST', countingNote: 'NO FIX — NOT SCORING', noteTone: colors.red },
    ],
    [
      'the first seconds of every run: no fix yet, forward unknown — calm, not an alarm',
      snap({ counting: false, gpsEverGood: false, forwardResolved: false, elapsedS: 2.2, integrity: { gps: 'none' } }),
      { tier: 'calibrating', heading: 'FINDING FORWARD', countingNote: 'WAITING FOR THE FIRST FIX', noteTone: colors.muted },
    ],
    [
      'still no first fix after the grace period',
      snap({ counting: false, gpsEverGood: false, forwardResolved: true, elapsedS: CALIBRATION_GRACE_S + 1, integrity: { gps: 'none' } }),
      { tier: 'warn', heading: 'WAITING FOR GPS', countingNote: 'WAITING FOR THE FIRST FIX', noteTone: colors.muted },
    ],
    [
      'no first fix, but dead reckoning is already paying',
      snap({ counting: true, gpsEverGood: false, forwardResolved: true, elapsedS: 20, integrity: { gps: 'none' } }),
      { tier: 'warn', heading: 'WAITING FOR GPS', countingNote: 'NO FIX YET — DEAD-RECKONED', noteTone: colors.muted },
    ],
    ['weak fix, still counting', snap({ integrity: { gps: 'poor' } }), { tier: 'warn', heading: 'WEAK GPS', countingNote: null, noteTone: colors.muted }],
    [
      'weak fix and not counting',
      snap({ counting: false, integrity: { gps: 'poor' } }),
      { tier: 'warn', heading: 'WEAK GPS', countingNote: 'WEAK GPS — NOT SCORING', noteTone: colors.muted },
    ],
    ['shaking mount, still counting', snap({ integrity: { mount: 'suspect' } }), { tier: 'warn', heading: 'MOUNT SHAKING', countingNote: null, noteTone: colors.muted }],
    [
      'shaking mount, not counting',
      snap({ counting: false, integrity: { mount: 'suspect' } }),
      { tier: 'warn', heading: 'MOUNT SHAKING', countingNote: 'MOUNT SHAKING — NOT SCORING', noteTone: colors.muted },
    ],
    [
      'forward axis unresolved past the grace period, everything else fine',
      snap({ forwardResolved: false, elapsedS: CALIBRATION_GRACE_S + 1 }),
      { tier: 'warn', heading: 'FINDING FORWARD', countingNote: null, noteTone: colors.muted },
    ],
  ];

  for (const [name, snapshot, want] of cases) {
    it(name, () => {
      const got = readIntegrity(snapshot);
      expect(got.tier).toBe(want.tier);
      expect(got.heading).toBe(want.heading);
      expect(got.countingNote).toBe(want.countingNote);
      expect(got.noteTone).toBe(want.noteTone);
      expect(got.message).toBe(snapshot.integrity.message);
    });
  }

  it('marks the stop sentence, and only the stop sentence, as the one that means the engine has stopped', () => {
    // `countingStopped` has to mean exactly "this note says NOT SCORING", so that a reader never
    // has to match on the string and never reaches for `trust` instead. `trust` is a different
    // question: on a shaking mount or a weak fix it is 0.65 and the engine is still counting, so
    // a screen that greyed on `trust` alone printed a full-strength total directly above the
    // words NOT SCORING.
    for (const mount of ['rigid', 'suspect', 'loose'] as const) {
      for (const physics of ['ok', 'implausible'] as const) {
        for (const gps of ['good', 'poor', 'none'] as const) {
          for (const counting of [true, false]) {
            for (const forwardResolved of [true, false]) {
              for (const elapsedS of [2, 30]) {
                for (const gpsEverGood of [true, false]) {
                  const v = readIntegrity(snap({ counting, forwardResolved, elapsedS, gpsEverGood, integrity: { mount, physics, gps } }));
                  const where = `${mount}/${physics}/${gps}/counting=${counting}/fwd=${forwardResolved}/t=${elapsedS}/everGood=${gpsEverGood}`;
                  expect(v.countingStopped, where).toBe(v.countingNote !== null && v.countingNote.includes('NOT SCORING'));
                  // and it can never be true while the scorer says it IS counting
                  if (v.countingStopped) expect(counting, where).toBe(false);
                }
              }
            }
          }
        }
      }
    }
  });

  it('says NOT SCORING when, and only when, the SCORER says it is not counting', () => {
    // the finding this function exists for, as a property over every combination it can see
    for (const mount of ['rigid', 'suspect', 'loose'] as const) {
      for (const physics of ['ok', 'implausible'] as const) {
        for (const gps of ['good', 'poor', 'none'] as const) {
          for (const counting of [true, false]) {
            for (const forwardResolved of [true, false]) {
              for (const elapsedS of [2, 30]) {
                for (const gpsEverGood of [true, false]) {
                  const s = snap({ counting, forwardResolved, elapsedS, gpsEverGood, integrity: { mount, physics, gps } });
                  const v = readIntegrity(s);
                  const where = `${mount}/${physics}/${gps}/counting=${counting}/fwd=${forwardResolved}/t=${elapsedS}/everGood=${gpsEverGood}`;
                  if (v.countingNote?.includes('NOT SCORING')) expect(counting, `claimed NOT SCORING while counting: ${where}`).toBe(false);
                  // green means the car is being measured right now; it may never be a fault
                  // colour, nor may the highlight the ramp passes through on the way to red
                  expect(v.noteTone, where).not.toBe(colors.green);
                  expect(v.noteTone, where).not.toBe(colors.greenHot);
                  // a severe tier always explains itself
                  if (v.tier === 'severe') expect(v.countingNote, where).not.toBeNull();
                }
              }
            }
          }
        }
      }
    }
  });
});

// ── the trail ─────────────────────────────────────────────────────────────────────

describe('trail', () => {
  it('grows past its initial capacity, keeps bounds incrementally and marks drifting points', () => {
    const t = createTrail();
    for (let i = 0; i < 2500; i++) pushTrail(t, i, -i * 0.5, i % 2 === 0);
    expect(t.n).toBe(2500);
    expect(t.minX).toBe(0);
    expect(t.maxX).toBe(2499);
    expect(t.minY).toBe(-1249.5);
    expect(t.maxY).toBeCloseTo(0, 9); // the first point's −0: a bound, not a sign
    expect(t.drift[0]).toBe(1);
    expect(t.drift[1]).toBe(0);
    expect(t.x[2499]).toBeCloseTo(2499, 3);
  });

  it('drops non-finite points instead of poisoning the bounds', () => {
    const t = createTrail();
    pushTrail(t, 10, 20, false);
    pushTrail(t, NaN, 5, false);
    pushTrail(t, 5, Infinity, true);
    expect(t.n).toBe(1);
    expect(t.minX).toBe(10);
    expect(t.maxY).toBe(20);
  });

  it('fits an empty trail without dividing by zero, and a short one without zooming wildly', () => {
    const empty = createTrail();
    const fit = fitTrail(empty, 146, 150);
    expect(fit.empty).toBe(true);
    expect(Number.isFinite(fit.scale) && Number.isFinite(fit.ox) && Number.isFinite(fit.oy)).toBe(true);

    const t = createTrail();
    pushTrail(t, 0, 0, false);
    pushTrail(t, 2, 1, false); // a 2 m trail must be scaled as if it spanned minSpanM
    const short = fitTrail(t, 146, 150, 10, 60);
    expect(short.scale).toBeLessThanOrEqual((150 - 20) / 60 + 1e-9);
    // y is flipped: ENU north is up the screen
    expect(short.oy).toBeGreaterThan(0);
    resetTrail(t);
    expect(t.n).toBe(0);
    expect(fitTrail(t, 146, 150).empty).toBe(true);
  });
});

// ── the capture harness's own query string ─────────────────────────────────────────────────

describe('hud params', () => {
  it('parses the capture URLs the harness actually uses', () => {
    expect(parseHudParams('?at=100.85&hold=1')).toMatchObject({ at: 100.85, hold: true, autoRun: true });
    expect(parseHudParams('?sim=harbor&rate=1')).toMatchObject({ at: NaN, hold: false, integrity: null });
    expect(parseHudParams(null)).toEqual(DEFAULT_HUD_PARAMS);
    expect(parseHudParams('?at=notanumber').at).toBeNaN();
    expect(parseHudParams('?at=-4').at).toBeNaN();
  });

  it('every integrity preset is a complete frame block, and says whether it may be believed', () => {
    // the preset feeds `LiveFrame['integrity']` straight into the HUD, and the grey-out now
    // reads `believable` from it: a preset that forgot the field would silently un-grey the
    // loose-mount capture
    for (const key of ['loose', 'suspect', 'gps-poor', 'gps-none', 'physics', 'ok']) {
      const p = parseHudParams(`?integrity=${key}`).integrity;
      expect(p, key).not.toBeNull();
      expect(typeof p!.message, key).toBe('string');
      expect(p!.message.length, key).toBeGreaterThan(0);
      expect(p!.believable, key).toBe(p!.mount !== 'loose' && p!.physics === 'ok');
    }
    expect(parseHudParams('?integrity=nonsense').integrity).toBeNull();
  });
});

// ── the g-meter's face ─────────────────────────────────────────────────────────────────────

describe('g-meter geometry', () => {
  const FS = 1.0;
  it('puts a right-hand push right, throttle up and braking down', () => {
    // ay is + to the LEFT, so a RIGHT-hand acceleration is ay < 0. ax is + forward.
    const at = (ayG: number, axG: number) => {
      const f = gToFace(ayG, axG, FS);
      return { x: f.x + 0, y: f.y + 0 }; // + 0 folds \u2212 0 to 0, which toMatchObject distinguishes
    };
    expect(at(-0.5, 0)).toEqual({ x: 0.5, y: 0 });
    expect(at(0.5, 0)).toEqual({ x: -0.5, y: 0 });
    // screen y grows down, so throttle (ax > 0) is negative y
    expect(at(0, 0.5)).toEqual({ x: 0, y: -0.5 });
    expect(at(0, -0.5)).toEqual({ x: 0, y: 0.5 });
  });

  it('sweeps a circle, not a square: 0.6 g at every heading lands 0.6 of the way out', () => {
    // the property the face depends on and the one a per-axis bug breaks first — a reading of a
    // fixed magnitude must sit at a fixed radius whatever direction it points
    for (let deg = 0; deg < 360; deg += 5) {
      const a = (deg * Math.PI) / 180;
      const f = gToFace(0.6 * Math.cos(a), 0.6 * Math.sin(a), FS);
      expect(Math.hypot(f.x, f.y), `radius at ${deg}\u00b0`).toBeCloseTo(0.6, 12);
      expect(f.mag, `mag at ${deg}\u00b0`).toBeCloseTo(0.6, 12);
    }
  });

  it('scales to full scale, so the same g reads at the same radius on both instruments\u2019 sweeps', () => {
    expect(gToFace(-0.4, 0, 0.8).mag).toBeCloseTo(0.5, 12);
    expect(gToFace(-0.4, 0, 1.0).mag).toBeCloseTo(0.4, 12);
  });

  it('pins a reading past the rim ON the rim, keeping its heading rather than its axes', () => {
    // 1.5 g of pure braking: length clamps to 1, direction stays straight down
    const brake = gToFace(0, -1.5, FS);
    expect(brake.mag).toBe(1);
    expect(brake.x).toBeCloseTo(0, 12);
    expect(brake.y).toBeCloseTo(1, 12);

    // 1.2 g braking + 0.9 g to the right (1.5 g total) must NOT come back as a 45\u00b0 diagonal,
    // which is what clamping each axis to 1 would produce
    const both = gToFace(-0.9, -1.2, FS);
    expect(both.mag).toBe(1);
    expect(both.x).toBeCloseTo(0.6, 12);
    expect(both.y).toBeCloseTo(0.8, 12);
    expect(Math.atan2(both.y, both.x)).toBeCloseTo(Math.atan2(1.2, 0.9), 12);
  });

  it('parks at the centre on a non-finite sample instead of drawing somewhere undefined', () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      expect(gToFace(bad, 0.3, FS)).toEqual({ x: 0, y: 0, mag: 0 });
      expect(gToFace(0.3, bad, FS)).toEqual({ x: 0, y: 0, mag: 0 });
    }
    expect(gToFace(0.3, 0.3, 0)).toEqual({ x: 0, y: 0, mag: 0 });
  });

  it('never leaves the face, over a real run', () => {
    // the property the renderer depends on: |(x, y)| \u2264 1 for every sample the pipeline emits,
    // so the dot can never be drawn outside the bezel
    const run = simulateRun('harbor', { seed: 1, laps: 2 });
    const p = new DriftPipeline();
    let gi = 0;
    let n = 0;
    let maxMag = 0;
    for (const m of run.motion) {
      while (gi < run.gps.length && run.gps[gi].t <= m.t) p.pushGps(run.gps[gi++]);
      const f = p.pushMotion(m);
      const face = gToFace(f.state.ay / 9.80665, f.state.ax / 9.80665, FS);
      expect(Math.hypot(face.x, face.y)).toBeLessThanOrEqual(1 + 1e-12);
      maxMag = Math.max(maxMag, face.mag);
      n++;
    }
    expect(n).toBeGreaterThan(10000);
    // and the scale is not so generous that the vector never moves: this run really does reach
    // the rim, which is what FULL_SCALE_G = 1.0 was measured to do
    expect(maxMag).toBeGreaterThan(0.9);
  });
});
