/**
 * What the grade slot of a session row is in — and the one state that is not a grade.
 *
 * Pure, and separate from `GradeBadge.tsx`, so the rule can be tested without a renderer: when
 * the engine refuses to vouch for a run (`SessionIntegrity.scoreTrusted === false`) a list may
 * not show a letter at all.
 */
import type { Grade } from '../../engine/types';
import { colors, gradeColors } from '../theme';

export type GradeState = { kind: 'grade'; grade: Grade } | { kind: 'void' } | { kind: 'pending' };

/**
 * `trusted` comes straight off the index and defaults to FALSE for a row written before the
 * field existed, so an unknown verdict shows the plate rather than a grade. `pending` is kept
 * for a row whose entry has genuinely not arrived yet.
 */
export function gradeStateOf(grade: Grade, trusted: boolean | undefined): GradeState {
  if (trusted === undefined) return { kind: 'pending' };
  return trusted ? { kind: 'grade', grade } : { kind: 'void' };
}

export function gradeStateColor(state: GradeState): string {
  if (state.kind === 'grade') return gradeColors[state.grade] ?? colors.muted;
  return state.kind === 'void' ? colors.red : colors.line;
}
