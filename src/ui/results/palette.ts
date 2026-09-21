/**
 * Colour helpers the run review's parts share.
 *
 * Almost everything that used to live here was scoring vocabulary: the word for each letter
 * grade, the 0-100 thresholds behind the grade scale strip, a name per style callout, and a
 * `scoreColor()` that turned a 0-100 sub-score into praise or warning. None of those things
 * exist any more, and the colours a review needs now come from the theme directly — an angle is
 * `angleColor()` so the review and the dial agree, a speed is blue, a refusal is red.
 */

/** Blend two `#rrggbb` colours; `t` is how much of `b` to take. */
export function mixColor(a: string, b: string, t: number): string {
  const p = (h: string, i: number) => parseInt(h.slice(1 + i * 2, 3 + i * 2), 16);
  const f = Math.max(0, Math.min(1, t));
  const ch = (i: number) => Math.round(p(a, i) + (p(b, i) - p(a, i)) * f).toString(16).padStart(2, '0');
  return `#${ch(0)}${ch(1)}${ch(2)}`;
}
