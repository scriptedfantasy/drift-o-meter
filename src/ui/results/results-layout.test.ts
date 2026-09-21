/**
 * The run review's geometry and its refusal copy.
 *
 * Both are pure, and both are things a screenshot can only show one size of: these tests pin the
 * rules across the sizes a phone actually reports — portrait, landscape, a small landscape window
 * — and pin the promise the refusal copy makes, which is that the first thing a driver reads
 * after NOT SCORED is the remedy in the monitor's own words, never the statistic in front of it.
 */
import { describe, expect, it } from 'vitest';

import { gutter } from '../theme';
import { LANDSCAPE_MIN_WIDTH, RAIL_GAP, resultsLayout, WORDMARK_WIDTH } from './layout';
import { faultStat, refusalFrom } from './unscored';

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
    expect(L.summaryWidth).toBe(L.contentWidth);
  });

  it('splits landscape into a summary rail and a slide column that fill the frame', () => {
    const L = resultsLayout(LANDSCAPE.w, LANDSCAPE.h);
    expect(L.landscape).toBe(true);
    expect(L.summaryWidth).toBe(L.railWidth);
    // rail + gap + column + both gutters is the whole width: no black margin either side
    expect(gutter * 2 + L.railWidth + RAIL_GAP + L.contentWidth).toBe(LANDSCAPE.w);
    // and the slide column is the wider half — it carries the list
    expect(L.contentWidth).toBeGreaterThan(L.railWidth);
  });

  it('draws the wordmark at the same width the drive display does, and never clips it', () => {
    // The review and the drive display are meant to read as one board with the mark pinned in
    // the same place, so this is a CONSTANT, not a fraction of the viewport: a review that
    // scaled its mark would shift it a few dp against a drive screen that did not. The only
    // thing that may shrink it is a frame too narrow to hold it.
    for (const [w, h] of [
      [393, 852],
      [390, 844],
      [430, 932],
      [852, 393],
      [1366, 1024],
      [1024, 768],
    ]) {
      const L = resultsLayout(w, h);
      expect(L.wordmarkWidth, `${w}x${h}`).toBe(WORDMARK_WIDTH);
      expect(L.wordmarkWidth, `${w}x${h} vs its block`).toBeLessThanOrEqual(L.summaryWidth);
    }
    // a 320 dp phone cannot hold 313 plus two 20 dp gutters, and the mark gives way rather than
    // running under the edge of the screen
    const small = resultsLayout(320, 568);
    expect(small.wordmarkWidth).toBe(320 - gutter * 2);
    expect(small.wordmarkWidth).toBeLessThan(WORDMARK_WIDTH);
  });

  it('only keeps the stats in the rail when the rail can actually hold them', () => {
    // THE DEFECT, AS ARITHMETIC. The rail does not scroll, so everything docked in it has to fit
    // the frame's height. Measured on the shipped export at 852 x 393: back row 52 + wordmark 120
    // + stat grid 165 + actions 56 + four 16 dp gaps + 16 dp of bottom padding is 457 dp of
    // content in a 393 dp rail — and the first build laid it out anyway, drawing DRIVE AGAIN on
    // top of the best-drift card. A screenshot of one viewport cannot catch that; this can.
    const RAIL_CHROME = 52 + 16 + 120 + 16 + 16 + 56 + 16;
    const STAT_GRID_H = 77 * 2 + 10 + 16;
    expect(resultsLayout(852, 393).railHoldsStats, 'a landscape phone has no room').toBe(false);
    expect(resultsLayout(1024, 768).railHoldsStats, 'a tablet does').toBe(true);
    expect(resultsLayout(1366, 1024).railHoldsStats).toBe(true);
    // portrait scrolls as one page, so nothing there has to fit a frame
    expect(resultsLayout(393, 852).railHoldsStats).toBe(true);
    for (let h = 200; h <= 1400; h += 13) {
      const L = resultsLayout(Math.max(h + 1, 900), h);
      if (!L.landscape) continue;
      expect(L.railHoldsStats, `${h} tall`).toBe(h >= RAIL_CHROME + STAT_GRID_H);
    }
  });

  it('keeps the portrait column on a wide-but-small window', () => {
    const L = resultsLayout(LANDSCAPE_MIN_WIDTH - 40, LANDSCAPE_MIN_WIDTH - 200);
    expect(L.landscape).toBe(false);
  });

  it('never returns a width a child would have to clip', () => {
    // WHAT THIS MISSED BEFORE. It listed [600, 400] and then asserted only `contentWidth > 0`
    // and `sparkWidth <= contentWidth` — nothing that compared the column back to the frame it
    // came from. At 600 x 400 the split was drawn and the column overflowed: measured live,
    // `clientWidth` 255 against `scrollWidth` 283, with the section head cut to "SCORE BREAKD…".
    // The column has to fit the frame, at every width, and the sweep is fine enough to land in
    // the 44 dp window that used to be wrong.
    for (let w = 300; w <= 1700; w += 7) {
      for (const h of [360, 400, 852, 1024]) {
        const L = resultsLayout(w, h);
        expect(L.contentWidth, `${w}x${h}`).toBeGreaterThan(0);
        expect(L.sparkWidth).toBeGreaterThanOrEqual(56);
        // a slide row is an index, a sparkline, a peak, a duration and a speed: the trace may
        // never take a quarter of it, or the four numbers stop being the thing being compared
        expect(L.sparkWidth, `${w}x${h} spark vs row`).toBeLessThanOrEqual(L.contentWidth * 0.25);
        expect(L.wordmarkWidth).toBeGreaterThan(0);
        expect(L.wordmarkWidth).toBeLessThanOrEqual(L.summaryWidth);
        if (L.landscape) {
          expect(gutter * 2 + L.railWidth + RAIL_GAP + L.contentWidth, `${w}x${h} rail + gap + column vs frame`).toBeLessThanOrEqual(w);
          expect(L.railWidth, `${w}x${h} rail`).toBeGreaterThanOrEqual(WORDMARK_WIDTH);
          expect(L.contentWidth, `${w}x${h} column`).toBeGreaterThanOrEqual(300);
        } else {
          expect(L.columnWidth).toBeLessThanOrEqual(w);
        }
      }
    }
  });
});

describe('refusalFrom', () => {
  // exactly what the engine composes for the hand-held fixture
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
      'check the phone is rigidly mounted', // the engine's own fallback when the monitor left none
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

  it('falls back to the screen\'s own line when the engine left no message', () => {
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

describe('faultStat', () => {
  const J = (o: Partial<{ mount: 'rigid' | 'suspect' | 'loose'; physics: 'ok' | 'implausible'; gps: 'good' | 'poor' | 'none' }> = {}) => ({
    mount: 'rigid' as const,
    physics: 'ok' as const,
    gps: 'good' as const,
    ...o,
  });

  it('never says LOOSE about a mount the monitor called rigid', () => {
    // THE DEFECT, AS CODE. The strip drew `<Stat label="Mount" value="LOOSE" />` on every refused
    // run. The monitor refuses rigidly mounted phones too — it vetoes on the calibration bar
    // alone and says "Can't tell which way the car points", which ARCHITECTURE.md names as the
    // expected real-road failure. On those runs the cell stated a fact about the hardware that
    // nothing had measured. No simulator refusal reaches it (18 in a row came back loose), so
    // only a test can hold it.
    const unresolved = faultStat(J(), false);
    expect(unresolved.value).not.toBe('LOOSE');
    expect(unresolved.label).toBe('Car axis');
    expect(unresolved.value).toBe('UNKNOWN');
  });

  it('reports what the monitor found, in the monitor\'s order of severity', () => {
    expect(faultStat(J({ mount: 'loose' }), false)).toEqual({ label: 'Mount', value: 'LOOSE', tone: 'severe' });
    // a loose mount outranks everything else, including an unresolved axis it caused
    expect(faultStat(J({ mount: 'loose', physics: 'implausible', gps: 'none' }), false).value).toBe('LOOSE');
    expect(faultStat(J({ physics: 'implausible' }), true)).toEqual({ label: 'Motion', value: 'IMPOSSIBLE', tone: 'severe' });
    expect(faultStat(J({ mount: 'suspect' }), true)).toEqual({ label: 'Mount', value: 'SHAKING', tone: 'warn' });
    expect(faultStat(J({ gps: 'none' }), true)).toEqual({ label: 'GPS', value: 'NONE', tone: 'severe' });
    expect(faultStat(J({ gps: 'poor' }), true)).toEqual({ label: 'GPS', value: 'POOR', tone: 'warn' });
  });

  it('always has something to say, so the chip is never blank', () => {
    for (const mount of ['rigid', 'suspect', 'loose'] as const) {
      for (const physics of ['ok', 'implausible'] as const) {
        for (const gps of ['good', 'poor', 'none'] as const) {
          for (const fwd of [true, false]) {
            const f = faultStat({ mount, physics, gps }, fwd);
            expect(f.label.length, `${mount}/${physics}/${gps}/${fwd}`).toBeGreaterThan(0);
            expect(f.value).toMatch(/^[A-Z ]+$/);
          }
        }
      }
    }
  });
});
