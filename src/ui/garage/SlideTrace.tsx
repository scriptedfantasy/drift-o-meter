/**
 * The shape of a night: every slide of one run, laid out on the run's own clock, height by the
 * angle the driver HELD through it.
 *
 * This is the home screen's only gauge, and it exists because the home screen had no Skia on it
 * at all (`canvas:0` on all nine garage and settings routes) against a design language that
 * specifies "gauges drawn with Skia (arcs, ticks, glows), never stock components" — the
 * last-run card was 353×294 px spent on a static letter, a number and three lines of text.
 *
 * It draws nothing it was not given, and it decides nothing either: `trace.ts` turns the run's
 * `SlideMark`s into geometry, this file turns geometry into pixels. The rule it is drawing is
 * written there — a mark has a height only when the app will state the angle it stands for, and
 * a spin (or any slide in a run the monitor did not believe) becomes a FOOTPRINT in the gutter
 * under the axis: where the car was sideways, for how long, and no angle claimed.
 *
 * Imports Skia directly, so on web it must only ever be reached through `SlideTraceView`
 * (see `src/ui/skia/GlowRingView.web.tsx` for why: `@shopify/react-native-skia` binds
 * `global.CanvasKit` at module evaluation, so it cannot be in a route's import graph).
 */
import { BlurMask, Canvas, Group, LinearGradient, Path, Skia, vec } from '@shopify/react-native-skia';
import { useMemo } from 'react';

import type { SlideMark } from '../../platform';
import { colors, rgba } from '../theme';
import { traceBars, traceHeight, TRACE_CEILING_DEG, TRACE_GUTTER_DP } from './trace';

export interface SlideTraceProps {
  slides: readonly SlideMark[];
  /** Canvas width in dp. */
  width: number;
  /** Canvas height in dp. Defaults to `traceHeight` — a plot with an axis, a strip without. */
  height?: number;
  /** Ridge colour for the slides that counted. */
  color?: string;
  /**
   * False when the integrity monitor did not believe this run's sliding. Then NOTHING is drawn
   * on the axis: the slides happened, and the app may not present any of them as angles.
   */
  believed?: boolean;
  /** Degrees at the top of the plot. A ridge is clamped, never rescaled past it. */
  ceilingDeg?: number;
  testID?: string;
}

/** One ridge: a slide rises, holds and is driven out of. */
function ridge(b: ReturnType<typeof Skia.PathBuilder.Make>, x0: number, x1: number, base: number, top: number): void {
  const w = Math.max(3, x1 - x0);
  const a = x0;
  const c = x0 + w;
  const shoulder = Math.min(w * 0.42, 14);
  b.moveTo(a, base);
  b.cubicTo(a + shoulder * 0.55, base, a + shoulder * 0.45, top, a + shoulder, top);
  b.lineTo(c - shoulder, top);
  b.cubicTo(c - shoulder * 0.45, top, c - shoulder * 0.55, base, c, base);
}

export default function SlideTrace({ slides, width, height, color = colors.ember, believed = true, ceilingDeg = TRACE_CEILING_DEG, testID }: SlideTraceProps) {
  const plot = height ?? traceHeight(slides, { believed });
  const base = plot - TRACE_GUTTER_DP;
  const headroom = base - 6;
  // The gutter: everything the app will not put a number on lives BELOW the axis, where it
  // cannot be read as a height on it.
  const foot = base + 5;

  const { kept, marks, grid } = useMemo(() => {
    const keptB = Skia.PathBuilder.Make();
    const markB = Skia.PathBuilder.Make();
    const gridB = Skia.PathBuilder.Make();
    const bars = traceBars(slides, { believed, ceilingDeg });
    // A single hairline at half the ceiling, so a ridge has something to be tall against — and
    // only when something is ON the axis. A scale over a row of footprints is a scale for
    // nothing, and it reads as a plot whose marks all came out at zero.
    if (bars.some((b) => b.kind === 'held')) gridB.moveTo(0, base - headroom * 0.5).lineTo(width, base - headroom * 0.5);
    gridB.moveTo(0, base).lineTo(width, base);
    for (const bar of bars) {
      const x0 = bar.x0 * width;
      const x1 = bar.x1 * width;
      if (bar.kind === 'held') {
        ridge(keptB, x0, x1, base, base - bar.height * headroom);
      } else {
        markB.moveTo(x0, foot).lineTo(Math.max(x0 + 3, x1), foot);
      }
    }
    return { kept: keptB.detach(), marks: markB.detach(), grid: gridB.detach() };
  }, [slides, width, base, headroom, foot, ceilingDeg, believed]);

  return (
    <Canvas style={{ width, height: plot }} testID={testID}>
      <Path path={grid} color={rgba(colors.text, 0.14)} style="stroke" strokeWidth={1} />
      {/* the halo first, so the ridge sits in its own light */}
      <Group opacity={0.55}>
        <Path path={kept} color={color} style="stroke" strokeWidth={5}>
          <BlurMask blur={9} style="normal" />
        </Path>
      </Group>
      <Path path={kept} style="fill">
        <LinearGradient start={vec(0, 0)} end={vec(0, base)} colors={[rgba(color, 0.55), rgba(color, 0.06)]} />
      </Path>
      <Path path={kept} color={color} style="stroke" strokeWidth={2} strokeJoin="round" strokeCap="round" />
      {/* the footprints, in the gutter: a slide that happened, with no angle claimed for it */}
      <Path path={marks} color={rgba(colors.red, 0.9)} style="stroke" strokeWidth={4} strokeCap="round" />
    </Canvas>
  );
}
