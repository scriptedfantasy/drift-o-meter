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
 * sentence for the condition, that sentence is `quote`d verbatim on its own line — glueing it
 * into a template produced "100% of this run's sliding could not be trusted — Phone looks
 * hand-held — clip it into a rigid mount to score drifts. Nothing from that drive was scored.",
 * two em-dash clauses and a capital P mid-sentence.
 *
 * Everything here comes from the session INDEX. It used to need the newest run's body, which
 * cost 5.48 MB and 25.5 ms of `JSON.parse` on mount for 70 bytes of text.
 */
import type { SessionIndexEntry } from '../../platform';

export type MountConcern = 'rejected' | 'loose' | 'unresolved' | 'suspect';

export interface MountAdvice {
  concern: MountConcern;
  level: 'bad' | 'warn';
  /** A specific sentence about what happened, not a standing invitation. */
  title: string;
  /** The integrity monitor's own words, when it has words for this. Its own line, never glued. */
  quote: string | null;
  body: string;
  action: string;
}

/**
 * Calibration confidence below which the results screen calls a run's mount uncalibrated
 * (`integrityNotes`: under 0.4, or an unresolved forward axis, is "Mount never calibrated").
 */
const UNCALIBRATED = 0.4;

export function mountAdvice(entry: SessionIndexEntry | null): MountAdvice | null {
  if (!entry) return null;

  if (!entry.trusted) {
    return {
      concern: 'rejected',
      level: 'bad',
      title: 'Your last run was thrown out',
      quote: entry.integrityMessage || null,
      body: 'Nothing from that drive was scored. It is still here as a recording you can watch.',
      action: 'Check the mount',
    };
  }

  if (entry.mount === 'loose') {
    return {
      concern: 'loose',
      level: 'bad',
      title: 'The phone was moving in its mount',
      quote: null,
      body: 'It was scored, but movement in the cradle reads as slip the car never made, so last run’s angles are worth less than they look.',
      action: 'Check the mount',
    };
  }

  // Negative means the entry predates the field: unknown, so nothing is claimed about it.
  if (entry.calibrationQuality >= 0 && entry.calibrationQuality < UNCALIBRATED) {
    return {
      concern: 'unresolved',
      level: 'warn',
      title: 'Last run never worked out which way the car points',
      quote: null,
      body: `Calibration settled at ${Math.round(entry.calibrationQuality * 100)}%. Without that, a slide and a lane change look alike — one hard pull in a straight line fixes it.`,
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
