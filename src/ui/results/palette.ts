/** Colour + wording constants shared by the results screen's parts. */
import { colors } from '../theme';
import type { Grade, StyleCalloutKind } from '../../engine/types';

/**
 * Components are NOT colour-coded by category: five hues would only repeat the word next to
 * them, and a green "consistency" bar reads as praise even when the number is 40. Every bar is
 * ember, and the colour changes only with the VERDICT — gold once a component is at S level,
 * red once it is in D territory. The eye then compares five identical bars and sees which is
 * short, which is the question the breakdown answers.
 */
export function scoreColor(score: number): string {
  if (!Number.isFinite(score)) return colors.muted;
  if (score >= 90) return colors.gold;
  if (score < 45) return colors.red;
  return colors.ember;
}

/** The word a driver would use for the grade they just got. */
export const GRADE_WORDS: Record<Grade, string> = {
  S: 'Flawless',
  A: 'Seriously quick',
  B: 'Solid night',
  C: 'Scrappy',
  D: 'Rough',
};

/** Grade thresholds on the 0–100 rating, for the scale strip. */
export const GRADE_SCALE: Array<{ grade: Grade; min: number }> = [
  { grade: 'D', min: 0 },
  { grade: 'C', min: 45 },
  { grade: 'B', min: 60 },
  { grade: 'A', min: 75 },
  { grade: 'S', min: 90 },
];

/** Uppercase name per callout kind, without the ordinal the live HUD adds. */
export const KIND_NAMES: Record<StyleCalloutKind, string> = {
  initiation: 'INITIATION',
  transition: 'TRANSITION',
  'extreme-angle': 'EXTREME ANGLE',
  'long-drift': 'LONG DRIFT',
  smooth: 'SMOOTH',
  'high-speed': 'HIGH SPEED',
  manji: 'MANJI',
  link: 'LINK',
  'perfect-exit': 'PERFECT EXIT',
  'clean-lap': 'CLEAN LAP',
};
