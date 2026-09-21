/**
 * The verdict screen's arithmetic, tied back to the engine that produced it.
 *
 * `results-layout.test.ts` pins the geometry; this file pins the one thing a screenshot cannot
 * show, which is WHERE a number on the page came from. The screen has two scores in hand: the
 * run's own (`session.score`, computed by the pipeline WITH its per-sample plausibility mask)
 * and a re-score built here from the stored drifts and states, which has no mask and therefore
 * pays for samples the monitor refused. Every payment on screen has to come from the first one.
 *
 * It did not. "CALLOUTS EARNED · +11,717" was tallied from the re-score while the total beside
 * it came from the run, so the page credited a driver with 1,829 points of bonus the engine had
 * deliberately paid nothing for — 7.3 % of the 25,163 printed next to it on `fixture-rough`.
 *
 * AND IT WAS INVISIBLE TO EVERY FIXTURE BUT ONE. The `sim` fixtures write `session.score` from
 * exactly this re-score (`fixture.ts`), so on them the two sources agree by construction and
 * any test built on one would pass while the defect was on screen. So these tests run on the
 * PIPELINE fixtures, and the first of them asserts that the two sources genuinely disagree —
 * without that, the rest prove nothing.
 */
import { describe, expect, it } from 'vitest';

import { scoreSession } from '../../engine/score';
import type { Session, StyleCalloutKind } from '../../engine/types';
import { buildFixtureSession, FIXTURES } from './fixture';
import { buildResultsModel } from './model';

/** The fixtures whose `session.score` really is the pipeline's, mask and all. */
const PIPELINE = ['hero', 'good', 'rough'] as const;

const built = new Map<string, Session>();
function fixture(name: string): Session {
  const cached = built.get(name);
  if (cached) return cached;
  const s = buildFixtureSession(FIXTURES[name]);
  built.set(name, s);
  return s;
}

/** What the run PUBLISHED for a drift: the callouts it actually paid. */
function publishedCallouts(session: Session, id: number): Array<{ kind: StyleCalloutKind; points: number }> {
  return (session.score?.perDrift?.[id]?.callouts ?? []).map((c) => ({ kind: c.kind, points: c.points }));
}

/** The same drift re-scored here, without the mask — the wrong source, kept to compare against. */
function rescored(session: Session) {
  const i = session.integrity;
  return scoreSession(session.drifts, session.states, session.track, undefined, i ? { integrity: { mount: i.mount, physics: i.physics, gps: i.gps, message: i.message } } : undefined);
}

describe('callout points come from the run, not from the re-score', () => {
  it('has something to catch: the two sources disagree on a pipeline fixture', () => {
    // Rule 10, applied to a test rather than to a number. If this ever passes trivially — the
    // fixture stops going through the pipeline, or the mask stops mattering on it — the
    // assertions below stop being evidence and this one says so first.
    const session = fixture('rough');
    expect(session.meta?.engine, 'fixture-rough must come from the real pipeline').toBe('pipeline');
    const re = rescored(session);
    const disagreeing = session.drifts.filter((d) => {
      const pub = publishedCallouts(session, d.id).reduce((a, c) => a + c.points, 0);
      const alt = (re.perDrift[d.id]?.callouts ?? []).reduce((a, c) => a + c.points, 0);
      return Math.abs(pub - alt) > 0.5;
    });
    expect(disagreeing.length, 'drifts whose published callouts differ from a re-score of them').toBeGreaterThan(0);
    // and the specific one the finding was written from: every callout on a slide the monitor
    // did not believe paid zero, and the re-score pays all seven
    const six = publishedCallouts(session, 6);
    expect(six.filter((c) => c.points === 0).length, `drift #6 published ${JSON.stringify(six)}`).toBeGreaterThan(0);
  });

  for (const name of PIPELINE) {
    it(`${name}: calloutPoints is the sum of the published per-drift callouts`, () => {
      const session = fixture(name);
      const model = buildResultsModel(session);
      let expected = 0;
      for (const row of model.drifts) {
        if (row.lost) continue;
        for (const c of publishedCallouts(session, row.id)) expected += c.points;
      }
      expect(model.calloutPoints).toBeCloseTo(expected, 6);

      // The same figure a second way: `DriftScore.bonus` is the scorer's own sum of that
      // drift's callouts, so it must land on the same number without touching the list.
      let viaBonus = 0;
      for (const row of model.drifts) {
        if (row.lost) continue;
        viaBonus += session.score?.perDrift?.[row.id]?.bonus ?? 0;
      }
      expect(model.calloutPoints).toBeCloseTo(viaBonus, 6);
    });

    it(`${name}: every callout chip counts what fired and pays what banked`, () => {
      const session = fixture(name);
      const model = buildResultsModel(session);
      const byKind = new Map<StyleCalloutKind, { count: number; points: number }>();
      for (const row of model.drifts) {
        if (row.lost) continue;
        for (const c of publishedCallouts(session, row.id)) {
          const e = byKind.get(c.kind) ?? { count: 0, points: 0 };
          e.count++;
          e.points += c.points;
          byKind.set(c.kind, e);
        }
      }
      expect(model.callouts.length).toBe(byKind.size);
      for (const chip of model.callouts) {
        const e = byKind.get(chip.kind);
        expect(e, `${chip.kind} is on screen but the run never fired it`).toBeDefined();
        expect(chip.count, `${chip.kind} ×`).toBe(e!.count);
        expect(chip.points, `${chip.kind} points`).toBeCloseTo(e!.points, 6);
      }
    });
  }

  it('a refused run credits no callouts at all', () => {
    // every callout on `handheld` published zero, so the reel has nothing to show and the
    // STYLE bar has no bonus to quote
    const session = fixture('handheld');
    const model = buildResultsModel(session);
    expect(model.trusted).toBe(false);
    expect(model.calloutPoints).toBe(0);
    for (const row of model.drifts) {
      for (const c of row.callouts) expect(c.points, `${c.kind} on drift #${row.id}`).toBe(0);
    }
  });

  it('a spin verdict is the scorer\'s, not a stat re-derived beside it', () => {
    // `DriftScore.lost`/`spun` are published for the reason their docstring in `types.ts`
    // gives: the scorer's spin rule is broader than the detector's flag. The row must carry
    // the published answer wherever there is one.
    for (const name of [...PIPELINE, 'spin', 'sloppy']) {
      const session = fixture(name);
      const model = buildResultsModel(session);
      for (const row of model.drifts) {
        const pub = session.score?.perDrift?.[row.id];
        if (!pub) continue;
        expect(row.spun, `${name} #${row.id} spun`).toBe(pub.spun);
        expect(row.lost, `${name} #${row.id} lost`).toBe(pub.lost);
      }
    }
  });
});
