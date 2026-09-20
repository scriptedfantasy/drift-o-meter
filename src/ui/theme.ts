/**
 * Drift-O-Meter design tokens.
 *
 * One identity, always dark: night street racing. Asphalt-black ground, condensed italic
 * display type for anything dramatic (angles, scores, headlines), a hot ember accent for
 * "drift active" and points, cyan for cold telemetry, magenta for transitions and callouts.
 *
 * This module is pure constants so it can be imported from the engine tests, the harness and
 * the app alike. React Native / Reanimated specific helpers live in `motion.ts` and `fonts.ts`.
 */

export const colors = {
  /** Page background: asphalt black. */
  bg0: '#07090D',
  /** Raised surfaces: panels, cards. */
  bg1: '#0E1218',
  /** Interactive surfaces: rows, chips, inputs. */
  bg2: '#161C25',
  /** Hairlines and borders. */
  line: '#232B37',
  /** Primary text. */
  text: '#F2F0EB',
  /** Secondary text, labels. */
  muted: '#8A93A6',
  /** Drift active, score, primary action. */
  ember: '#FF5A1F',
  /** Telemetry, speed, cold data. */
  cyan: '#29E3FF',
  /** Transitions, style callouts. */
  magenta: '#FF2D95',
  /** S grade. */
  gold: '#FFC53D',
  /** Clean / smooth / good. */
  green: '#3DFF9A',
  /** Danger, errors, invalid data. */
  red: '#FF3B3B',
} as const;

export type ColorToken = keyof typeof colors;

/** Grade → colour. S is gold, D is muted; everything in between cools down. */
export const gradeColors = {
  S: colors.gold,
  A: colors.ember,
  B: colors.cyan,
  C: colors.text,
  D: colors.muted,
} as const;

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
  /** Giant live numbers: slip angle, final score. */
  hero: { fontFamily: fontFamilies.display.extraboldItalic, fontSize: 112, lineHeight: 104, letterSpacing: -3 },
  /** Big numbers and one-word headlines. */
  display: { fontFamily: fontFamilies.display.extraboldItalic, fontSize: 72, lineHeight: 68, letterSpacing: -2 },
  /** Screen titles. */
  title: { fontFamily: fontFamilies.display.extraboldItalic, fontSize: 44, lineHeight: 44, letterSpacing: -1 },
  /** Section headings. */
  heading: { fontFamily: fontFamilies.display.bold, fontSize: 28, lineHeight: 30, letterSpacing: 0 },
  /** Sub headings, button labels. */
  subheading: { fontFamily: fontFamilies.display.semibold, fontSize: 20, lineHeight: 24, letterSpacing: 0.6, textTransform: 'uppercase' },
  /** HUD telemetry numbers. */
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
    /** Replay camera moves, score reveals. */
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
    /** Slight overshoot, for callouts and score pops. */
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
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, a))})`;
}
