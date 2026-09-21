/**
 * What integrity is saying, how loudly, and in what colour. ONE function decides all three,
 * because deriving the tone from one field and the headline from another is how every run used
 * to open with a red alarm titled MOUNT SHAKING while the actual condition was "no GPS lock
 * yet".
 *
 * It is pure — no React, no React Native — for one reason: this is the function that decides
 * whether the drive display says NOT SCORING, a screen has already been failed once over what
 * it says here, and a function that cannot be imported by a test is a function nobody checks.
 * `hud.test.ts` runs the whole table.
 *
 * Until the calibrator has resolved which way the car points, no mount verdict means anything —
 * the monitor is describing its own startup, so the HUD says that, calmly, in blue.
 */
import { colors } from '../theme';
import type { HudSnapshot } from './useDriveRun';

export type IntegrityTier = 'ok' | 'calibrating' | 'warn' | 'severe';

export interface IntegrityView {
  tier: IntegrityTier;
  heading: string;
  message: string;
  /**
   * What a screen reporting this state should admit, or null when the reading can be taken at
   * face value. Deliberately specific: with no fix the scorer really is not counting, while with
   * a loose mount it IS counting off a reading nobody should stand behind. Saying "not scoring"
   * in both cases would be wrong in one of them.
   *
   * NAMED FOR THE GATE, NOT FOR THE SCORE. The sentence it carries still ends "— NOT SCORING",
   * because that is the driver's word for it; the field is named after `LiveFrame.score.counting`
   * because that is the only thing it is ever allowed to be derived from.
   */
  countingNote: string | null;
  /**
   * The colour that note is set in. RED is a fault that has stopped the counting; WHITE is a
   * degraded-but-still-counting state, which is information rather than an alarm; MUTED is an
   * aside.
   *
   * GREEN APPEARS NOWHERE, and neither did the gold it replaced. Green means the car is being
   * measured right now; a warning in it would be the second meaning that broke the old palette,
   * where one hue carried a gold "NO FIX — DEAD-RECKONED FROM THE GYRO" under a gold "×2.0" and
   * a gold "PEAK 37°" — three meanings of one colour inside one third of the screen.
   */
  noteTone: string;
  /**
   * True when the note is the sentence "… — NOT SCORING", i.e. when this state is telling the
   * driver that the engine has stopped counting altogether.
   *
   * PUBLISHED rather than sniffed out of `countingNote`, so a reader never has to match on the
   * string. It is NOT the same question as `trust`: on a weak fix or a shaking mount `trust` is
   * 0.65 and the engine is still counting, which is a degraded reading rather than a stopped
   * one. A screen that greyed its total on `trust` alone printed a full-strength score with NOT
   * SCORING written underneath it.
   */
  countingStopped: boolean;
}

/** How long the calibrator is allowed to be "still working it out" before that is a fault. */
export const CALIBRATION_GRACE_S = 8;

/** A note, and whether it is the one that says the engine has stopped counting altogether. */
interface Note {
  text: string;
  halted: boolean;
}

export function readIntegrity(snapshot: HudSnapshot): IntegrityView {
  const { mount, gps, physics, message } = snapshot.integrity;
  const settling = !snapshot.forwardResolved && snapshot.elapsedS < CALIBRATION_GRACE_S;
  // "Not scoring" is the SCORER's word (`LiveFrame.score.counting` — the gate it actually ran
  // under), never this function's guess. Through a GPS dropout the engine dead-reckons β and
  // keeps paying; a note inferred from `gps: 'none'` claimed the opposite, and the results
  // screen then banked those points.
  const counting = snapshot.counting;
  /** A note that says the score has STOPPED, tagged as such so nothing has to read the string. */
  const stopped = (reason: string): Note => ({ text: `${reason} — NOT SCORING`, halted: true });
  const view = (tier: IntegrityTier, heading: string, note: Note | string | null): IntegrityView => {
    const n: Note | null = note === null ? null : typeof note === 'string' ? { text: note, halted: false } : note;
    return {
      tier,
      heading,
      message,
      countingNote: n === null ? null : n.text,
      countingStopped: n !== null && n.halted,
      noteTone: n === null ? colors.muted : tier === 'severe' && !counting ? colors.red : tier === 'severe' ? colors.text : colors.muted,
    };
  };

  if (mount === 'loose') return view('severe', 'LOOSE MOUNT', counting ? 'MOUNT LOOSE — THESE POINTS MAY NOT STAND' : stopped('MOUNT LOOSE'));
  if (physics === 'implausible') {
    return view('severe', 'IMPLAUSIBLE READINGS', counting ? 'READINGS ARE NOT PHYSICALLY POSSIBLE' : stopped('IMPLAUSIBLE READINGS'));
  }
  if (gps === 'none' && snapshot.gpsEverGood) return view('severe', 'GPS LOST', counting ? 'NO FIX — DEAD-RECKONED FROM THE GYRO' : stopped('NO FIX'));
  // The first seconds of every run: no fix yet and the forward axis still unknown. That is the
  // monitor describing its own startup, not an alarm, and it gets said calmly.
  if (settling) return view('calibrating', 'FINDING FORWARD', counting ? null : 'WAITING FOR THE FIRST FIX');
  if (gps === 'none') return view('warn', 'WAITING FOR GPS', counting ? 'NO FIX YET — DEAD-RECKONED' : 'WAITING FOR THE FIRST FIX');
  if (gps === 'poor') return view('warn', 'WEAK GPS', counting ? null : stopped('WEAK GPS'));
  if (mount === 'suspect') return view('warn', 'MOUNT SHAKING', counting ? null : stopped('MOUNT SHAKING'));
  if (!snapshot.forwardResolved) return view('warn', 'FINDING FORWARD', null);
  // Everything reads fine and the scorer is simply not paying — parked, crawling, between
  // slides. That is not a fault and the HUD does not nag about it.
  return view('ok', '', null);
}
