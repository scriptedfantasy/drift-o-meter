/**
 * The two facts about a run that the garage needs and the index does not store outright:
 * how long the car was sideways, and how long the biggest angle was held for.
 *
 * Both are read off `SessionIndexEntry.slides`, which already carries every slide as
 * `[startFrac, endFrac, heldDeg, spun]` on the run's own clock, so a driver's whole season
 * costs one pass over the index and NOT ONE SESSION BODY. That is the constraint the whole
 * screen is built to (`useGarage.ts`), and it is why these live here as arithmetic over the
 * trace rather than as two more fields somebody has to remember to write.
 *
 * `heldDeg` on a mark is the engine's own held peak for that slide — never
 * `DriftEvent.peakAngle` — so a figure derived here is the same quantity the card prints
 * (see the contract on `SessionIndexEntry.heldPeakDeg`).
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

export interface PeakHold {
  /** The biggest angle the driver held, in degrees. 0 when the run held none. */
  deg: number;
  /**
   * How long the SLIDE that reached it lasted, in seconds. 0 when there is no such slide.
   *
   * NOT the time spent at that angle, and nothing here may caption it as one. The engine
   * measures that separately (`DriftSummary.timeAtAngleS` and `plateauS`), and neither is in
   * the session index — so the honest thing the garage can say is how long the slide ran, and
   * the labels say "slide" rather than "held" because of it. `27s HELD` next to `53°` would
   * read as twenty-seven seconds at fifty-three degrees, which no number on this screen knows.
   */
  slideS: number;
}

/**
 * The run's biggest held angle and the length of the slide that reached it.
 *
 * A SPIN IS NOT A CANDIDATE. The raw peak of a slide that ended in a spin is the biggest
 * number in most runs — 118° on the shipped fixtures — and the whole board is built on the
 * difference between an angle held and an angle fallen into. Ties break on the longer slide,
 * which is the same rule the leaderboard ranks by, kept in one place so the number shown and
 * the order shown cannot disagree.
 */
export function peakHold(entry: RunFactsEntry): PeakHold {
  let best: PeakHold = { deg: 0, slideS: 0 };
  for (const mark of entry.slides) {
    if (mark[3] === 1) continue;
    const deg = Number.isFinite(mark[2]) ? mark[2] : 0;
    if (deg <= 0) continue;
    const slideS = spanS(mark, entry.durationS);
    if (deg > best.deg || (deg === best.deg && slideS > best.slideS)) best = { deg, slideS };
  }
  return best;
}
