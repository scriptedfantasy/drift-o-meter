/**
 * Constants for the last-run card's slide trace, in a module with no Skia in it.
 *
 * `SlideTrace.tsx` imports `@shopify/react-native-skia`, which binds `global.CanvasKit` at
 * module evaluation — so on web nothing in a route's import graph may reach it. The card needs
 * the ceiling to caption the plot, and this is how it gets it.
 */

/**
 * Degrees at the top of the plot. 60° is where the scorer's angle curve tops out
 * (`score/rules.ts`, `angleCurve`: 100 at 60°), so a ridge that touches the top is a slide at
 * the top of what the engine scores rather than at the top of an arbitrary axis.
 */
export const TRACE_CEILING_DEG = 60;
