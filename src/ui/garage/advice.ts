/**
 * Whether the garage has anything to say about the mount — and if so, exactly what.
 *
 * Calibration is not a step in this app (see "The whole app is four steps" in docs/DESIGN.md):
 * the engine finds the vertical from gravity and the forward axis from the first hard
 * acceleration, while driving. A driver who never opens the calibration screen must not be
 * worse off for it, so the garage never stands there inviting them to calibrate.
 *
 * It speaks only when the LAST RUN left real evidence that something was wrong, and then it says
 * what was wrong rather than offering a chore. Where the integrity monitor already has a sentence
 * for the condition, that sentence is used verbatim.
 */
import type { SessionIndexEntry } from '../../platform';
import type { SessionFacts } from './facts';

export type MountConcern = 'rejected' | 'loose' | 'unresolved' | 'suspect';

export interface MountAdvice {
  concern: MountConcern;
  level: 'bad' | 'warn';
  /** A specific sentence about what happened, not a standing invitation. */
  title: string;
  body: string;
  action: string;
}

/**
 * Calibration confidence below which the results screen calls a run's mount uncalibrated
 * (`integrityNotes`: under 0.4, or an unresolved forward axis, is "Mount never calibrated").
 */
const UNCALIBRATED = 0.4;

export function mountAdvice(entry: SessionIndexEntry | null, facts: SessionFacts | undefined): MountAdvice | null {
  if (!entry || !facts) return null;

  if (!facts.trusted) {
    return {
      concern: 'rejected',
      level: 'bad',
      title: 'Your last run was thrown out',
      // the monitor's own words for the condition, never new copy for the same thing
      body: `${facts.message || 'Too much of the run could not be believed'}. Nothing from that drive was scored.`,
      action: 'Check the mount',
    };
  }

  if (facts.mount === 'loose') {
    return {
      concern: 'loose',
      level: 'bad',
      title: 'The phone was moving in its mount',
      body: 'It was scored, but movement in the cradle reads as slip the car never made, so last run’s angles are worth less than they look.',
      action: 'Check the mount',
    };
  }

  if (facts.calibrationQuality < UNCALIBRATED) {
    return {
      concern: 'unresolved',
      level: 'warn',
      title: 'Last run never worked out which way the car points',
      body: `Calibration settled at ${Math.round(facts.calibrationQuality * 100)}%. Without that, a slide and a lane change look alike — one hard pull in a straight line fixes it.`,
      action: 'Check the mount',
    };
  }

  if (facts.mount === 'suspect') {
    return {
      concern: 'suspect',
      level: 'warn',
      title: 'Last run’s mount looked unsteady',
      body: 'Nothing was invalid, but a couple of degrees of every angle may have been cradle rattle rather than the car.',
      action: 'Check the mount',
    };
  }

  return null;
}
