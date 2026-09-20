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

/**
 * Below this the two-column split has no room for either half, so a wide-but-small window (a
 * split-screen tablet, a phone with a floating window) keeps the portrait column.
 */
export const LANDSCAPE_MIN_WIDTH = 600;

export interface ResultsLayout {
  /** True when the screen should draw the rail + column layout. */
  landscape: boolean;
  /** Portrait: the centred column. Landscape: the whole frame. */
  columnWidth: number;
  /** Readable width inside the scrolling report column. */
  contentWidth: number;
  /** Landscape: the fixed verdict rail. 0 in portrait. */
  railWidth: number;
  /** The block the grade plate lives in: the rail in landscape, the column in portrait. */
  heroWidth: number;
  /** Grade letter size on the settled page. */
  letterSize: number;
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
      heroWidth: contentWidth,
      letterSize: Math.min(168, contentWidth * 0.44),
      // the page is a centred column; the wash still belongs to the whole screen, or its hard
      // edges read as a stray card
      washInset: gutter + Math.max(0, (width - columnWidth) / 2),
      washHeight: Math.min(440, height * 0.5),
      scoreSize: Math.min(untrusted ? 40 : 56, contentWidth * (untrusted ? 0.11 : 0.15)),
      sparkWidth: Math.max(80, contentWidth - 190),
    };
  }

  const railWidth = Math.round(clamp(width * 0.36, 280, 360));
  const contentWidth = Math.max(300, width - gutter * 2 - railWidth - RAIL_GAP);
  return {
    landscape,
    columnWidth: width,
    contentWidth,
    railWidth,
    heroWidth: railWidth,
    // shorter than portrait's: the letter shares the rail with the score, the scale and the
    // actions, and a 393 dp frame has no height to spare
    letterSize: Math.min(146, railWidth * 0.44, height * 0.38),
    washInset: gutter,
    washHeight: Math.min(320, height * 0.62),
    scoreSize: Math.min(untrusted ? 38 : 48, railWidth * (untrusted ? 0.12 : 0.16)),
    sparkWidth: Math.max(80, contentWidth - 190),
  };
}
