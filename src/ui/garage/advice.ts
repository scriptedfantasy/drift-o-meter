/**
 * Whether the garage has anything to say about the mount — and if so, exactly what.
 *
 * Calibration is not a step in this app (see "The whole app is four steps" in docs/DESIGN.md):
 * the engine finds the vertical from gravity and the forward axis from the first hard
 * acceleration, while driving. A driver who never opens the calibration screen must not be
 * worse off for it, so the garage never stands there inviting them to calibrate.
 *
 * It speaks only when the LAST RUN left real evidence that something was wrong, and then it says
 * what was wrong rather than offering a chore. Where the integrity monitor already has a
 * sentence for the condition, that sentence gets its own line rather than being glued into a
 * template: gluing produced "100% of this run's sliding could not be trusted — Phone looks
 * hand-held — clip it into a rigid mount to score drifts. Nothing from that drive was scored.",
 * two em-dash clauses and a capital P mid-sentence.
 *
 * Its own line was only half of it. The monitor writes for a HUD PILL — "reason — advice", no
 * full stop, capitals mid-line — so quoting it verbatim put that same two-dash run-on on the
 * garage, one screen over from the results page, which had already stopped printing it that way.
 * `monitorSentence` is the results screen's own `sentencesFromPill`, imported rather than
 * re-implemented, so the two screens cannot drift apart again.
 *
 * Everything here comes from the session INDEX. It used to need the newest run's body, which
 * cost 5.48 MB and 25.5 ms of `JSON.parse` on mount for 70 bytes of text
 * (`npx tsx tools/analysis/storage-census.ts`).
 */
import { bandIsScorable, calibrationBand } from '../../engine/integrity';
import type { SessionIndexEntry } from '../../platform';
import { sentencesFromPill } from '../results/verdict';

/**
 * The integrity monitor's own words, ended as sentences instead of as a pill. Exported so the
 * last-run card says it the same way the notice above it does.
 */
export function monitorSentence(message: string): string {
  return sentencesFromPill(message);
}

export type MountConcern = 'rejected' | 'loose' | 'unresolved' | 'suspect';

export interface MountAdvice {
  concern: MountConcern;
  level: 'bad' | 'warn';
  /** A specific sentence about what happened, not a standing invitation. */
  title: string;
  /**
   * The integrity monitor's own words, when it has words for this: its own line, never glued
   * into a template, and ended as sentences rather than left as the HUD pill it was written as.
   */
  quote: string | null;
  body: string;
  action: string;
}

export function mountAdvice(entry: SessionIndexEntry | null): MountAdvice | null {
  if (!entry) return null;

  if (!entry.trusted) {
    return {
      concern: 'rejected',
      level: 'bad',
      title: 'Your last run was thrown out',
      quote: entry.integrityMessage ? monitorSentence(entry.integrityMessage) : null,
      body: 'No angle from that drive is claimed and it takes no place on the board. It is still here as a recording you can watch.',
      action: 'Check the mount',
    };
  }

  if (entry.mount === 'loose') {
    return {
      concern: 'loose',
      level: 'bad',
      title: 'The phone was moving in its mount',
      quote: null,
      body: 'It was judged, but movement in the cradle reads as slip the car never made, so last run’s angles are worth less than they look.',
      action: 'Check the mount',
    };
  }

  // WHICH BAND, never which number. This screen used to carry its own `UNCALIBRATED = 0.4`
  // while the calibration screen carried 0.75 and the results screen wrote both as literals, so
  // one run at 0.33 was "ready to measure" on one screen and "never calibrated" on this one.
  // `calibrationBand` is the only thing that knows where the edges are, and its lower edge is
  // the monitor's own veto — so the garage can no longer disown a run the engine judged.
  // A negative quality means the entry predates the field: unknown, so nothing is claimed.
  const band = entry.calibrationQuality >= 0 ? calibrationBand(entry.calibrationQuality, entry.calibrationForwardResolved) : null;
  if (band !== null && !bandIsScorable(band)) {
    const unresolved = band === 'unresolved';
    return {
      concern: 'unresolved',
      level: 'warn',
      title: unresolved ? 'Last run never worked out which way the car points' : 'Last run never made sense of the mount',
      quote: null,
      body: unresolved
        ? 'Gravity says which way is up; which way the car points comes from one hard pull in a straight line, and that never arrived. Without it a slide and a lane change look alike.'
        : `Confidence in the mount settled at ${Math.round(entry.calibrationQuality * 100)}%, under the bar the engine will judge a slide on.`,
      action: 'Check the mount',
    };
  }

  if (entry.mount === 'suspect') {
    return {
      concern: 'suspect',
      level: 'warn',
      title: 'Last run’s mount looked unsteady',
      quote: null,
      body: 'Nothing was invalid, but a couple of degrees of every angle may have been cradle rattle rather than the car.',
      action: 'Check the mount',
    };
  }

  return null;
}
