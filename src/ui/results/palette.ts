/** Colour + wording constants shared by the results screen's parts. */
import { colors } from '../theme';
import type { Grade, StyleCalloutKind } from '../../engine/types';

/** One colour per scored component. Ember is the headline, so `angle` (30 %) owns it. */
export const COMPONENT_COLORS = {
  angle: colors.ember,
  consistency: colors.green,
  quality: colors.cyan,
  speed: colors.text,
  style: colors.magenta,
} as const;

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
