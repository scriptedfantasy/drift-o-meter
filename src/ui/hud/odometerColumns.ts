/**
 * Where each odometer drum sits, for a given value. Pure arithmetic, no React, no Reanimated —
 * so the thing that decides what the driver reads can be swept over every score it will ever
 * show (`odometer.test.ts`), instead of being inspected in screenshots.
 *
 * THE RULE, and the one it replaces. A column above the units parks on its own digit and turns
 * over only while the column BELOW it is itself crossing 9 → 0, over the last `CARRY_FRACTION`
 * of that crossing. The carry therefore cascades: the tens move over the last tenth of the
 * units' turn, the hundreds over the last tenth of the tens' turn, and so on. That is what a
 * mechanical drum does, and it has the property this display needs — AT REST (an integer score)
 * every column sits exactly on a digit, so the figure on screen is exactly `Math.round(score)`.
 *
 * What was here before drove every column off ITS OWN decade fraction:
 *
 *     p = (Math.floor(q) % 10) + Math.max(0, (q % 1) - 0.96) / 0.04,  q = value / 10^place
 *
 * so the thousands drum was mid-turn for any score whose last three digits were ≥ 961 and the
 * hundreds drum for any ending ≥ 97 — at rest, with nothing moving. A measured 10.4 % of the
 * integers from 1 to 99 999 rendered with a leading digit sliced in half: the engine held 7 990
 * and the screen read 8 990, because the thousands drum sat 75 % of the way from 7 to 8 and the
 * glyph in the window was the 8. Snapping the value to an integer could not park them, because
 * the fraction they read was never the value's fraction.
 */

/**
 * How much of a column's turn its neighbour above waits for before starting to move: the last
 * tenth. Bigger would put two columns in motion at once, which is what makes a rolling number
 * unreadable; smaller makes the carry a jump cut at the moment it matters least.
 */
export const CARRY_FRACTION = 0.1;

/**
 * The strip offset for `place` (0 = units, 1 = tens, …), in DIGIT HEIGHTS: 3.0 shows a centred
 * "3", 3.5 shows half of 3 above half of 4, and 9.5 shows half of 9 above half of the strip's
 * trailing 0. Always in [0, 10).
 */
export function columnOffset(value: number, place: number): number {
  'worklet';
  const v = value > 0 ? value : 0;
  // the units column is the only one that spins continuously — it IS the value
  let p = v % 10;
  const threshold = 10 - CARRY_FRACTION;
  for (let k = 1; k <= place; k++) {
    const digit = Math.floor(v / Math.pow(10, k)) % 10;
    p = digit + (p >= threshold ? (p - threshold) / CARRY_FRACTION : 0);
  }
  return p;
}

/** How many columns a value needs (1 for anything below 10), capped at `columns`. */
export function columnsUsed(value: number, columns: number): number {
  'worklet';
  const v = Math.max(1, Math.abs(value));
  return Math.max(1, Math.min(columns, Math.floor(Math.log10(v)) + 1));
}

/**
 * What the odometer actually READS at this value, or null when any column is mid-turn (a
 * fraction of a digit in the window). The sweep test asserts this equals `String(value)` for
 * every integer score the field can hold — it is the value-side statement of "the number on the
 * screen is the number in the engine".
 */
export function renderedDigits(value: number, columns = 6): string | null {
  const shown = columnsUsed(value, columns);
  let out = '';
  for (let place = shown - 1; place >= 0; place--) {
    const p = columnOffset(value, place);
    // a column is parked only when its offset is a whole digit height; 1e-9 absorbs the
    // division float error, nothing else (a 4 % overlap would be 0.04 here)
    const nearest = Math.round(p);
    if (Math.abs(p - nearest) > 1e-9) return null;
    out += String(nearest % 10);
  }
  return out;
}
