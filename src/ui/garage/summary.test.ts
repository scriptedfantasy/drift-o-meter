/**
 * The garage's loudest honesty claim, checked against runs the real engine really scored.
 *
 * The board prints one number under the words "the biggest angle is one you HELD and drove out
 * of". There are two candidates in every session — the instantaneous peak on `DriftEvent` and
 * the held peak on `DriftStats` — and the garage printed the wrong one for the whole of its
 * life. Nothing here asserts a value the scorer produced: only that the number on screen is the
 * held one, that it is below the instantaneous one, and that a spin lends it nothing.
 */
import { describe, expect, it } from 'vitest';

import { radToDeg, type Session } from '../../engine/types';
// Straight from the module, not the platform barrel: the barrel pulls in expo-sensors.
import { summarizeSession } from '../../platform/sessionStore';
import { buildFixtureSession, FIXTURES } from '../results/fixture';

/** The fast, ground-truth fixtures: `sim` source, no pipeline, about 200 ms each. */
const CASES = ['spin', 'sloppy', 'touge'] as const;

function statsOf(s: Session, id: number): { heldPeakDeg: number; spun: boolean } | null {
  const per = s.score.perDrift as unknown as Record<number, { stats?: { heldPeakDeg: number; spun: boolean } }>;
  return per[id]?.stats ?? null;
}

describe.each(CASES)('summarizing the %s fixture', (name) => {
  const session = buildFixtureSession({ ...FIXTURES[name] });
  const entry = summarizeSession(session);

  it('carries the engineitself’s held peak, over the drifts that did not spin', () => {
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
});

describe('the spin fixture specifically', () => {
  const session = buildFixtureSession({ ...FIXTURES.spin });
  const entry = summarizeSession(session);

  it('has a spin whose raw angle is the biggest in the run, and does not print it', () => {
    const spun = session.drifts.filter((d) => d.spin);
    expect(spun.length).toBeGreaterThan(0);
    const spunPeak = spun.reduce((m, d) => Math.max(m, radToDeg(Math.abs(d.peakAngle))), 0);
    expect(spunPeak).toBeGreaterThan(entry.heldPeakDeg);
  });
});
