/**
 * The verdict screen's geometry and its refusal copy.
 *
 * Both are pure, and both are things a screenshot can only show one size of: these tests pin the
 * rules across the sizes a phone actually reports — portrait, landscape, a small landscape window
 * — and pin the promise the refusal copy makes, which is that the first thing a driver reads
 * after NOT SCORED is the remedy in the monitor's own words, never the statistic in front of it.
 */
import { describe, expect, it } from 'vitest';

import { gutter } from '../theme';
import { LANDSCAPE_MIN_WIDTH, RAIL_GAP, resultsLayout } from './layout';
import { refusalFrom } from './unscored';

/** iPhone 15 Pro, the harness's device profile. */
const PORTRAIT = { w: 393, h: 852 };
const LANDSCAPE = { w: 852, h: 393 };

describe('resultsLayout', () => {
  it('keeps one centred column in portrait', () => {
    const L = resultsLayout(PORTRAIT.w, PORTRAIT.h);
    expect(L.landscape).toBe(false);
    expect(L.railWidth).toBe(0);
    expect(L.columnWidth).toBe(393);
    expect(L.contentWidth).toBe(393 - gutter * 2);
    expect(L.heroWidth).toBe(L.contentWidth);
  });

  it('splits landscape into a verdict rail and a report column that fill the frame', () => {
    const L = resultsLayout(LANDSCAPE.w, LANDSCAPE.h);
    expect(L.landscape).toBe(true);
    expect(L.railWidth).toBeGreaterThan(280);
    expect(L.heroWidth).toBe(L.railWidth);
    // rail + gap + column + both gutters is the whole width: no black margin either side
    expect(gutter * 2 + L.railWidth + RAIL_GAP + L.contentWidth).toBe(LANDSCAPE.w);
    // and the report column is the wider half — it carries the lists
    expect(L.contentWidth).toBeGreaterThan(L.railWidth);
  });

  it('never lets the hero wash reach the bottom of a short viewport', () => {
    // the harness fails a route whose corner pixels are not bg0
    for (const [w, h] of [
      [852, 393],
      [740, 360],
      [1024, 768],
    ]) {
      expect(resultsLayout(w, h).washHeight).toBeLessThan(h * 0.75);
    }
  });

  it('sizes the grade letter to the block it lives in, at every size', () => {
    for (const [w, h] of [
      [393, 852],
      [852, 393],
      [740, 360],
      [1024, 768],
      [320, 568],
    ]) {
      const L = resultsLayout(w, h);
      expect(L.letterSize).toBeGreaterThan(40);
      expect(L.letterSize).toBeLessThanOrEqual(L.heroWidth);
      // a landscape letter also has to fit the height it shares with the score and the actions
      if (L.landscape) expect(L.letterSize).toBeLessThan(h * 0.5);
    }
  });

  it('keeps the portrait column on a wide-but-small window', () => {
    const L = resultsLayout(LANDSCAPE_MIN_WIDTH - 40, LANDSCAPE_MIN_WIDTH - 200);
    expect(L.landscape).toBe(false);
  });

  it('never returns a width a child would have to clip', () => {
    for (const [w, h] of [
      [393, 852],
      [852, 393],
      [600, 400],
      [1280, 800],
    ]) {
      const L = resultsLayout(w, h);
      expect(L.contentWidth).toBeGreaterThan(0);
      expect(L.sparkWidth).toBeGreaterThanOrEqual(80);
      expect(L.sparkWidth).toBeLessThanOrEqual(L.contentWidth);
      expect(L.scoreSize).toBeGreaterThan(20);
    }
  });
});

describe('refusalFrom', () => {
  // exactly what `scoreSession` composes for the hand-held fixture
  const HANDHELD = "100% of this run's sliding could not be trusted — Phone looks hand-held — clip it into a rigid mount to score drifts";

  it('leads with the monitor\'s own line, not the statistic', () => {
    const r = refusalFrom(HANDHELD);
    expect(r.remedy).toBe('Phone looks hand-held — clip it into a rigid mount to score drifts.');
    expect(r.reason).toBe("100% of this run's sliding could not be trusted.");
  });

  it('names something the driver can physically do', () => {
    // every message the integrity monitor can compose for a refused run, verbatim
    const MONITOR = [
      'Phone looks hand-held — clip it into a rigid mount to score drifts',
      'Phone is moving in its mount — tighten it',
      "Can't tell which way the car points — mount the phone firmly and drive straight for a few seconds",
      'Sensor readings are spinning faster than any car can turn — check the phone is fixed to the car',
      'check the phone is rigidly mounted', // the scorer's own fallback when the monitor left none
    ];
    for (const m of MONITOR) {
      const r = refusalFrom(`60% of this run's sliding could not be trusted — ${m}`);
      expect(r.remedy).toMatch(/\b(clip|tighten|mount|check)\b/i);
      expect(r.remedy).toMatch(/\.$/);
      expect(r.remedy[0]).toBe(r.remedy[0].toUpperCase());
      // the fraction never leads
      expect(r.remedy).not.toMatch(/could not be trusted/);
    }
  });

  it('keeps the monitor\'s own em dashes', () => {
    expect(refusalFrom(HANDHELD).remedy).toContain('hand-held — clip it');
  });

  it('falls back to the screen\'s verdict when the engine left no message', () => {
    const r = refusalFrom('', 'too much of this run could not be believed');
    expect(r.remedy).toBe('Too much of this run could not be believed.');
    expect(r.reason).toBeNull();
  });

  it('treats an unjoined message as all remedy', () => {
    const r = refusalFrom('Mount the phone firmly');
    expect(r.remedy).toBe('Mount the phone firmly.');
    expect(r.reason).toBeNull();
  });
});
