/** Colour + wording constants shared by the results screen's parts. */
import { calloutColor as sharedCalloutColor } from '../callouts';
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
  // Ember is THE accent, and gold means the S grade — nothing else. A 90-plus component used to
  // go gold, which put five times more gold than ember on a good run and left gold meaning "S
  // grade", "strong component", "wandering corner" and "scrappy exit" at once.
  if (score < 45) return colors.red;
  return colors.ember;
}

/**
 * The word a driver would use for the grade they just got. `gradeWord()` is what screens call:
 * a lap with no slides in it is not "Rough", it is a lap with no slides.
 */
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

/** The grade's word, except when there was nothing to grade. */
export function gradeWord(grade: Grade, drifts: number): string {
  return drifts === 0 ? 'No slides' : GRADE_WORDS[grade];
}

/**
 * Event colour by callout kind. Delegates to `src/ui/callouts.ts`, which is the one place the
 * mapping lives: a driver who learned gold means extreme angle and green means a clean exit
 * while driving must not have to unlearn it in the verdict.
 */
export function calloutColor(kind: StyleCalloutKind | string): string {
  return sharedCalloutColor(kind);
}

/** Blend two `#rrggbb` colours; `t` is how much of `b` to take. */
export function mixColor(a: string, b: string, t: number): string {
  const p = (h: string, i: number) => parseInt(h.slice(1 + i * 2, 3 + i * 2), 16);
  const f = Math.max(0, Math.min(1, t));
  const ch = (i: number) => Math.round(p(a, i) + (p(b, i) - p(a, i)) * f).toString(16).padStart(2, '0');
  return `#${ch(0)}${ch(1)}${ch(2)}`;
}
