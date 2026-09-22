/**
 * The verdict, tested where it lives rather than through the scorer that used to own it.
 *
 * These are honesty rules, so none of them asserts a number the engine tuned. They assert
 * relationships: that doubt does not round away, that an empty recording is not accused of
 * anything, that the driver is told why.
 */
import { describe, expect, it } from 'vitest';

import { sessionIntegrity, type IntegrityInput } from './verdict';

const LOOSE = { mount: 'loose' as const, physics: 'ok' as const, gps: 'good' as const, message: 'Phone looks hand-held — clip it into a rigid mount' };

function verdict(over: Partial<IntegrityInput> = {}) {
  return sessionIntegrity({
    implausiblePerDrift: [0, 0, 0],
    believedDriftS: 30,
    monitor: null,
    maxImplausibleFraction: 0.25,
    ...over,
  });
}

describe('what the verdict reports', () => {
  it('trusts a clean run and says nothing', () => {
    const v = verdict();
    expect(v.scoreTrusted).toBe(true);
    expect(v.message).toBe('');
    expect(v.implausibleDriftFraction).toBe(0);
    expect(v.suppressedS).toBe(0);
  });

  it('measures the fraction against ALL the observed sliding, believed and not', () => {
    // 10 s doubted out of 40 observed is a quarter, not a third of the 30 believed.
    const v = verdict({ implausiblePerDrift: [10], believedDriftS: 30 });
    expect(v.implausibleDriftFraction).toBeCloseTo(0.25, 6);
    expect(v.suppressedS).toBe(10);
  });

  it('refuses the run once past the threshold, and tells the driver why', () => {
    const v = verdict({ implausiblePerDrift: [30], believedDriftS: 10, monitor: LOOSE });
    expect(v.scoreTrusted).toBe(false);
    expect(v.message).toContain('75%');
    expect(v.message).toContain(LOOSE.message);
  });

  it('is inclusive at the threshold: exactly the limit still publishes', () => {
    const at = verdict({ implausiblePerDrift: [10], believedDriftS: 30, maxImplausibleFraction: 0.25 });
    expect(at.scoreTrusted).toBe(true);
    const over = verdict({ implausiblePerDrift: [10.1], believedDriftS: 30, maxImplausibleFraction: 0.25 });
    expect(over.scoreTrusted).toBe(false);
  });

  it('names the mount when the monitor has nothing to say', () => {
    const v = verdict({ implausiblePerDrift: [30], believedDriftS: 10, monitor: null });
    expect(v.scoreTrusted).toBe(false);
    expect(v.message).toContain('check the phone is rigidly mounted');
  });
});

describe('an empty recording', () => {
  it('is trusted, because there is nothing to doubt', () => {
    // Otherwise every drive to the petrol station wears a warning.
    const v = verdict({ implausiblePerDrift: [], believedDriftS: 0 });
    expect(v.scoreTrusted).toBe(true);
    expect(v.message).toBe('');
  });

  it('is trusted even when the monitor disliked the mount', () => {
    const v = verdict({ implausiblePerDrift: [], believedDriftS: 0, monitor: LOOSE });
    expect(v.scoreTrusted).toBe(true);
    expect(v.mount).toBe('loose');
  });
});

describe('what it says when no monitor ran', () => {
  it('reports the optimistic defaults rather than inventing a warning', () => {
    // A session recorded before the monitor was wired in has no verdict to report, and
    // must not wear one it never earned.
    const v = verdict({ monitor: null });
    expect(v.mount).toBe('rigid');
    expect(v.physics).toBe('ok');
    expect(v.gps).toBe('good');
  });

  it('carries the monitor verdict through untouched when one did run', () => {
    const v = verdict({ monitor: { mount: 'suspect', physics: 'implausible', gps: 'none', message: 'x' } });
    expect(v.mount).toBe('suspect');
    expect(v.physics).toBe('implausible');
    expect(v.gps).toBe('none');
  });
});

describe('rounding', () => {
  it('keeps the fraction to three decimals, so the percentage keeps one', () => {
    const v = verdict({ implausiblePerDrift: [1], believedDriftS: 2.1234 });
    expect(v.implausibleDriftFraction).toBe(Math.round((1 / 3.1234) * 1000) / 1000);
  });

  it('keeps suppressed seconds to two, which is finer than anyone can act on', () => {
    const v = verdict({ implausiblePerDrift: [1.23456], believedDriftS: 30 });
    expect(v.suppressedS).toBe(1.23);
  });

  it('does not round doubt away to nothing', () => {
    // A run that was 0.1% doubted still reports a non-zero fraction rather than a clean 0.
    const v = verdict({ implausiblePerDrift: [0.03], believedDriftS: 29.97 });
    expect(v.implausibleDriftFraction).toBeGreaterThan(0);
  });
});

describe('junk in', () => {
  it('ignores non-finite per-drift figures rather than poisoning the total', () => {
    const v = verdict({ implausiblePerDrift: [NaN, 5, Infinity], believedDriftS: 15 });
    expect(v.suppressedS).toBe(5);
    expect(Number.isFinite(v.implausibleDriftFraction)).toBe(true);
  });

  it('treats a non-finite or negative believed time as zero', () => {
    for (const believedDriftS of [NaN, -10]) {
      const v = verdict({ implausiblePerDrift: [5], believedDriftS });
      expect(v.implausibleDriftFraction).toBe(1);
      expect(v.scoreTrusted).toBe(false);
    }
  });
});
