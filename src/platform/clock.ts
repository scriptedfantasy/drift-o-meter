/**
 * Monotonic clock in SECONDS, shared by every sensor stream (see `MotionSample.t`).
 *
 * `performance.now()` is monotonic on iOS (Hermes), on the web and in Node. If it is missing we
 * fall back to `Date.now()` re-based to module load, which is at least continuous.
 */
const perf = (globalThis as { performance?: { now?: () => number } }).performance;
const perfNow: (() => number) | null = perf && typeof perf.now === 'function' ? () => perf.now!() : null;
const dateOrigin = Date.now();

/** Monotonic seconds. Origin is arbitrary (process start); only differences matter. */
export function now(): number {
  return perfNow ? perfNow() / 1000 : (Date.now() - dateOrigin) / 1000;
}

/** Monotonic milliseconds. */
export function nowMs(): number {
  return now() * 1000;
}

export const clock = { now, nowMs };
