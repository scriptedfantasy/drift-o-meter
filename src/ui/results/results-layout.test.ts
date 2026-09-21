/**
 * The verdict screen's geometry and its refusal copy.
 *
 * Both are pure, and both are things a screenshot can only show one size of: these tests pin the
 * rules across the sizes a phone actually reports — portrait, landscape, a small landscape window
 * — and pin the promise the refusal copy makes, which is that the first thing a driver reads
 * after NOT SCORED is the remedy in the monitor's own words, never the statistic in front of it.
 */
import { describe, expect, it } from 'vitest';

import { gutter, space } from '../theme';
import { LANDSCAPE_MIN_WIDTH, RAIL_GAP, resultsLayout, scoreFieldWidth, WASH_BOTTOM_CLEAR } from './layout';
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
    // WHAT THIS USED TO ASSERT, AND WHY IT COULD NOT FAIL: `washHeight < h * 0.75` against a
    // landscape `washHeight` that is literally `height * 0.72`. A fraction of the height cannot
    // be caught out by a looser fraction of the height — the assertion restated the formula. The
    // property is about DP OF CLEAR SPACE at the bottom of the frame: the harness fails a route
    // whose corner pixels are not bg0, and below that band the actions are docked. Stated in dp,
    // and swept over heights the formula was never tuned on, it has something to catch: a flat
    // 0.72 fails this at every height under 229.
    for (let h = 200; h <= 1400; h += 37) {
      for (const w of [Math.max(h + 1, 660), h < 900 ? 1366 : 1600, Math.round(h * 0.6)]) {
        const L = resultsLayout(w, h);
        expect(h - L.washHeight, `${w}x${h} leaves this much clear under the wash`).toBeGreaterThanOrEqual(WASH_BOTTOM_CLEAR);
      }
    }
  });

  it('sizes the grade letter to what it actually shares the rail with', () => {
    // ALSO A TAUTOLOGY BEFORE: `letterSize <= heroWidth` against `railWidth * 0.5`, and
    // `< h * 0.5` against a value already capped at `h * 0.34`. Neither could fail. The real
    // constraints are that the SCORE has to fit beside the letter on the same row, and that the
    // letter has to fit the rail's free height — and, on a tall frame, that it is not left tiny
    // in a rail that is mostly black (180 dp in a 1024 dp frame, with 62 % of the rail empty).
    for (const [w, h] of [
      [393, 852],
      [852, 393],
      [740, 360],
      [667, 375],
      [644, 400],
      [1024, 768],
      [1280, 720],
      [1366, 1024],
      [320, 568],
    ]) {
      const L = resultsLayout(w, h);
      expect(L.letterSize, `${w}x${h}`).toBeGreaterThan(40);
      if (!L.landscape) {
        expect(L.letterSize).toBeLessThanOrEqual(L.contentWidth);
        continue;
      }
      if (L.railStack) {
        // its own line: the width is the rail's, and the height is the rail's free height
        expect(L.letterSize, `${w}x${h} letter vs rail`).toBeLessThanOrEqual(L.railWidth);
        expect(L.letterSize * L.letterLineRatio, `${w}x${h} letter vs free height`).toBeLessThanOrEqual(L.railBlockHeight);
        // and it is a grade letter, not a caption, on a frame with room for one
        expect(L.letterSize, `${w}x${h} letter is too small for the frame it has`).toBeGreaterThan(h * 0.25);
      } else {
        // sharing the row: letter + gap + the score field must fit the rail
        expect(L.letterSize + space[3] + scoreFieldWidth(L.scoreSize), `${w}x${h} letter + score vs rail`).toBeLessThanOrEqual(L.railWidth);
      }
    }
  });

  it('keeps the portrait column on a wide-but-small window', () => {
    const L = resultsLayout(LANDSCAPE_MIN_WIDTH - 40, LANDSCAPE_MIN_WIDTH - 200);
    expect(L.landscape).toBe(false);
  });

  it('never returns a width a child would have to clip', () => {
    // WHAT THIS MISSED. It listed [600, 400] and then asserted only `contentWidth > 0` and
    // `sparkWidth <= contentWidth` — nothing that compared the column back to the frame it came
    // from. At 600 x 400 the split was drawn and the report column overflowed: measured live,
    // `clientWidth` 255 against `scrollWidth` 283, with the section head cut to "SCORE BREAKD…".
    // The column has to fit the frame, at every width, and the sweep is fine enough to land in
    // the 44 dp window that used to be wrong.
    for (let w = 300; w <= 1700; w += 7) {
      for (const h of [360, 400, 852, 1024]) {
        const L = resultsLayout(w, h);
        expect(L.contentWidth, `${w}x${h}`).toBeGreaterThan(0);
        expect(L.sparkWidth).toBeGreaterThanOrEqual(80);
        expect(L.sparkWidth).toBeLessThanOrEqual(L.contentWidth);
        expect(L.scoreSize).toBeGreaterThan(20);
        if (L.landscape) {
          expect(gutter * 2 + L.railWidth + RAIL_GAP + L.contentWidth, `${w}x${h} rail + gap + column vs frame`).toBeLessThanOrEqual(w);
          expect(L.railWidth, `${w}x${h} rail`).toBeGreaterThanOrEqual(280);
          expect(L.contentWidth, `${w}x${h} column`).toBeGreaterThanOrEqual(300);
        } else {
          expect(L.columnWidth).toBeLessThanOrEqual(w);
        }
      }
    }
  });

  it('puts the hero letter where both layouts actually draw it', () => {
    // The grade reveal flies its own letter onto this box, so a wrong number here is a letter
    // that dissolves next to the hero instead of landing on it. Measured on the shipped web
    // export: the letter's line box starts at (20, 40) at 393 x 852 AND at 852 x 393.
    for (const [w, h] of [
      [393, 852],
      [852, 393],
      [1366, 1024],
    ]) {
      const L = resultsLayout(w, h);
      expect(L.heroLetterLeft, `${w}x${h} left`).toBe(gutter);
      expect(L.heroLetterTop, `${w}x${h} top`).toBe(40);
    }
    // a portrait page wider than its column centres it, and the letter travels with it
    const wide = resultsLayout(900, 1400);
    expect(wide.landscape).toBe(false);
    expect(wide.heroLetterLeft).toBe((900 - wide.columnWidth) / 2 + gutter);
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
    // expected real-road failure and `results-layout.test.ts` already lists as reachable. On
    // those runs the cell stated a fact about the hardware that nothing had measured. No
    // simulator refusal reaches it (18 in a row came back loose), so only a test can hold it.
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

  it('always has something to say, so the cell is never blank', () => {
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
