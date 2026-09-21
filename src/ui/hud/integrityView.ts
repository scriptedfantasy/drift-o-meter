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
 * the monitor is describing its own startup, so the HUD says that, calmly, in cyan.
 */
import { colors } from '../theme';
import type { HudSnapshot } from './useDriveRun';

export type IntegrityTier = 'ok' | 'calibrating' | 'warn' | 'severe';

export interface IntegrityView {
  tier: IntegrityTier;
  heading: string;
  message: string;
  /**
   * What the score block should admit, or null when the numbers can be taken at face value.
   * Deliberately specific: with no fix the scorer really is not counting, while with a loose
   * mount it IS counting points off a reading nobody should stand behind. Saying "not scoring"
   * in both cases would be wrong in one of them.
   */
  scoreNote: string | null;
  /**
   * The colour that note is set in. RED is a fault that has stopped the scoring; WHITE is a
   * degraded-but-still-counting state, which is information rather than an alarm; MUTED is an
   * aside. GOLD APPEARS NOWHERE — it is the colour of an extreme angle and of the multiplier
   * chip, and the same hue cannot mean "you are a hero" and "your phone is loose". It did: the
   * GPS-dropout frame carried a gold "NO FIX — DEAD-RECKONED FROM THE GYRO" under a gold "×2.0"
   * and a gold "PEAK 37°", three meanings of one colour inside one third of the screen.
   */
  noteTone: string;
}

/** How long the calibrator is allowed to be "still working it out" before that is a fault. */
export const CALIBRATION_GRACE_S = 8;

export function readIntegrity(snapshot: HudSnapshot): IntegrityView {
  const { mount, gps, physics, message } = snapshot.integrity;
  const settling = !snapshot.forwardResolved && snapshot.elapsedS < CALIBRATION_GRACE_S;
  // "Not scoring" is the SCORER's word (`LiveFrame.score.counting` — the gate it actually ran
  // under), never this component's guess. Through a GPS dropout the engine dead-reckons β and
  // keeps paying; a note inferred from `gps: 'none'` claimed the opposite, and the results
  // screen then banked those points.
  const counting = snapshot.counting;
  const stopped = (reason: string) => `${reason} — NOT SCORING`;
  const view = (tier: IntegrityTier, heading: string, scoreNote: string | null): IntegrityView => ({
    tier,
    heading,
    message,
    scoreNote,
    noteTone: scoreNote === null ? colors.muted : tier === 'severe' && !counting ? colors.red : tier === 'severe' ? colors.text : colors.muted,
  });

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
