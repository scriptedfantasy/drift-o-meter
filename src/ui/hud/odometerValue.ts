/**
 * What value the odometer is shown, given what the engine holds — the filter between
 * `LiveFrame.score.total` and `HudSignals.totalDisplay`.
 *
 * It is its own module, with no React and no React Native in it, for the reason every other
 * decision on this screen is: `docs/DESIGN.md` asks the score to ROLL ("odometer roll — digits
 * slide — never a jump cut"), the previous rule quietly turned that roll into a step, and a
 * rule that lives inside a hook's sample callback is a rule no test can sweep. `hud.test.ts`
 * replays the real pipeline through this function and counts the frames that roll.
 *
 * ── THE RULE ──────────────────────────────────────────────────────────────────────────────
 * The display chases the engine's total with one exponential filter (τ = `TAU_S`), and it
 * PARKS — rounds onto a whole digit, so every drum sits exactly on a glyph — only once the
 * engine has stopped paying and the display has caught up to within `PARK_POINTS`.
 *
 * Both halves matter, and the old rule got the second one wrong. It parked whenever the display
 * was within `max(25, 0.2 %)` of the total, which on a live run is almost always: measured over
 * the real pipeline, 90.20 % of harbor frames and 76.50 % of touge frames took that branch, so a
 * drum was mid-turn on 9.80 % / 23.50 % of them and the number JUMPED between whole points for
 * the whole of every slide. The tell that it was the wrong question is that the gap is small
 * precisely BECAUSE the filter is working.
 *
 * `score.delta` is the engine's own per-frame change and is exactly 0 when nothing was paid, so
 * "has the score stopped" needs no threshold at all.
 */

/** Time constant of the chase, seconds. 0.12 tracks a 1 500 pts/s climb with ~0.12 s of lag. */
export const TAU_S = 0.12;

/**
 * How close the display has to be to the engine's total before it parks on a whole digit. One
 * point: the engine's total is fractional (callout bonuses carry the multiplier), and a settled
 * odometer must sit on a whole digit, not 0.3 of the way past it.
 */
export const PARK_POINTS = 1;

/**
 * The next value for the odometer.
 *
 * @param display where the odometer is now
 * @param total   what the engine holds (`LiveFrame.score.total`)
 * @param delta   what the engine paid on this frame (`LiveFrame.score.delta`), 0 when nothing
 * @param dt      seconds since the previous frame
 */
export function nextDisplayTotal(display: number, total: number, delta: number, dt: number): number {
  'worklet';
  const gap = total - display;
  if (delta === 0 && Math.abs(gap) < PARK_POINTS) return Math.round(total);
  return display + gap * (1 - Math.exp(-dt / TAU_S));
}
