/**
 * Where the verdict screen puts things at a given viewport.
 *
 * Portrait is one centred column. Landscape is NOT that column stretched across the width: the
 * verdict itself — the grade letter, the total, the scale and the three actions — holds a fixed
 * rail down the left, and the report (the sentence, the stats, the breakdown, the best drift,
 * the lists) scrolls in the column beside it. That is the drive display's own split (gauge and
 * numeral left, telemetry and score right), and it matters for the same reason: a phone in a car
 * mount is very often mounted landscape, so that is the shape a lot of drivers read their verdict
 * in, and a docked rail keeps WATCH REPLAY on screen the whole way down the page.
 *
 * Pure arithmetic, no React: the grade reveal reads the same numbers so the letter it slams in
 * can be handed over to the hero letter at exactly the right size and place.
 */
import { gutter, space } from '../theme';

/** Gap between the verdict rail and the report column. */
export const RAIL_GAP = space[6];

/** Narrowest verdict rail that still fits a grade letter beside a five-digit score. */
const MIN_RAIL = 280;
/** Narrowest report column that still fits a section head and a sparkline without clipping. */
const MIN_CONTENT = 300;

/**
 * Below this the two-column split has no room for either half, so a wide-but-small window (a
 * split-screen tablet, a phone with a floating window) keeps the portrait column.
 *
 * IT IS THE ARITHMETIC, NOT A ROUND NUMBER NEAR IT. This was 600 while the split needed 644,
 * and the 44 dp in between did not fall back — it drew the split and let the report column
 * overflow: measured live at 600 × 400, `clientWidth` 255 against `scrollWidth` 283, the widest
 * child an `svg` at 266 px, and the section head truncated to "SCORE BREAKD…". A threshold that
 * is written down separately from the sum it has to clear is a threshold that will disagree with
 * it the first time either side moves, so it is now that sum.
 */
export const LANDSCAPE_MIN_WIDTH = gutter * 2 + MIN_RAIL + RAIL_GAP + MIN_CONTENT;

/**
 * Where the rail stops being a phone's rail and becomes a tablet's.
 *
 * Under it the verdict shares a row with the score, which is what a 393 dp landscape phone wants.
 * Over it that row caps the letter at half the rail whatever the frame does, and the rest of the
 * rail is black: measured at 1366 × 1024, ≈340 px above "GRADE" and ≈590 px more between the
 * grade scale and the docked actions — 45 % of the rail, holding a 180 dp letter.
 * `supportsTablet: false` limits iOS to phone sizes; Android is a declared target with no such
 * limit, so this is reachable today.
 */
const RAIL_STACK_H = 720;
/** Reference height for widening the rail: a landscape phone gets the narrow rail it was tuned for. */
const RAIL_PHONE_H = 440;

/**
 * The top of the hero letter's line box, inside the safe area — identical in both layouts,
 * because both put the same two things above it:
 *
 *   the date row   paddingTop 8 + one micro line 14 + paddingBottom 12 = 34
 *   "GRADE"        one micro line 14, then a −8 overlap onto the letter's own leading
 *
 * Measured on the shipped web export at 393 × 852 and 852 × 393: the letter's box lands at
 * y = 40.0 in both. The grade reveal reads this, so the letter it hands over has somewhere real
 * to land — it used to aim at `height * 0.19` (110 dp in portrait against a letter at 40) and at
 * `space[12] + letterSize * 0.5`, and dissolved beside the hero letter rather than onto it.
 */
const HERO_LETTER_TOP = space[2] + 14 + space[3] + 14 - space[2];

/** The hero letter's line height, as a multiple of its font size. See `styles.grade`. */
const HERO_LINE_RATIO = 0.98;

/**
 * Clear space the hero wash must leave below itself, in dp.
 *
 * The harness fails a route whose corner pixels are not `bg0`, and past that a wash that reaches
 * the docked actions puts a tint behind SHARE / DRIVE AGAIN. Stated in dp on purpose: a FRACTION
 * of the height cannot be violated by any other fraction of the height, which is how the test
 * that was supposed to guard this ended up asserting `height * 0.72 < height * 0.75`.
 */
export const WASH_BOTTOM_CLEAR = 64;

/**
 * How wide the score reading is, per dp of its own type size.
 *
 * The odometer's own arithmetic (`src/ui/hud/Odometer.tsx`): a digit column is 0.56 x the size
 * and the thousands comma is 0.24, so a five-figure total is 5 x 0.56 + 0.24 = 3.04. In the rail
 * the grade letter and this block share one row, so the letter is bounded by what is left of the
 * rail after it — not by a flat half, which is what it used to take.
 */
export const SCORE_WIDTH_PER_DP = 3.04;

/** The widest score field the rail has to hold beside the letter, at a given score size. */
export function scoreFieldWidth(scoreSize: number): number {
  return Math.ceil(SCORE_WIDTH_PER_DP * scoreSize);
}

export interface ResultsLayout {
  /** True when the screen should draw the rail + column layout. */
  landscape: boolean;
  /** Portrait: the centred column. Landscape: the whole frame. */
  columnWidth: number;
  /** Readable width inside the scrolling report column. */
  contentWidth: number;
  /** Landscape: the fixed verdict rail. 0 in portrait. */
  railWidth: number;
  /**
   * Where the settled hero letter's line box starts, inside the safe area. Both layouts put it
   * in the same place — under the date row, under the "GRADE" label — and the grade reveal flies
   * its own letter onto exactly this box instead of guessing at one.
   */
  heroLetterLeft: number;
  heroLetterTop: number;
  /**
   * Landscape: the grade goes on its own line with the score beneath it, instead of sharing a
   * row with it. True only on a rail tall enough that the row layout leaves the letter small
   * and the rail empty.
   */
  railStack: boolean;
  /**
   * Landscape: how tall the grade block may be before the rail starts padding around it — the
   * letter and the score grow into this instead of leaving the rail empty. 0 in portrait.
   */
  railBlockHeight: number;
  /** The block the grade plate lives in: the rail in landscape, the column in portrait. */
  heroWidth: number;
  /** Grade letter size on the settled page. */
  letterSize: number;
  /** The settled hero letter's line height, as a multiple of its font size. */
  letterLineRatio: number;
  /** How far the hero wash bleeds outside the content box, each side. */
  washInset: number;
  /** Hero wash height. It stops well short of the bottom of a short viewport, or it tints the
   *  corner pixels the harness checks — and, worse, washes the whole screen. */
  washHeight: number;
  /** Score odometer size in the hero, published and withheld. */
  scoreSize: number;
  /** Sparkline width in the drift list. */
  sparkWidth: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

export function resultsLayout(width: number, height: number, untrusted = false): ResultsLayout {
  const landscape = width > height && width >= LANDSCAPE_MIN_WIDTH;

  if (!landscape) {
    const columnWidth = Math.min(width, 620);
    const contentWidth = columnWidth - gutter * 2;
    return {
      landscape,
      columnWidth,
      contentWidth,
      railWidth: 0,
      railStack: false,
      railBlockHeight: 0,
      heroWidth: contentWidth,
      // the column is centred, so the letter starts a gutter in from its left edge
      heroLetterLeft: Math.max(0, (width - columnWidth) / 2) + gutter,
      heroLetterTop: HERO_LETTER_TOP,
      letterSize: Math.min(168, contentWidth * 0.44),
      letterLineRatio: HERO_LINE_RATIO,
      // the page is a centred column; the wash still belongs to the whole screen, or its hard
      // edges read as a stray card
      washInset: gutter + Math.max(0, (width - columnWidth) / 2),
      washHeight: Math.min(440, height * 0.5, Math.max(0, height - WASH_BOTTOM_CLEAR)),
      scoreSize: Math.min(untrusted ? 40 : 56, contentWidth * (untrusted ? 0.11 : 0.15)),
      sparkWidth: Math.max(80, contentWidth - 190),
    };
  }

  // A tall rail is a different object from a phone's. Past `RAIL_STACK_H` the grade goes on
  // its own line with the score beneath it, which is the only way the letter can grow: sharing
  // the row with a five-digit odometer caps it at half the rail whatever the frame does.
  const railStack = height >= RAIL_STACK_H;
  // …and the rail itself widens with the height it has, so the letter's width budget grows too.
  const railMax = clamp(360 + (height - RAIL_PHONE_H) * 0.5, 360, 520);
  // Never wider than leaves the report column its minimum: the split's own arithmetic, applied
  // rather than assumed. `LANDSCAPE_MIN_WIDTH` guarantees this stays at or above `MIN_RAIL`.
  const railWidth = Math.round(Math.min(clamp(width * 0.36, MIN_RAIL, railMax), width - gutter * 2 - RAIL_GAP - MIN_CONTENT));
  const contentWidth = width - gutter * 2 - railWidth - RAIL_GAP;
  // What the rail holds besides the grade block: the date row, the grade scale, the label over
  // the letter, the gaps, and the docked actions. Approximate on purpose — it bounds the letter,
  // it does not lay anything out — and deliberately generous, so the letter is never the thing
  // that pushes WATCH REPLAY off the bottom.
  const railChrome = 290;
  const railBlockHeight = Math.max(0, height - railChrome);
  const scoreSize = Math.min(untrusted ? (railStack ? 52 : 38) : railStack ? 72 : 48, railWidth * (untrusted ? 0.12 : 0.16));
  return {
    landscape,
    columnWidth: width,
    contentWidth,
    railWidth,
    railStack,
    railBlockHeight,
    heroWidth: railWidth,
    heroLetterLeft: gutter,
    heroLetterTop: HERO_LETTER_TOP,
    // The letter shares the rail with the score, the scale and the three actions, so it is
    // bounded by the rail's HEIGHT as much as its width: 134 dp on a landscape phone. On a
    // stacked rail it has the whole width and the free height to grow into — 180 dp at
    // 1366 × 1024 before this, in a rail that was 45 % black.
    letterSize: railStack
      ? Math.min(railWidth * 0.86, railBlockHeight * 0.52)
      : Math.min(railWidth - scoreFieldWidth(Math.min(48, railWidth * 0.16)) - space[3], height * 0.34),
    letterLineRatio: HERO_LINE_RATIO,
    washInset: gutter,
    // the rail IS the hero here, so the wash lights most of it — but never the last band, where
    // the corner pixels the harness checks live and where the actions are docked
    washHeight: Math.min(height * 0.72, Math.max(0, height - WASH_BOTTOM_CLEAR)),
    scoreSize,
    sparkWidth: Math.max(80, contentWidth - 190),
  };
}
