/**
 * The drive display's pure logic, under test.
 *
 * There was not one test under `src/ui` before this file: `npx vitest run src/ui` answered
 * "No test files found, exiting with code 1". That absence is why two findings survived a
 * round — the odometer rendered 8 990 for a score of 7 990 in a captured frame, and
 * `readIntegrity` (the function that decides whether this screen says NOT SCORING, which a
 * previous critic had already failed the screen over) had nothing checking a single string.
 *
 * Everything here is deliberately reachable from node: the column arithmetic, the integrity
 * table, the trail store and the query parser are all pure modules, imported without React
 * Native. Anything that needs a renderer is verified in the capture harness instead.
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { colors } from '../theme';
import { DriftPipeline } from '../../engine/pipeline';
import { simulateRun } from '../../sim';
import { columnOffset, columnsUsed, columnVisible, movingReading, renderedDigits, CARRY_FRACTION } from './odometerColumns';
import { nextDisplayTotal, TAU_S } from './odometerValue';
import { readIntegrity, CALIBRATION_GRACE_S } from './integrityView';
import { createTrail, fitTrail, pushTrail, resetTrail } from './trail';
import { DEFAULT_HUD_PARAMS, parseHudParams } from './hudParams';
import { gToFace } from './gVector';
import type { HudSnapshot } from './useDriveRun';

// ── the odometer ───────────────────────────────────────────────────────────────────────────

describe('odometer columns', () => {
  it('renders exactly Math.round(score) at rest, for every value from 0 to 99 999', () => {
    // THE SWEEP. Re-measured against the old formula over this exact range: 9 720 of the
    // 100 000 values (9.7 %) put a column mid-turn while the score was not moving at all, and
    // 3 969 of them (4.0 %) sliced the LEADING digit — the one the driver reads. 7 990 put the
    // thousands drum at 7.750, so the glyph in the window was the 8 and the screen said 8 990
    // while the engine held 7 990; 8 980 put it at 8.500. (The round that found this reported
    // 10.4 % for the leading digit; that figure matches ANY sliced column, not the leading one.
    // Both are the same defect and two of the twelve frames it captured landed on it.)
    let sliced = 0;
    let firstBad = '';
    for (let v = 0; v <= 99_999; v++) {
      const shown = renderedDigits(v, 6);
      if (shown !== String(v)) {
        sliced++;
        if (!firstBad) firstBad = `${v} rendered as ${shown ?? 'a sliced column'}`;
      }
    }
    expect(sliced, `values that do not read as themselves at rest (first: ${firstBad})`).toBe(0);
  });

  it('only the units column spins continuously; a column above it waits for the one below', () => {
    // 7 990 is the measured failure: the last three digits are ≥ 961, which used to be enough
    // to start the thousands drum turning on its own decade fraction.
    expect(columnOffset(7990, 3)).toBe(7);
    expect(columnOffset(7990, 2)).toBe(9);
    expect(columnOffset(7990, 1)).toBe(9);
    expect(columnOffset(7990, 0)).toBe(0);

    // mid-roll between 7 990 and 7 991: the units column is halfway, nothing else has moved
    expect(columnOffset(7990.5, 0)).toBeCloseTo(0.5, 9);
    expect(columnOffset(7990.5, 1)).toBe(9);
    expect(columnOffset(7990.5, 3)).toBe(7);

    // the tens column turns over only in the last CARRY_FRACTION of the units' own turn
    expect(columnOffset(7999 + (1 - CARRY_FRACTION), 1)).toBe(9);
    expect(columnOffset(7999.95, 1)).toBeCloseTo(9.5, 9);
    // and the carry cascades: at that instant the hundreds have not started
    expect(columnOffset(7999.95, 2)).toBe(9);
  });

  it('a column is never left showing a fraction of a digit at a value the HUD can settle on', () => {
    // the HUD snaps `totalDisplay` to a whole number once it is within half a point of the
    // score (`useDriveRun`), and the results odometer tweens to an integer: both land here
    for (const v of [0, 1, 9, 10, 99, 100, 961, 999, 1000, 7990, 8980, 8999, 9999, 10_000, 22_675, 99_999]) {
      for (let place = 0; place < 6; place++) {
        const p = columnOffset(v, place);
        expect(p, `value ${v}, place ${place}`).toBe(Math.floor(p));
      }
      expect(renderedDigits(v, 6)).toBe(String(v));
    }
  });

  it('reads as the value it holds WHILE IT ROLLS, across every decade crossing', () => {
    // WHY THIS EXISTS, AND WHY THE SWEEP ABOVE COULD NOT CATCH IT. That sweep asks
    // `renderedDigits`, which recomputes the column count synchronously from the value and only
    // answers the AT REST case — and the results odometer is only ever read in motion. The
    // component did not recompute the count synchronously: it raised it through
    // `runOnJS(setUsed)`, so the new leading column arrived one React commit after the value
    // crossed the decade and the leading digit was not drawn for that commit. Captured off the
    // reveal's own frames: portrait 9,014 (t=1420 ms) → "0,924" (t=1444, true value 10,924) →
    // 14,330 (t=1491); landscape 7,400 → "3,067" → 17,492. The reading went BACKWARDS.
    //
    // `movingReading` is the moving-value counterpart: what the drums spell at a value that is
    // between integers, using the same per-column rule the component now evaluates inside each
    // column's animated style. It must equal `Math.floor(value)` everywhere, or a digit is
    // missing. The step is deliberately not a divisor of any power of ten, so the sweep lands
    // inside carries rather than only on them.
    let worst = '';
    let backwards = 0;
    let prev = -1;
    for (let v = 0; v <= 120_000; v += 0.37) {
      const read = movingReading(v, 6);
      if (read !== Math.floor(v) && !worst) worst = `at ${v.toFixed(2)} the drums spell ${read}`;
      if (read < prev) backwards++;
      prev = read;
    }
    expect(worst, 'a value the odometer does not spell while rolling').toBe('');
    expect(backwards, 'frames where the number a driver reads went down while the score went up').toBe(0);

    // the two captured crossings, exactly
    expect(movingReading(10_924, 6)).toBe(10_924);
    expect(movingReading(13_067, 6)).toBe(13_067);
    // and the column that carries the leading digit is in use the instant the value needs it
    expect(columnVisible(9_999.99, 4, 6)).toBe(false);
    expect(columnVisible(10_000, 4, 6)).toBe(true);
  });

  it('never derives the column count through a React commit', () => {
    // The moving-value test above pins the ARITHMETIC; this pins the WIRING, which is where the
    // defect actually lived — the arithmetic was right all along and the component asked for it
    // one commit too late. A count is a number of views, so any count kept in React state is a
    // frame behind the value by construction. `columnVisible` is asked per column, inside that
    // column's own animated style, and nothing about the field's width may be committed.
    const src = readFileSync(new URL('./Odometer.tsx', import.meta.url), 'utf8');
    // comments stripped: this file's own docstring names the defect, and a prose mention of it
    // is the opposite of a reintroduction
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code, 'the column count must not hop to the JS thread').not.toMatch(/runOnJS/);
    expect(code, 'the column count must not be React state').not.toMatch(/useState|useAnimatedReaction/);
    expect(code, 'each column decides for itself, from the value').toMatch(/columnVisible\(/);
  });

  it('uses only as many columns as the number needs, and never fewer than one', () => {
    expect(columnsUsed(0, 6)).toBe(1);
    expect(columnsUsed(9, 6)).toBe(1);
    expect(columnsUsed(10, 6)).toBe(2);
    expect(columnsUsed(999, 6)).toBe(3);
    expect(columnsUsed(1000, 6)).toBe(4);
    expect(columnsUsed(1_000_000, 6)).toBe(6);
    // a negative or NaN value must not produce a negative column count or a NaN offset
    expect(columnsUsed(-5, 6)).toBe(1);
    expect(columnOffset(-5, 0)).toBe(0);
    expect(columnOffset(-5, 3)).toBe(0);

    // and the per-column form the component asks says the same thing at every value, so the
    // count on screen cannot drift from the count the rest of this file reasons about
    for (const v of [0, 1, 9, 10, 99, 100, 999, 1000, 9999, 10_000, 99_999, 1_000_000, -5]) {
      const used = columnsUsed(Math.max(0, v), 6);
      for (let place = 0; place < 6; place++) {
        expect(columnVisible(v, place, 6), `value ${v}, place ${place}`).toBe(place < used);
      }
    }
    // a column beyond the field is never drawn, whatever the value
    expect(columnVisible(1e9, 6, 6)).toBe(false);
  });
});

// ── the odometer's VALUE: does the score roll, or does it step? ────────────────────────────

describe('odometer value', () => {
  it('parks on a whole digit the moment the engine stops paying, and only then', () => {
    // the two halves of the rule, as a unit statement: nothing moving → an exact integer;
    // anything paid → the fraction is kept, which is what puts the units drum mid-turn
    expect(nextDisplayTotal(1234.2, 1234.6, 0, 0.01)).toBe(1235);
    expect(nextDisplayTotal(1234.6, 1234.6, 0, 0.01)).toBe(1235);
    // still paying: no park, even when the display has caught up to within a point
    const chasing = nextDisplayTotal(1234.2, 1234.6, 0.4, 0.01);
    expect(Number.isInteger(chasing)).toBe(false);
    expect(chasing).toBeGreaterThan(1234.2);
    expect(chasing).toBeLessThan(1234.6);
    // a big gap is chased, not jumped: τ = 0.12 s, so one 10 ms sample closes ~8 % of it
    expect(nextDisplayTotal(0, 10000, 1500, 0.01)).toBeCloseTo(10000 * (1 - Math.exp(-0.01 / TAU_S)), 6);
    // a CHAIN LOST unwinds the same way rather than cutting
    expect(nextDisplayTotal(10000, 0, -9000, 0.01)).toBeLessThan(10000);
    expect(nextDisplayTotal(10000, 0, -9000, 0.01)).toBeGreaterThan(0);
  });

  it('rolls on every frame the engine pays on, over a real run', () => {
    // THE DESIGN ASKS FOR A ROLL — "odometer roll (digits slide), never a jump cut" — and the
    // old rule parked whenever the display was within `max(25, 0.2 %)` of the total, which on a
    // live run is almost always. Replayed over the real pipeline: 90.20 % of harbor frames and
    // 76.50 % of touge frames took that branch, so a drum was mid-turn on 9.47 % / 23.50 % of
    // frames and on only 14.62 % / 34.55 % of the frames the engine was actually paying on.
    // The score STEPPED for the whole of every slide.
    const OLD = (display: number, total: number, dt: number) => {
      const gap = total - display;
      return Math.abs(gap) < Math.max(25, total * 0.002) ? Math.round(total) : display + gap * (1 - Math.exp(-dt / TAU_S));
    };
    const midTurn = (v: number) => {
      for (let place = 0; place < 6; place++) {
        const o = columnOffset(v, place);
        if (Math.abs(o - Math.round(o)) > 1e-9) return true;
      }
      return false;
    };
    const rows: string[] = [];
    for (const track of ['harbor', 'touge'] as const) {
      const run = simulateRun(track, { seed: 1, laps: 2 });
      const p = new DriftPipeline({});
      const gps = run.gps.slice().sort((a, b) => a.t - b.t);
      let j = 0;
      let prevT = NaN;
      let now = 0;
      let old = 0;
      let paying = 0;
      let rollNow = 0;
      let rollOld = 0;
      let parked = 0;
      for (let i = 0; i < run.motion.length; i++) {
        while (j < gps.length && gps[j].t <= run.motion[i].t) p.pushGps(gps[j++]);
        const f = p.pushMotion(run.motion[i]);
        const dt = Number.isFinite(prevT) ? Math.min(0.1, Math.max(0, f.t - prevT)) : 0.01;
        prevT = f.t;
        now = nextDisplayTotal(now, f.score.total, f.score.delta, dt);
        old = OLD(old, f.score.total, dt);
        if (f.score.delta === 0) {
          parked++;
          continue;
        }
        paying++;
        if (midTurn(now)) rollNow++;
        if (midTurn(old)) rollOld++;
      }
      while (j < gps.length) p.pushGps(gps[j++]);
      const finished = p.finish();
      rows.push(
        `  ${track}: ${paying} paying frames, a drum mid-turn on ${((100 * rollNow) / paying).toFixed(2)} % of them ` +
          `(old rule ${((100 * rollOld) / paying).toFixed(2)} %); ${parked} idle frames; parked at ${now}, engine live total ${finished.score.total}`,
      );
      // EVERY frame the engine pays on has a drum in motion. That is the whole finding.
      expect(rollNow / paying, `${track} rolled on only ${((100 * rollNow) / paying).toFixed(1)} % of its paying frames`).toBeGreaterThan(0.95);
      // and the old rule, run over the same frames, does not — so this is not a vacuous test
      expect(rollOld / paying, `${track}: the old rule would also have passed this`).toBeLessThan(0.5);
      // whatever it did while moving, it lands on a whole digit when the run stops
      expect(Number.isInteger(now), `${track} did not park on a whole digit`).toBe(true);
    }
    process.stdout.write(`\nODOMETER ROLL (real pipeline)\n${rows.join('\n')}\n`);
  }, 120_000);
});

// ── readIntegrity: the words on the screen ─────────────────────────────────────────────────

const BASE: HudSnapshot = {
  phase: 'idle',
  integrity: { mount: 'rigid', physics: 'ok', gps: 'good', message: 'Tracking', believable: true },
  speedKmh: 60,
  totalPoints: 1000,
  multiplier: 1,
  chainPoints: 0,
  chainActive: false,
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
  const cases: Array<[string, HudSnapshot, { tier: string; heading: string; scoreNote: string | null; noteTone: string }]> = [
    ['clean and counting', snap({}), { tier: 'ok', heading: '', scoreNote: null, noteTone: colors.muted }],
    [
      'clean but not counting (parked, crawling, between slides) — not a fault, says nothing',
      snap({ counting: false }),
      { tier: 'ok', heading: '', scoreNote: null, noteTone: colors.muted },
    ],
    [
      'loose mount, scorer refusing: the reason AND that it has stopped',
      snap({ counting: false, integrity: { mount: 'loose', believable: false, message: 'Phone is moving in its mount — tighten it' } }),
      { tier: 'severe', heading: 'LOOSE MOUNT', scoreNote: 'MOUNT LOOSE — NOT SCORING', noteTone: colors.red },
    ],
    [
      'loose mount while the scorer somehow still pays: the points are the doubt, not the scoring',
      snap({ counting: true, integrity: { mount: 'loose', believable: false } }),
      { tier: 'severe', heading: 'LOOSE MOUNT', scoreNote: 'MOUNT LOOSE — THESE POINTS MAY NOT STAND', noteTone: colors.text },
    ],
    [
      'impossible physics, not counting',
      snap({ counting: false, integrity: { physics: 'implausible', believable: false } }),
      { tier: 'severe', heading: 'IMPLAUSIBLE READINGS', scoreNote: 'IMPLAUSIBLE READINGS — NOT SCORING', noteTone: colors.red },
    ],
    [
      'impossible physics while counting',
      snap({ counting: true, integrity: { physics: 'implausible', believable: false } }),
      { tier: 'severe', heading: 'IMPLAUSIBLE READINGS', scoreNote: 'READINGS ARE NOT PHYSICALLY POSSIBLE', noteTone: colors.text },
    ],
    [
      'a fix was held and is now gone, but the engine is still paying — the dropout line',
      snap({ counting: true, gpsEverGood: true, integrity: { gps: 'none' } }),
      { tier: 'severe', heading: 'GPS LOST', scoreNote: 'NO FIX — DEAD-RECKONED FROM THE GYRO', noteTone: colors.text },
    ],
    [
      'the course lock is gone too: now it really has stopped',
      snap({ counting: false, gpsEverGood: true, integrity: { gps: 'none' }, valid: false }),
      { tier: 'severe', heading: 'GPS LOST', scoreNote: 'NO FIX — NOT SCORING', noteTone: colors.red },
    ],
    [
      'the first seconds of every run: no fix yet, forward unknown — calm, not an alarm',
      snap({ counting: false, gpsEverGood: false, forwardResolved: false, elapsedS: 2.2, integrity: { gps: 'none' } }),
      { tier: 'calibrating', heading: 'FINDING FORWARD', scoreNote: 'WAITING FOR THE FIRST FIX', noteTone: colors.muted },
    ],
    [
      'still no first fix after the grace period',
      snap({ counting: false, gpsEverGood: false, forwardResolved: true, elapsedS: CALIBRATION_GRACE_S + 1, integrity: { gps: 'none' } }),
      { tier: 'warn', heading: 'WAITING FOR GPS', scoreNote: 'WAITING FOR THE FIRST FIX', noteTone: colors.muted },
    ],
    [
      'no first fix, but dead reckoning is already paying',
      snap({ counting: true, gpsEverGood: false, forwardResolved: true, elapsedS: 20, integrity: { gps: 'none' } }),
      { tier: 'warn', heading: 'WAITING FOR GPS', scoreNote: 'NO FIX YET — DEAD-RECKONED', noteTone: colors.muted },
    ],
    ['weak fix, still counting', snap({ integrity: { gps: 'poor' } }), { tier: 'warn', heading: 'WEAK GPS', scoreNote: null, noteTone: colors.muted }],
    [
      'weak fix and not counting',
      snap({ counting: false, integrity: { gps: 'poor' } }),
      { tier: 'warn', heading: 'WEAK GPS', scoreNote: 'WEAK GPS — NOT SCORING', noteTone: colors.muted },
    ],
    ['shaking mount, still counting', snap({ integrity: { mount: 'suspect' } }), { tier: 'warn', heading: 'MOUNT SHAKING', scoreNote: null, noteTone: colors.muted }],
    [
      'shaking mount, not counting',
      snap({ counting: false, integrity: { mount: 'suspect' } }),
      { tier: 'warn', heading: 'MOUNT SHAKING', scoreNote: 'MOUNT SHAKING — NOT SCORING', noteTone: colors.muted },
    ],
    [
      'forward axis unresolved past the grace period, everything else fine',
      snap({ forwardResolved: false, elapsedS: CALIBRATION_GRACE_S + 1 }),
      { tier: 'warn', heading: 'FINDING FORWARD', scoreNote: null, noteTone: colors.muted },
    ],
  ];

  for (const [name, snapshot, want] of cases) {
    it(name, () => {
      const got = readIntegrity(snapshot);
      expect(got.tier).toBe(want.tier);
      expect(got.heading).toBe(want.heading);
      expect(got.scoreNote).toBe(want.scoreNote);
      expect(got.noteTone).toBe(want.noteTone);
      expect(got.message).toBe(snapshot.integrity.message);
    });
  }

  it('marks the stop sentence, and only the stop sentence, as the one the odometer greys for', () => {
    // `scoreStopped` is what `ScorePanel` reads to decide whether the big number is still a
    // score. It has to mean exactly "this note says NOT SCORING" — the odometer used to lose its
    // ember only at `trust === 0`, which on a shaking mount or a weak fix is never, so a
    // full-ember five-digit total sat directly above the words NOT SCORING.
    for (const mount of ['rigid', 'suspect', 'loose'] as const) {
      for (const physics of ['ok', 'implausible'] as const) {
        for (const gps of ['good', 'poor', 'none'] as const) {
          for (const counting of [true, false]) {
            for (const forwardResolved of [true, false]) {
              for (const elapsedS of [2, 30]) {
                for (const gpsEverGood of [true, false]) {
                  const v = readIntegrity(snap({ counting, forwardResolved, elapsedS, gpsEverGood, integrity: { mount, physics, gps } }));
                  const where = `${mount}/${physics}/${gps}/counting=${counting}/fwd=${forwardResolved}/t=${elapsedS}/everGood=${gpsEverGood}`;
                  expect(v.scoreStopped, where).toBe(v.scoreNote !== null && v.scoreNote.includes('NOT SCORING'));
                  // and it can never be true while the scorer says it IS counting
                  if (v.scoreStopped) expect(counting, where).toBe(false);
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
                  if (v.scoreNote?.includes('NOT SCORING')) expect(counting, `claimed NOT SCORING while counting: ${where}`).toBe(false);
                  // gold is the multiplier and the extreme angle; it may never be a fault colour
                  expect(v.noteTone, where).not.toBe(colors.gold);
                  // a severe tier always explains itself in the score block
                  if (v.tier === 'severe') expect(v.scoreNote, where).not.toBeNull();
                }
              }
            }
          }
        }
      }
    }
  });
});

// ── the mini-map trail ─────────────────────────────────────────────────────────────────────

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
