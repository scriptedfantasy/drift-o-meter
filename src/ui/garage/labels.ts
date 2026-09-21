/**
 * The strings a session card and a session row put in their three number slots.
 *
 * Pure and separate from the components, because every one of them is an honesty rule rather
 * than a formatting choice, and a rule that cannot be tested is a rule that can be reversed by
 * a careless refactor:
 *
 *  • a run the engine refused to score publishes NO total (`SessionIntegrity.scoreTrusted`:
 *    "a consumer MUST NOT present the total… show `message` instead and offer the run as a
 *    recording"). It used to print "POINTS LOGGED 155 — A FLOOR, NOT A MEASUREMENT" at 52 px,
 *    which is exactly the claim the engine refuses to make;
 *  • the angle is the one the driver HELD, never the instantaneous peak, and never at all on a
 *    run that was not believed;
 *  • a slide count says how many of the slides the angle was measured over, because the
 *    engine's own `angleDrifts` doc asks a screen to ("8 of 11 slides — the three you spun do
 *    not count").
 */
import type { SessionIndexEntry } from '../../platform';
import { formatDuration, formatScore } from '../format';

/** A number slot: what it says, and the line under it that qualifies it. */
export interface Slot {
  value: string;
  note: string | null;
}

/**
 * The biggest angle a run can claim — and `--` when it cannot claim one.
 *
 * `SessionIndexEntry.heldPeakDeg` is the angle the driver held (`DriftStats.heldPeakDeg`), and
 * it already excludes spun drifts for the same reason the scorer does. On top of that, a run
 * the engine threw out reports no angle at all: the raw peak of a hand-held recording came out
 * at 85°, bigger than any angle any trusted run on the board holds, and printing that under the
 * word "best" in muted grey is still printing it.
 */
export function angleText(entry: Pick<SessionIndexEntry, 'heldPeakDeg'>, untrusted: boolean): string {
  if (untrusted || !(entry.heldPeakDeg > 0)) return '--';
  return `${Math.round(entry.heldPeakDeg)}°`;
}

/**
 * The slide count. On a run with spins it is the engine's `angleDrifts` out of the total, with
 * the spins named underneath — the alternative is "SLIDES 11" on a run the driver spun three
 * times. A run that was not believed asserts no slides either: the monitor did not believe the
 * sliding, and the count is a claim about the sliding.
 */
export function slidesText(entry: Pick<SessionIndexEntry, 'drifts' | 'spins'>, untrusted: boolean): Slot {
  if (untrusted) return { value: '--', note: null };
  const total = Math.max(0, Math.round(entry.drifts));
  const spins = Math.min(total, Math.max(0, Math.round(entry.spins)));
  if (spins <= 0) return { value: String(total), note: null };
  // Short on purpose: the slot is ~100 dp wide on a phone, and a note that ellipsises is worse
  // than no note. The value already says how many of the slides counted.
  return { value: `${total - spins} of ${total}`, note: `${spins} spun` };
}

/**
 * The points slot. `--` for a run the engine would not publish, with the recording's length in
 * the caption instead — the run is offered as a recording, which is what the contract asks for.
 */
export function pointsText(entry: Pick<SessionIndexEntry, 'total' | 'durationS'>, kind: 'grade' | 'void' | 'pending'): Slot {
  if (kind === 'void') return { value: '--', note: `Recording · ${formatDuration(entry.durationS)}` };
  if (kind === 'pending') return { value: '--', note: null };
  return { value: formatScore(entry.total), note: null };
}

/** The right-hand line of a list row: the run's best held angle, or what it is instead. */
export function rowFootnote(entry: Pick<SessionIndexEntry, 'heldPeakDeg' | 'durationS'>, kind: 'grade' | 'void' | 'pending'): string {
  if (kind === 'void') return 'recording only';
  if (kind === 'pending') return '';
  const angle = angleText(entry, false);
  return angle === '--' ? 'no angle held' : `${angle} held`;
}
