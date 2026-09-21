/**
 * Drift-O-Mania design tokens.
 *
 * Three colours, all taken off the car, and one grey.
 *
 *   BLUE   the car at rest. Surfaces, structure, and cold facts nobody is judged on:
 *          speed, lap, the simulator. Measured off the RPS13's paint: 75,253 pixels
 *          across four photographs, hue 215, #070D18 in shadow and #384E6C in the sun.
 *   RED    the limit, and the way out. The tail lenses (hue 352): the red zone past
 *          60° where a slide becomes a spin, STOP, and anything that went wrong.
 *          Never a reward.
 *   GREEN  a race is happening. Measured off assets/brand: 36,599 green pixels in the
 *          mark, 38,448 in the wordmark. Body #8AF606 at hue 85, highlight #C4FF2E.
 *          The whole live instrument is this green, and NOTHING is green unless the
 *          car is being measured right now.
 *   GREY   the engine does not vouch for this.
 *
 * There is no orange, cyan, magenta or gold any more, and no left accent stripes.
 * Severity is the text colour, never a bar down the side of a card.
 *
 * This module is pure constants so it can be imported from the engine tests, the harness
 * and the app alike. React Native / Reanimated helpers live in `motion.ts` and `fonts.ts`.
 */

export const colors = {
  /** Page background: the car's paint in shadow. */
  bg0: '#070D18',
  /** Raised surfaces: panels, cards. */
  bg1: '#0D1626',
  /** Interactive surfaces: rows, chips, inputs. */
  bg2: '#18243A',
  /** Hairlines and borders. */
  line: '#2A3A52',
  /** Primary text. */
  text: '#F2F0EB',
  /** Secondary text and labels. The one grey: the engine does not vouch for this. */
  muted: '#7F8DA6',

  /** The car at rest. Speed, structure, cold facts nobody is judged on. */
  blue: '#6C9BEA',
  /** The tail lights. The limit, STOP, and anything that went wrong. */
  red: '#FF2E43',
  /** The logo's green. A run is happening. */
  green: '#8AF606',
  /** The highlight the artwork ramps into, on the way to the red zone. */
  greenHot: '#C4FF2E',
  /** The deep keyline under every stroke of the mark. */
  greenDeep: '#17640C',

  /* ---------------------------------------------------------------------------------- *
   * MIGRATION SHIM — every key below is deleted before this branch is done.
   *
   * The repaint touches around sixty files. Deleting the old tokens outright would break
   * every one of them at once and leave nothing type-checking until the last is fixed, so
   * instead each old name points at whichever new colour carries its meaning. The build
   * stays green while the screens move across one at a time, and when `grep -rn 'colors\.
   * \(ember\|cyan\|magenta\|gold\)'` finds nothing, they go — which is also the proof that
   * the migration finished.
   *
   * DO NOT write new code against these.
   * ---------------------------------------------------------------------------------- */

  /** @deprecated Was "drift active, score, primary action". Use `colors.green`. */
  ember: '#8AF606',
  /** @deprecated Was "telemetry, speed, cold data". Use `colors.blue`. */
  cyan: '#6C9BEA',
  /** @deprecated Was "transitions, style callouts", both of which are gone. Use `colors.muted`. */
  magenta: '#7F8DA6',
  /** @deprecated Was "S grade" and "mount suspect" at once. Use `colors.greenHot` for caution. */
  gold: '#C4FF2E',
} as const;

export type ColorToken = keyof typeof colors;

/**
 * @deprecated Letter grades are gone; the peak angle leads instead. Kept only so the
 * screens that still render a badge keep compiling until they are rebuilt. Delete with
 * the rest of the shim.
 */
export const gradeColors = {
  S: colors.greenHot,
  A: colors.green,
  B: colors.blue,
  C: colors.text,
  D: colors.muted,
} as const;

/**
 * The dial's colour ramp, in degrees of slip.
 *
 * The mark is already a green-to-yellow gradient, so the scale borrows it and runs on
 * into the car's own red where a slide becomes a spin. One ramp, made of the two things
 * the app is named after and driven in.
 *
 * Skia draws this as a single SweepGradient; the SVG mockup approximates it with one
 * short arc segment per 2.5°. Both must agree, so both read these stops.
 */
export const ANGLE_STOPS: ReadonlyArray<{ deg: number; color: string }> = [
  { deg: 0, color: colors.green },
  { deg: 40, color: colors.green },
  { deg: 55, color: colors.greenHot },
  { deg: 70, color: colors.red },
];

/**
 * Full scale, in degrees: the top of the dial's sweep and the top of any angle axis.
 *
 * Read off `ANGLE_STOPS` rather than typed, so the number and the colour at that number
 * cannot drift apart. Every display that plots an angle uses this, which is the point —
 * the garage's run trace used to top out at 60 because that was the last knot of the
 * scorer's angle curve, so the same 64-degree hold drew full-height in the garage and
 * nine-tenths of the way round the dial.
 *
 * It is a DISPLAY ceiling, deliberately below the engine's `SPIN_ANGLE_DEG` of 75: past
 * this the needle is already in the red and the question has stopped being how far and
 * started being whether the car comes back.
 */
export const MAX_ANGLE_DEG = ANGLE_STOPS[ANGLE_STOPS.length - 1].deg;

function hexToRgb(hex: string): [number, number, number] {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}

/**
 * |slip angle| in degrees → the ramp colour at that angle, as `#RRGGBB`.
 *
 * Pure and allocation-light, but it parses hex on every call, so the 100 Hz dial uses
 * Reanimated's `interpolateColor` over `ANGLE_STOPS` on the UI thread instead. This is
 * for React-side rendering: the results screen, the garage rows, the slide list.
 */
export function angleColor(absDeg: number): string {
  const d = Number.isFinite(absDeg) ? Math.max(0, absDeg) : 0;
  for (let i = 1; i < ANGLE_STOPS.length; i++) {
    const hi = ANGLE_STOPS[i];
    const lo = ANGLE_STOPS[i - 1];
    if (d <= hi.deg || i === ANGLE_STOPS.length - 1) {
      const t = Math.max(0, Math.min(1, (d - lo.deg) / (hi.deg - lo.deg)));
      const a = hexToRgb(lo.color);
      const b = hexToRgb(hi.color);
      const ch = [0, 1, 2].map((k) => Math.round(a[k] + (b[k] - a[k]) * t));
      return `#${ch.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
    }
  }
  return colors.green;
}

/** `#RRGGBB` + alpha (0..1) → `#RRGGBBAA`. */
export function alpha(hex: string, a: number): string {
  const v = Math.round(Math.max(0, Math.min(1, a)) * 255);
  return `${hex.slice(0, 7)}${v.toString(16).padStart(2, '0')}`;
}

/**
 * Font family names as registered with expo-font (see `fonts.ts`). These are the exact
 * `fontFamily` strings to use in styles; on web they double as the CSS family name.
 */
export const fontFamilies = {
  display: {
    semibold: 'BarlowCondensed_600SemiBold',
    semiboldItalic: 'BarlowCondensed_600SemiBold_Italic',
    bold: 'BarlowCondensed_700Bold',
    boldItalic: 'BarlowCondensed_700Bold_Italic',
    extrabold: 'BarlowCondensed_800ExtraBold',
    extraboldItalic: 'BarlowCondensed_800ExtraBold_Italic',
  },
  body: {
    regular: 'Barlow_400Regular',
    medium: 'Barlow_500Medium',
    semibold: 'Barlow_600SemiBold',
  },
} as const;

export interface TypeToken {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  letterSpacing?: number;
  textTransform?: 'uppercase' | 'none';
}

/** Type scale. Display faces are Barlow Condensed, body faces are Barlow. */
export const typeScale = {
  /** Giant live numbers: the slip angle under the dial. */
  hero: { fontFamily: fontFamilies.display.extraboldItalic, fontSize: 112, lineHeight: 104, letterSpacing: -3 },
  /** Big numbers and one-word headlines. */
  display: { fontFamily: fontFamilies.display.extraboldItalic, fontSize: 72, lineHeight: 68, letterSpacing: -2 },
  /** Screen titles. */
  title: { fontFamily: fontFamilies.display.extraboldItalic, fontSize: 44, lineHeight: 44, letterSpacing: -1 },
  /** Section headings. */
  heading: { fontFamily: fontFamilies.display.bold, fontSize: 28, lineHeight: 30, letterSpacing: 0 },
  /** Sub headings, button labels. */
  subheading: { fontFamily: fontFamilies.display.semibold, fontSize: 20, lineHeight: 24, letterSpacing: 0.6, textTransform: 'uppercase' },
  /** Telemetry numbers: the stat grid, the per-slide angles. */
  telemetry: { fontFamily: fontFamilies.display.bold, fontSize: 34, lineHeight: 36, letterSpacing: -0.5 },
  body: { fontFamily: fontFamilies.body.regular, fontSize: 16, lineHeight: 22 },
  bodyStrong: { fontFamily: fontFamilies.body.semibold, fontSize: 16, lineHeight: 22 },
  small: { fontFamily: fontFamilies.body.regular, fontSize: 14, lineHeight: 19 },
  /** Uppercase labels above values. */
  label: { fontFamily: fontFamilies.body.semibold, fontSize: 12, lineHeight: 16, letterSpacing: 1.3, textTransform: 'uppercase' },
  /** Tiny uppercase metadata. */
  micro: { fontFamily: fontFamilies.body.medium, fontSize: 11, lineHeight: 14, letterSpacing: 1.1, textTransform: 'uppercase' },
} as const satisfies Record<string, TypeToken>;

export type TypeVariant = keyof typeof typeScale;

/** 4-based spacing scale. `space[4]` is 16. */
export const space = {
  0: 0,
  1: 4,
  2: 8,
  3: 12,
  4: 16,
  5: 20,
  6: 24,
  8: 32,
  10: 40,
  12: 48,
  16: 64,
  20: 80,
} as const;

/** Horizontal screen gutter. */
export const gutter = 20;

export const radii = {
  sm: 4,
  md: 8,
  lg: 14,
  xl: 22,
  pill: 999,
} as const;

export const motion = {
  /** Durations in ms. */
  duration: {
    /** Micro feedback: press states, toggles. */
    fast: 120,
    /** Standard transitions. */
    base: 220,
    /** Panels, sheets, route changes. */
    slow: 420,
    /** Replay camera moves. */
    cinematic: 900,
  },
  /** cubic-bezier control points (x1, y1, x2, y2). Mapped to Reanimated in `motion.ts`. */
  easing: {
    /** Fast arrival, long settle. The default for anything entering. */
    out: [0.16, 1, 0.3, 1],
    /** Symmetric, for things that move from one resting place to another. */
    inOut: [0.65, 0, 0.35, 1],
    /** Accelerating exit. */
    in: [0.7, 0, 0.84, 0],
    /** Slight overshoot. */
    overshoot: [0.34, 1.56, 0.64, 1],
    linear: [0, 0, 1, 1],
  },
} as const;

/** Cross-platform glow (uses the `boxShadow` style prop; supported on iOS, Android and web). */
export function glow(color: string, strength = 1): { boxShadow: string } {
  const blur = Math.round(24 * strength);
  return { boxShadow: `0 0 ${blur}px ${alpha(color, 0.55 * strength)}` };
}

export const theme = { colors, gradeColors, fontFamilies, typeScale, space, gutter, radii, motion } as const;

export default theme;

/** `#RRGGBB` + alpha → `rgba(r, g, b, a)`; use this for Skia colours (8-digit hex is not portable). */
export function rgba(hex: string, a: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, a))})`;
}

