/**
 * Where the run review puts things at a given viewport.
 *
 * Portrait is one centred column that SCROLLS: a review's length is however many slides the
 * driver did, so this is not a fixed-height screen and nothing in here tries to fit it to one.
 *
 * Landscape is not that column stretched across the width. The mark and the two actions dock in a
 * fixed rail down the left and everything else scrolls in the column beside it. That is the drive
 * display's own split, and it matters for the same reason: a phone in a car mount is very often
 * mounted landscape, so that is the shape a lot of drivers read their review in, and a docked
 * rail keeps DRIVE AGAIN on screen however many slides are in the list.
 *
 * THE RAIL DOES NOT SCROLL, so everything in it has to fit the frame's HEIGHT, and on a landscape
 * phone that is 393 dp. Measured on the shipped web export at 852 x 393: back row 52, wordmark
 * 120, stat grid 165, actions 56, plus four 16 dp gaps and the bottom padding — 457 dp of content
 * in a 393 dp rail. The first build of this laid all four out anyway and the actions drew ON TOP
 * of the best-drift card. So the stat grid moves into the scrolling column whenever the rail
 * cannot hold it, and `railHoldsStats` is that arithmetic rather than a breakpoint near it.
 *
 * WHAT THIS FILE NO LONGER SIZES. It used to carry `letterSize`, `scoreSize`, `railStack` and
 * `scoreFieldWidth()`, which between them solved one problem: fitting a grade letter beside a
 * five-digit odometer in a rail of a given width. There is no grade and no odometer, so the rail
 * is sized by what is actually in it — the wordmark's fixed width plus the two-column stat grid —
 * rather than by arithmetic about type that is gone.
 *
 * Pure arithmetic, no React, so the tests can sweep it across every viewport a phone reports.
 */
import { gutter, space } from '../theme';

/** Gap between the summary rail and the slide column. */
export const RAIL_GAP = space[6];

/**
 * The wordmark's drawn width, in dp.
 *
 * 313 in a 390 board, which is where the approved design puts it, and the SAME number the drive
 * display uses: the two screens are meant to read as one board with the mark pinned in the same
 * place, and a review that scales its wordmark to the viewport would shift it a few dp against a
 * drive screen that did not. It is capped at the content width so a 320 dp phone does not clip
 * it, and never grown past 313 on a wider one.
 */
export const WORDMARK_WIDTH = 313;

/** `assets/brand/wordmark.webp` is 2000 x 764, so the drawn height follows from the width. */
export const WORDMARK_ASPECT = 2000 / 764;

/** Narrowest summary rail that still fits the wordmark and a two-column stat grid. */
const MIN_RAIL = 313;
/** Narrowest slide column that still fits an index, a 56 dp sparkline and three figures. */
const MIN_CONTENT = 300;

/**
 * What the rail holds besides the stat grid, in dp, measured on the shipped export at 852 x 393.
 *
 * back row 52 (a 44 dp target plus its 8 dp of lead) + gap 16 + wordmark 120 + gap 16 +
 * spacer 16 + actions 56 (48 plus its 8 dp of lead) + bottom padding 16.
 */
const RAIL_CHROME = 52 + 16 + 120 + 16 + 16 + 56 + 16;
/** The stat grid: two rows of 77 dp cells with a 10 dp gap between, plus the gap above it. */
const STAT_GRID_H = 77 * 2 + 10 + 16;

/**
 * Below this the two-column split has no room for either half, so a wide-but-small window (a
 * split-screen tablet, a phone with a floating window) keeps the portrait column.
 *
 * IT IS THE ARITHMETIC, NOT A ROUND NUMBER NEAR IT. An earlier threshold was written down
 * separately from the sum it had to clear, drifted 44 dp below it, and in that window drew the
 * split anyway: measured live at 600 x 400, `clientWidth` 255 against `scrollWidth` 283, with
 * the section head truncated to "SCORE BREAKD…". A threshold stated apart from its sum is one
 * that will disagree with it the first time either side moves, so it is that sum.
 */
export const LANDSCAPE_MIN_WIDTH = gutter * 2 + MIN_RAIL + RAIL_GAP + MIN_CONTENT;

export interface ResultsLayout {
  /** True when the screen should draw the rail + column layout. */
  landscape: boolean;
  /** Portrait: the centred column. Landscape: the whole frame. */
  columnWidth: number;
  /** Readable width inside the scrolling slide column. */
  contentWidth: number;
  /** Landscape: the fixed summary rail. 0 in portrait. */
  railWidth: number;
  /** The block the wordmark and the stat grid live in: the rail in landscape, the column in portrait. */
  summaryWidth: number;
  /**
   * Landscape: whether the rail is tall enough to hold the four stats under the mark, or whether
   * they have to go at the top of the scrolling column instead. Always true in portrait, where
   * the whole page scrolls and nothing has to fit a frame.
   */
  railHoldsStats: boolean;
  /** The wordmark's drawn width here — `WORDMARK_WIDTH`, unless the frame is narrower. */
  wordmarkWidth: number;
  /** Sparkline width in the slide list. */
  sparkWidth: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Sparkline width in a slide row.
 *
 * The approved design draws it 56 dp wide, and that is what a row wants: the row's job is to
 * compare four numbers down a column, and a sparkline wide enough to compete with them turns the
 * list into twelve charts. It grows only on a column wide enough that 56 dp would look stranded,
 * and never past a quarter of the row.
 */
function sparkFor(contentWidth: number): number {
  return Math.round(clamp(contentWidth * 0.16, 56, 96));
}

export function resultsLayout(width: number, height: number): ResultsLayout {
  const landscape = width > height && width >= LANDSCAPE_MIN_WIDTH;

  if (!landscape) {
    const columnWidth = Math.min(width, 620);
    const contentWidth = columnWidth - gutter * 2;
    return {
      landscape,
      columnWidth,
      contentWidth,
      railWidth: 0,
      summaryWidth: contentWidth,
      railHoldsStats: true,
      wordmarkWidth: Math.min(WORDMARK_WIDTH, contentWidth),
      sparkWidth: sparkFor(contentWidth),
    };
  }

  // The rail holds the wordmark at its fixed width plus its own gutter, and it widens with the
  // frame only as far as leaves the slide column its minimum — the split's own arithmetic,
  // applied rather than assumed. `LANDSCAPE_MIN_WIDTH` guarantees this stays at or above
  // `MIN_RAIL`, which is the wordmark's width, so the mark is never the thing that gets scaled.
  const railWidth = Math.round(Math.min(clamp(width * 0.36, MIN_RAIL, 420), width - gutter * 2 - RAIL_GAP - MIN_CONTENT));
  const contentWidth = width - gutter * 2 - railWidth - RAIL_GAP;
  return {
    landscape,
    columnWidth: width,
    contentWidth,
    railWidth,
    summaryWidth: railWidth,
    railHoldsStats: height >= RAIL_CHROME + STAT_GRID_H,
    wordmarkWidth: Math.min(WORDMARK_WIDTH, railWidth),
    sparkWidth: sparkFor(contentWidth),
  };
}
