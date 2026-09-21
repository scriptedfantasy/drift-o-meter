/**
 * What colour a style callout wears, for the whole app.
 *
 * WHY THIS IS ONE FILE. A driver learns these colours in the car, at speed, while the
 * callouts are slamming onto the drive display. If the verdict screen then paints the same
 * events differently, they have to unlearn them — so the mapping is a single product
 * decision, not a per-screen style choice.
 *
 * It lived in two places until now, and the two had already drifted: the drive display gave
 * the initiation callout the ember default while the results screen gave it muted. Nobody
 * decided that; one copy simply moved. The muted version is the intended one, because an
 * initiation fires on every single drift and a colour that appears every time is not telling
 * anyone anything.
 *
 * `EventTone` is the name of the role; `toneColor` resolves it against the theme. Screens
 * that need a colour straight from a callout kind use `calloutColor`.
 */
import { colors } from './theme';

export type EventTone = 'ember' | 'magenta' | 'gold' | 'green' | 'cyan' | 'red' | 'muted';

/**
 * The mapping, by what each colour MEANS rather than by which screen shows it:
 *  - magenta is a direction change, the move the design gives its own flash and haptic
 *  - gold is an angle past the point where holding more is remarkable
 *  - green is cleanliness: a slide exited well, held steady, or a lap driven without a spin
 *  - cyan is speed, matching the telemetry it is read beside
 *  - muted is an event that fires on every drift and therefore carries no news
 *  - ember, the app's accent, is everything else
 */
export function toneFor(kind: string): EventTone {
  switch (kind) {
    case 'transition':
    case 'manji':
      return 'magenta';
    case 'extreme-angle':
      return 'gold';
    case 'smooth':
    case 'perfect-exit':
    case 'clean-lap':
      return 'green';
    case 'high-speed':
      return 'cyan';
    case 'initiation':
      return 'muted';
    default:
      return 'ember';
  }
}

export const TONE_COLORS: Record<EventTone, string> = {
  ember: colors.green,
  magenta: colors.blue,
  gold: colors.greenHot,
  green: colors.green,
  cyan: colors.blue,
  red: colors.red,
  muted: colors.muted,
};

export function toneColor(tone: EventTone): string {
  return TONE_COLORS[tone];
}

/** The colour for a callout kind, for screens that do not carry the tone around. */
export function calloutColor(kind: string): string {
  return TONE_COLORS[toneFor(kind)];
}
