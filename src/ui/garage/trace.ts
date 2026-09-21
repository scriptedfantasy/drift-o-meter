/**
 * The rule behind the last-run card's slide trace: what a mark on it is allowed to mean.
 *
 * Kept in a module with no Skia in it for two reasons. `SlideTrace.tsx` imports
 * `@shopify/react-native-skia`, which binds `global.CanvasKit` at module evaluation — so on web
 * nothing in a route's import graph may reach it, and the card still needs the axis to caption
 * the plot. And the rule below is an honesty rule rather than a drawing detail, so it belongs
 * somewhere a test can reach without a canvas.
 *
 * ── THE RULE ──────────────────────────────────────────────────────────────────────────────
 * A mark gets a HEIGHT only when the app is willing to state the angle it stands for: the run
 * was believed AND the slide was not a spin. Everything else is a FOOTPRINT — where the car was
 * sideways and for how long, drawn in the gutter under the axis, claiming no angle at all.
 *
 * It is one rule because it had been two bugs. The trace drew every spun slide at
 * `DriftEvent.peakAngle` — the instantaneous peak, 118° on the shipped fixtures — on an axis
 * captioned "held angle" and clamped to its 60° ceiling, so three spins drew as three identical
 * full-height walls directly above the same card's "HELD ANGLE 18°". The index field they were
 * written into (`SessionIndexEntry.heldPeakDeg`) names that exact number as the thing it is not.
 * The untrusted case was the same claim by another route: a run whose angle the card prints as
 * `--` cannot have its angles drawn either. Both are now footprints.
 */
import { DEFAULT_SCORE_OPTIONS } from '../../engine/score';
import type { SlideMark } from '../../platform';

/**
 * Degrees at the top of the plot: the last knot of the scorer's own angle curve, which is where
 * the angle component stops paying more (100 at 60°). Taken from `DEFAULT_SCORE_OPTIONS`, never
 * typed out here — `docs/ARCHITECTURE.md` names that knot as "the first thing to re-derive from
 * real data", and a ceiling copied into this file would let the axis label go on saying "60°
 * TOP" after the curve had moved. `trace.test.ts` fails if the curve stops being a scale that
 * tops out at its last knot.
 */
export const TRACE_CEILING_DEG = DEFAULT_SCORE_OPTIONS.angleCurve[DEFAULT_SCORE_OPTIONS.angleCurve.length - 1][0];

/** One drawn mark, in fractions so the geometry can be checked without a canvas. */
export interface TraceBar {
  /** Start and end across the plot, 0..1 of the recording. */
  x0: number;
  x1: number;
  /**
   * Height as a fraction of the plot's headroom, 0..1. Never above 1 — a slide past the ceiling
   * is drawn AT the ceiling, because the caption states what the top of the axis is.
   */
  height: number;
  /**
   * `held` — the angle the driver held through this slide, on the axis.
   * `footprint` — a slide the app will not state an angle for: a spin, or any slide in a run the
   * integrity monitor did not believe. Drawn under the axis, with no height.
   */
  kind: 'held' | 'footprint';
}

export interface TraceOptions {
  /** False when the integrity monitor did not believe this run's sliding. */
  believed?: boolean;
  /** Degrees at the top of the plot. */
  ceilingDeg?: number;
}

/** True when this mark stands for an angle the app is willing to state. */
function measured(mark: SlideMark, believed: boolean): boolean {
  return believed && mark[3] !== 1;
}

/** The marks of one run, as geometry. Pure: the same input always draws the same picture. */
export function traceBars(slides: readonly SlideMark[], { believed = true, ceilingDeg = TRACE_CEILING_DEG }: TraceOptions = {}): TraceBar[] {
  const ceiling = ceilingDeg > 0 ? ceilingDeg : TRACE_CEILING_DEG;
  const out: TraceBar[] = [];
  for (const mark of slides) {
    const [startFrac, endFrac, deg] = mark;
    const x0 = Math.min(1, Math.max(0, startFrac));
    const x1 = Math.min(1, Math.max(x0, endFrac));
    const held = measured(mark, believed);
    // `Math.max(0.06, …)` only for a slide that DOES have an angle: a two-degree flick still has
    // to be visible. A footprint has no height at all, ever.
    const height = held ? Math.min(1, Math.max(0.06, (Number.isFinite(deg) ? deg : 0) / ceiling)) : 0;
    out.push({ x0, x1, height, kind: held ? 'held' : 'footprint' });
  }
  return out;
}

/** How many marks in this run stand for an angle the app will state. */
export function measuredCount(slides: readonly SlideMark[], believed = true): number {
  let n = 0;
  for (const mark of slides) if (measured(mark, believed)) n++;
  return n;
}

/** Plot height in dp with an axis to draw on, and without one. */
export const TRACE_HEIGHT_DP = 58;
export const TRACE_STRIP_DP = 30;

/**
 * The gutter under the axis, in dp: the band where footprints are drawn and where nothing has a
 * height. Shared with the card, which puts a named, invisible box over everything ABOVE it — so
 * a harness check can say "no footprint ink on the axis" and mean the axis (see `SessionCards`).
 */
export const TRACE_GUTTER_DP = 8;

/**
 * How tall the plot should be. A run with nothing on the axis gets a STRIP rather than a plot:
 * drawing 58 dp of empty scale over a row of footprints is a graph of nothing, and the card has
 * better uses for the space than headroom no mark can reach.
 */
export function traceHeight(slides: readonly SlideMark[], options: TraceOptions = {}): number {
  return measuredCount(slides, options.believed ?? true) > 0 ? TRACE_HEIGHT_DP : TRACE_STRIP_DP;
}

/** The two lines over the plot: what the picture is, and what its axis is. */
export interface TraceLegend {
  left: string;
  right: string;
  /** True when the right-hand line is a warning rather than an axis. */
  alarm: boolean;
}

/**
 * The caption, which must never call a mark a held angle when it is not one.
 *
 * So the ceiling is quoted only when there is something on the axis to measure against it, a run
 * that was not believed is captioned as the recording it is, and a run whose every slide was a
 * spin says so rather than heading an empty axis "held angle".
 */
export function traceLegend(slides: readonly SlideMark[], { believed = true, ceilingDeg = TRACE_CEILING_DEG }: TraceOptions = {}): TraceLegend {
  if (slides.length === 0) return { left: 'Nothing slid', right: 'Grip all the way', alarm: false };
  if (!believed) return { left: 'Recorded sliding', right: 'None of it believed', alarm: true };
  const spins = slides.length - measuredCount(slides, true);
  if (spins === slides.length) return { left: 'Recorded sliding', right: spins === 1 ? 'Spun · no angle held' : `${spins} spun · no angle held`, alarm: true };
  const top = `${Math.round(ceilingDeg)}° top`;
  return { left: 'Held angle through the run', right: spins > 0 ? `${top} · ${spins} spun` : top, alarm: false };
}
