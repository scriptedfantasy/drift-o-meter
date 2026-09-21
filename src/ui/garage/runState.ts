/**
 * What a run's slot on this screen is in — and the one state that is a refusal.
 *
 * This is what is left of `grade.ts` after the letters went. The letter was never the point:
 * the point is that a list has THREE states to draw and only one of them is a run whose
 * numbers may be printed. When the engine refuses to vouch for a run
 * (`SessionIntegrity.scoreTrusted === false`) the row may not present its figures as
 * achievements, and the screen has to say which of the three it is looking at before it picks
 * a colour or a word.
 *
 * Pure, and separate from the components, so the rule can be tested without a renderer.
 */
import { angleColor, colors } from '../theme';

export type RunStateKind = 'judged' | 'void' | 'pending';

export interface RunState {
  kind: RunStateKind;
}

/**
 * `trusted` comes straight off the index and is UNDEFINED for a row written before the field
 * existed, so an unknown verdict is `pending` rather than a run whose angle we print. Guessing
 * here means presenting a figure the engine has already refused to stand behind.
 */
export function runStateOf(trusted: boolean | undefined): RunState {
  if (trusted === undefined) return { kind: 'pending' };
  return { kind: trusted ? 'judged' : 'void' };
}

/**
 * The colour a card, a row or a plot takes from the run behind it.
 *
 * RED FOR A REFUSED RUN IS THE POINT OF THIS FUNCTION. It carried the same signal when the
 * three states were grades — grade colour / red / hairline — and losing the letters must not
 * lose it: a run the engine threw out is the one thing on this screen the driver has to be
 * able to pick out at a glance, and the tail-light red is what says so.
 *
 * A judged run takes the colour of the angle it held, from the one ramp every screen shares,
 * so a 58° night and a 58° row are the same colour. A judged run that held no angle has no
 * achievement to colour and falls back to the grey that means the engine vouches for nothing
 * here.
 */
export function runStateColor(state: RunState, heldPeakDeg = 0): string {
  if (state.kind === 'void') return colors.red;
  if (state.kind === 'pending') return colors.line;
  return heldPeakDeg > 0 ? angleColor(heldPeakDeg) : colors.muted;
}
