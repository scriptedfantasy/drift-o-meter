/**
 * The strings a session card and a session row put in their slots.
 *
 * Pure and separate from the components, because every one of them is an honesty rule rather
 * than a formatting choice, and a rule that cannot be tested is a rule that can be reversed by
 * a careless refactor:
 *
 *  • the angle is the one the driver HELD, never the instantaneous peak, and never at all on a
 *    run that was not believed;
 *  • a slide count says how many of the slides the angle was measured over, because the
 *    engine's own `angleDrifts` doc asks a screen to ("8 of 11 slides — the three you spun do
 *    not count");
 *  • a run the engine refused to vouch for publishes no judged figure of any kind. It used to
 *    print "POINTS LOGGED 155 — A FLOOR, NOT A MEASUREMENT" at 52 px, which is exactly the
 *    claim the engine refuses to make (`SessionIntegrity.scoreTrusted`: "a consumer MUST NOT
 *    present the total… show `message` instead and offer the run as a recording"). The points
 *    are gone; the rule they were the test case for is not.
 */
import type { SessionIndexEntry } from '../../platform';
import { formatDuration } from '../format';
import type { RunStateKind } from './runState';
import { sidewaysSeconds } from './runFacts';

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
 * How long the biggest angle was HELD, for the line under it.
 *
 * `SessionIndexEntry.peakHeldS` — the engine's `DriftSummary.sustainedS` for the same slide the
 * angle came off, which is the field the run review already prints under HELD. Two screens
 * describing one slide with two definitions of that word is how a driver stops trusting both.
 *
 * This said "slide" for a while and printed the whole slide's length, the only duration the
 * index could then yield, which counts the ramp in and the gather at the end as time sideways.
 */
export function holdText(heldS: number): string {
  if (!Number.isFinite(heldS) || heldS <= 0) return '--';
  return heldS >= 10 ? `${Math.round(heldS)}s` : `${heldS.toFixed(1)}s`;
}

/**
 * The speed the peak slide was entered at, in whole km/h.
 *
 * `--` at zero rather than "0", because zero here means the run named no slide at all — the
 * three figures the board prints come off one slide and arrive together or not at all — and a
 * board reading "0" under KM/H would be claiming the car was stationary.
 */
export function speedText(entryKmh: number): string {
  if (!Number.isFinite(entryKmh) || entryKmh <= 0) return '--';
  return String(Math.round(entryKmh));
}

/**
 * The slide count. On a run with spins it is the engine's `angleDrifts` out of the total, with
 * the spins named underneath — the alternative is "SLIDES 11" on a run the driver spun three
 * times.
 *
 * A run that was not believed publishes no count: a judged slide count is a claim about the
 * sliding, and the monitor did not believe the sliding. It does say how many slides the
 * RECORDING holds, because the card draws them — `SLIDES --` used to sit directly under a plot
 * with seven countable marks on it, which is the screen refusing a number and then drawing it.
 * The trace and this note now say the same thing: recorded, not judged.
 */
export function slidesText(entry: Pick<SessionIndexEntry, 'drifts' | 'spins'>, untrusted: boolean): Slot {
  if (untrusted) {
    const recorded = Math.max(0, Math.round(entry.drifts));
    return { value: '--', note: recorded > 0 ? `${recorded} recorded` : null };
  }
  const total = Math.max(0, Math.round(entry.drifts));
  const spins = Math.min(total, Math.max(0, Math.round(entry.spins)));
  if (spins <= 0) return { value: String(total), note: null };
  // Short on purpose: the slot is ~100 dp wide on a phone, and a note that ellipsises is worse
  // than no note. The value already says how many of the slides counted.
  return { value: `${total - spins} of ${total}`, note: `${spins} spun` };
}

/**
 * The middle line of a run row: what the run was made of.
 *
 * TIME SIDEWAYS IS A CLAIM ABOUT SLIDING, so a run the monitor did not believe does not get
 * one. It gets the length of the recording instead, which is a fact about the file rather than
 * about the driving — the same distinction the slide count makes one line up, and the same one
 * the trace's own caption makes over the plot.
 */
export function runShapeText(entry: Pick<SessionIndexEntry, 'drifts' | 'spins' | 'durationS' | 'slides'>, kind: RunStateKind): string {
  const recorded = Math.max(0, Math.round(entry.drifts));
  if (kind !== 'judged') {
    // Short on purpose: with the driver's name in front of it this line is ~230 dp wide on a
    // 390 pt screen, and "5 slides recorded · not j…" is a refusal that ellipsises away.
    return recorded > 0 ? `${recorded} recorded · not judged` : `Recording · ${formatDuration(entry.durationS)}`;
  }
  const slides = slidesText(entry, false);
  const counted = slides.note ? `${slides.value} slides · ${slides.note}` : `${slides.value} ${recorded === 1 ? 'slide' : 'slides'}`;
  const sideways = sidewaysSeconds(entry);
  return sideways > 0 ? `${counted} · ${formatDuration(sideways)} sideways` : counted;
}

/** The right-hand line of a list row: the run's best held angle, or what it is instead. */
export function rowFootnote(entry: Pick<SessionIndexEntry, 'heldPeakDeg' | 'durationS'>, kind: RunStateKind): string {
  if (kind === 'void') return 'recording only';
  if (kind === 'pending') return '';
  const angle = angleText(entry, false);
  return angle === '--' ? 'no angle held' : `${angle} held`;
}
