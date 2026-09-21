/**
 * The run review's arithmetic, tied back to the engine that produced it.
 *
 * `results-layout.test.ts` pins the geometry; this file pins the two things a screenshot cannot
 * show: WHERE a figure on the page came from, and which slide the page calls the best one.
 *
 * WHAT USED TO BE HERE, AND WHY IT IS NOT. Every test in this file was about callout points —
 * that the reel's "+11,717" was tallied from the run's own per-drift record and not from a
 * re-score without the pipeline's plausibility mask. The reel, the points and the re-score are
 * all gone with the scoring, and a test of an absent number proves nothing. What survives is the
 * rule underneath it, which was never about points: the run's own verdict about a slide is the
 * verdict, and nothing downstream re-derives one.
 */
import { describe, expect, it } from 'vitest';

import type { Session } from '../../engine/types';
import { buildFixtureSession, FIXTURES } from './fixture';
import { bestByAngle, buildResultsModel } from './model';

const built = new Map<string, Session>();
function fixture(name: string): Session {
  const cached = built.get(name);
  if (cached) return cached;
  const s = buildFixtureSession(FIXTURES[name]);
  built.set(name, s);
  return s;
}

const EVERY = Object.keys(FIXTURES);

describe('per-slide measurements come from the run, not from a re-derivation', () => {
  it('reads them from Session.driftStats, which is where the engine puts them', () => {
    // Rule 10 applied to a test: if the fixtures stop carrying the new home, everything below
    // would silently pass through the legacy fallback and prove nothing about the path the app
    // actually takes. This says so first.
    const session = fixture('hero');
    expect(session.driftStats, 'fixture-hero must carry per-slide measurements').toBeDefined();
    for (const d of session.drifts) expect(session.driftStats?.[d.id], `slide #${d.id}`).toBeDefined();
  });

  it('still answers from the old home for a run stored before driftStats existed', () => {
    // Every run already on somebody's phone is stored the old way, inside the scorer's per-drift
    // record. Dropping the fallback would empty their review of every held angle and entry speed
    // on a screen that could never notice.
    const session = fixture('good');
    const withStats = buildResultsModel(session);
    const legacy: Session = { ...session, driftStats: undefined };
    const withoutStats = buildResultsModel(legacy);
    expect(legacy.score.perDrift, 'the old home must still be populated, or this proves nothing').toBeTruthy();
    for (let i = 0; i < withStats.drifts.length; i++) {
      expect(withoutStats.drifts[i].heldPeakDeg, `slide ${i + 1} held peak`).toBeCloseTo(withStats.drifts[i].heldPeakDeg, 6);
      expect(withoutStats.drifts[i].entryKmh, `slide ${i + 1} entry`).toBeCloseTo(withStats.drifts[i].entryKmh, 6);
      expect(withoutStats.drifts[i].spun, `slide ${i + 1} spun`).toBe(withStats.drifts[i].spun);
    }
  });

  it('a spin verdict is the run\'s own, never one re-derived beside it', () => {
    // `DriftSummary.spun` is published for the reason its docstring in `types.ts` gives in
    // capitals: the broad spin rule is wider than the detector's `DriftEvent.spin`, and when the
    // two were derived separately the replay paid out for slides the review had taken away.
    for (const name of EVERY) {
      const session = fixture(name);
      const model = buildResultsModel(session);
      for (const row of model.drifts) {
        const published = session.driftStats?.[row.id];
        if (!published) continue;
        expect(row.spun, `${name} #${row.id} spun`).toBe(published.spun);
      }
    }
  });

  it('a slide\'s held figures are never the unqualified ones', () => {
    // The two run 9 to 16 degrees apart on the shipped fixtures. The review prints `peakDeg` as
    // PEAK and never captions it "held", and BEST DRIFT's HELD figure is the duration, not an
    // angle — so the one place the distinction could be lost is here.
    for (const name of EVERY) {
      const model = buildResultsModel(fixture(name));
      for (const row of model.drifts) {
        expect(row.heldPeakDeg, `${name} #${row.id} angle`).toBeLessThanOrEqual(row.peakDeg + 1e-6);
        expect(row.heldS, `${name} #${row.id} seconds`).toBeLessThanOrEqual(row.durationS + 1e-6);
      }
    }
  });
});

describe('best drift is the biggest angle, longest held', () => {
  it('names the slide with the biggest peak, on every fixture', () => {
    for (const name of EVERY) {
      const model = buildResultsModel(fixture(name));
      if (model.drifts.length === 0) {
        expect(model.best, `${name} has no slides`).toBeNull();
        continue;
      }
      const biggest = Math.max(...model.drifts.map((r) => r.peakDeg));
      expect(model.best?.peakDeg, `${name}: best is ${model.best?.peakDeg}, biggest is ${biggest}`).toBeCloseTo(biggest, 6);
    }
  });

  it('is not the scorer\'s pick, and the difference is real on a shipped fixture', () => {
    // THE RULE THAT CHANGED, AS CODE. `bestDriftId` ranked by points — angle x duration x speed
    // x the chain multiplier — so it could name a smaller slide taken faster inside a longer
    // chain. A driver who asks which their best drift was is asking about the angle. If no
    // fixture ever disagrees this test stops being evidence, so it says so rather than passing.
    const disagreements = EVERY.filter((name) => {
      const session = fixture(name);
      const model = buildResultsModel(session);
      const scorersPick = session.score.bestDriftId;
      return model.best !== null && scorersPick !== null && model.best.id !== scorersPick;
    });
    expect(disagreements.length, 'no fixture distinguishes the two rules any more').toBeGreaterThan(0);
  });

  it('breaks a tie on duration, and only on duration', () => {
    // The real reducer, not a restatement of it: a test that spells the rule out a second time
    // cannot catch the rule changing.
    const a = { peakDeg: 50, heldS: 4 };
    const b = { peakDeg: 50, heldS: 6 };
    const longerButSmaller = { peakDeg: 49.9, heldS: 12 };
    expect(bestByAngle([a, b, longerButSmaller]), 'the longer of two equal peaks wins').toBe(b);
    expect(bestByAngle([b, a, longerButSmaller]), 'and order does not decide it').toBe(b);
    expect(bestByAngle([longerButSmaller, a]), 'a longer slide at a smaller angle does not win').toBe(a);
    expect(bestByAngle([])).toBeNull();
  });
});

describe('a run the engine will not vouch for', () => {
  it('is refused, and still reports the sliding its recording contains', () => {
    // `scoreTrusted: false` withholds the JUDGEMENT, not the stopwatch. TIME SIDEWAYS used to
    // come from the scorer's own drifting seconds, which are zero on a refused run — so the page
    // said "5 slides, 0:00 sideways" and contradicted itself in one row.
    const model = buildResultsModel(fixture('handheld'));
    expect(model.trusted).toBe(false);
    expect(model.drifts.length).toBeGreaterThan(0);
    expect(model.stats.driftTimeS).toBeGreaterThan(0);
    expect(model.judged.message, 'a refusal must carry the monitor\'s own words').not.toBe('');
  });

  it('still has a best drift to show, as a recording rather than an achievement', () => {
    const model = buildResultsModel(fixture('handheld'));
    expect(model.best).not.toBeNull();
  });
});
