/**
 * The garage's loudest honesty claim, checked against runs the real engine really scored.
 *
 * The board prints one number under the words "the biggest angle is one you HELD and drove out
 * of". There are two candidates in every session — the instantaneous peak on `DriftEvent` and
 * the held peak on `DriftStats` — and the garage printed the wrong one for the whole of its
 * life. Nothing here asserts a value the scorer produced: only that the number on screen is the
 * held one, that it is below the instantaneous one, and that a spin lends it nothing.
 *
 * TWO THINGS THIS SUITE ONCE MISSED, both of which were on screen while it was green.
 * It checked each slide mark with `expect(deg).toBeGreaterThan(0)` and nothing else, which 118°
 * satisfies — so the instantaneous peak lived in `SlideMark[2]` under a green suite (the drawn
 * consequence is in `trace.test.ts`). And it ran only the three cheap `sim` fixtures, none of
 * which is the pipeline run that holds the shipped board's 53° record, while its one no-spin
 * case exercised the spin branch zero times.
 */
import { describe, expect, it } from 'vitest';

import { radToDeg, type Session } from '../../engine/types';
// Straight from the module, not the platform barrel: the barrel pulls in expo-sensors.
import { summarizeSession } from '../../platform/sessionStore';
import { buildFixtureSession, FIXTURES } from '../results/fixture';
import { TRACE_CEILING_DEG } from './trace';

/**
 * The three cheap ground-truth fixtures (`sim`, ~200 ms each) and the two PIPELINE runs the
 * shipped screenshots are drawn from — `good` holds the board's 52.8° record and `hero` its
 * 50.8°, and neither had ever been summarised in a test.
 */
const CASES = ['spin', 'sloppy', 'touge', 'good', 'hero'] as const;

function statsOf(s: Session, id: number): { heldPeakDeg: number; spun: boolean } | null {
  const per = s.score.perDrift as unknown as Record<number, { stats?: { heldPeakDeg: number; spun: boolean } }>;
  return per[id]?.stats ?? null;
}

describe.each(CASES)('summarizing the %s fixture', (name) => {
  const session = buildFixtureSession({ ...FIXTURES[name] });
  const entry = summarizeSession(session);

  it('carries the engine itself’s held peak, over the drifts that did not spin', () => {
    const expected = session.drifts
      .filter((d) => !d.spin && statsOf(session, d.id)?.spun !== true)
      .reduce((m, d) => Math.max(m, statsOf(session, d.id)?.heldPeakDeg ?? 0), 0);
    expect(entry.heldPeakDeg).toBeCloseTo(Math.round(expected * 10) / 10, 5);
    expect(entry.heldPeakDeg).toBeGreaterThan(0);
  });

  it('is never the instantaneous peak', () => {
    const instantaneous = session.drifts.filter((d) => !d.spin).reduce((m, d) => Math.max(m, radToDeg(Math.abs(d.peakAngle))), 0);
    expect(entry.heldPeakDeg).toBeLessThan(instantaneous);
  });

  it('lets no spun drift reach the angle', () => {
    for (const d of session.drifts) {
      const stats = statsOf(session, d.id);
      if (d.spin || stats?.spun) expect(entry.heldPeakDeg).not.toBeCloseTo(stats?.heldPeakDeg ?? -1, 5);
    }
    expect(entry.spins).toBe(session.drifts.filter((d) => d.spin || statsOf(session, d.id)?.spun === true).length);
  });

  it('draws every slide the run had, in range and in order', () => {
    expect(entry.slides).toHaveLength(session.drifts.length);
    let previousStart = -1;
    for (const [a, b, deg, spun] of entry.slides) {
      expect(a).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThanOrEqual(1);
      expect(b).toBeGreaterThanOrEqual(a);
      expect(a).toBeGreaterThanOrEqual(previousStart);
      expect(deg).toBeGreaterThan(0);
      expect(spun === 0 || spun === 1).toBe(true);
      previousStart = a;
    }
    expect(entry.slides.filter((m) => m[3] === 1)).toHaveLength(entry.spins);
  });

  it('gives every mark the ENGINE’s held peak for that drift — spun ones included', () => {
    // `deg > 0` was the whole of the old check, and `DriftEvent.peakAngle` passes it. This is an
    // identity against the field `SessionIndexEntry.heldPeakDeg`'s contract names, plus the
    // maximum that says no mark is the instantaneous figure the contract forbids.
    for (const [i, mark] of entry.slides.entries()) {
      const drift = session.drifts[i];
      const stats = statsOf(session, drift.id);
      expect(mark[2]).toBeCloseTo(Math.round((stats?.heldPeakDeg ?? 0) * 10) / 10, 6);
      expect(mark[2]).toBeLessThanOrEqual(radToDeg(Math.abs(drift.peakAngle)));
    }
  });

  it('never stores a mark the plot would have to draw past its own ceiling', () => {
    // The card captions the axis "<ceiling>° top". A trusted run's held angles have to fit under
    // it for that caption to be a scale rather than a decoration.
    for (const mark of entry.slides) {
      if (mark[3] === 1) continue; // a spin is a footprint, not a height — see trace.test.ts
      expect(mark[2]).toBeLessThanOrEqual(TRACE_CEILING_DEG);
    }
  });
});

describe('the spin fixture specifically', () => {
  const session = buildFixtureSession({ ...FIXTURES.spin });
  const entry = summarizeSession(session);

  it('has a spin whose raw angle is the biggest in the run, and does not print it', () => {
    const spun = session.drifts.filter((d) => d.spin);
    expect(spun.length).toBeGreaterThan(0);
    const spunPeak = spun.reduce((m, d) => Math.max(m, radToDeg(Math.abs(d.peakAngle))), 0);
    expect(spunPeak).toBeGreaterThan(entry.heldPeakDeg);
    // …and does not store it in the trace either, which is where it went instead.
    expect(Math.max(...entry.slides.map((m) => m[2]))).toBeLessThan(spunPeak);
  });
});

describe('the cases that exercise the spin branch', () => {
  it('covers spins in more than one run, so the branch is not carried by one fixture', () => {
    const spinny = CASES.map((name) => summarizeSession(buildFixtureSession({ ...FIXTURES[name] }))).filter((e) => e.spins > 0);
    expect(spinny.length).toBeGreaterThanOrEqual(2);
  });
});
