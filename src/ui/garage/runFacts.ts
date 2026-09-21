/**
 * How long the car was sideways over a run, read off the slide trace the index already carries.
 *
 * `SessionIndexEntry.slides` holds every slide as `[startFrac, endFrac, heldDeg, spun]` on the
 * run's own clock, so a driver's whole season costs one pass over the index and NOT ONE SESSION
 * BODY — the constraint the whole screen is built to (`useGarage.ts`).
 *
 * There used to be a `peakHold` here too, deriving the peak slide's length from the same marks.
 * It is gone: `SessionIndexEntry` now publishes `peakHeldS` and `peakEntryKmh` off the SAME
 * slide as `heldPeakDeg`, picked in one pass, and a second opinion computed here could pick a
 * different slide whenever two peaks tied — the angle from one corner and the hold from
 * another, printed side by side as one sentence.
 */
import type { SessionIndexEntry } from '../../platform';

type RunFactsEntry = Pick<SessionIndexEntry, 'durationS' | 'slides'>;

/** A slide's length in seconds, from its two fractions of the recording. */
function spanS(mark: readonly number[], durationS: number): number {
  const d = Number.isFinite(durationS) && durationS > 0 ? durationS : 0;
  const a = Math.min(1, Math.max(0, Number.isFinite(mark[0]) ? mark[0] : 0));
  const b = Math.min(1, Math.max(a, Number.isFinite(mark[1]) ? mark[1] : a));
  return (b - a) * d;
}

/**
 * Seconds the car was sideways over the whole run — every slide, spun ones included.
 *
 * Spins count here and are excluded from the angle everywhere else, and that is not an
 * inconsistency: this is a measurement of TIME, which happened, while the angle is a claim
 * about control, which a spin is the absence of.
 */
export function sidewaysSeconds(entry: RunFactsEntry): number {
  let total = 0;
  for (const mark of entry.slides) total += spanS(mark, entry.durationS);
  return total;
}
