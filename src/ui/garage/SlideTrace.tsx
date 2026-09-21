/**
 * The shape of a night: every slide of one run, laid out on the run's own clock, height by the
 * angle the driver HELD through it.
 *
 * This is the home screen's only gauge, and it exists because the home screen had no Skia on it
 * at all (`canvas:0` on all nine garage and settings routes) against a design language that
 * specifies "gauges drawn with Skia (arcs, ticks, glows), never stock components" — the
 * last-run card was 353×294 px spent on a static letter, a number and three lines of text.
 *
 * It draws nothing it was not given. Each ridge is one `SlideMark` from the session index:
 * start and end as a fraction of the recording, the held angle in degrees, and whether it ended
 * in a spin. A spun slide is drawn in red and hollow — it is a slide that happened, and it is
 * not an angle anybody held, which is the same distinction the scorer makes.
 *
 * Imports Skia directly, so on web it must only ever be reached through `SlideTraceView`
 * (see `src/ui/skia/GlowRingView.web.tsx` for why: `@shopify/react-native-skia` binds
 * `global.CanvasKit` at module evaluation, so it cannot be in a route's import graph).
 */
import { BlurMask, Canvas, Group, LinearGradient, Path, Skia, vec } from '@shopify/react-native-skia';
import { useMemo } from 'react';

import type { SlideMark } from '../../platform';
import { colors, rgba } from '../theme';
import { TRACE_CEILING_DEG } from './trace';

export interface SlideTraceProps {
  slides: readonly SlideMark[];
  /** Canvas width in dp. */
  width: number;
  /** Canvas height in dp. */
  height?: number;
  /** Ridge colour for the slides that counted. */
  color?: string;
  /**
   * False when the integrity monitor did not believe this run's sliding. Then NOTHING is drawn
   * filled: the slides happened, and the app may not present any of them as angles.
   */
  believed?: boolean;
  /** Degrees at the top of the plot. The ridge is clamped, never rescaled past it. */
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

export default function SlideTrace({ slides, width, height = 58, color = colors.ember, believed = true, ceilingDeg = TRACE_CEILING_DEG, testID }: SlideTraceProps) {
  const base = height - 8;
  const headroom = base - 6;

  const { kept, spun, grid } = useMemo(() => {
    const keptB = Skia.PathBuilder.Make();
    const spunB = Skia.PathBuilder.Make();
    const gridB = Skia.PathBuilder.Make();
    // A single hairline at half the ceiling, so a ridge has something to be tall against.
    gridB.moveTo(0, base - headroom * 0.5).lineTo(width, base - headroom * 0.5);
    gridB.moveTo(0, base).lineTo(width, base);
    for (const [startFrac, endFrac, deg, isSpun] of slides) {
      const x0 = Math.max(0, Math.min(1, startFrac)) * width;
      const x1 = Math.max(x0, Math.min(1, Math.max(startFrac, endFrac)) * width);
      const h = Math.max(0.06, Math.min(1, deg / ceilingDeg)) * headroom;
      ridge(isSpun === 1 || !believed ? spunB : keptB, x0, x1, base, base - h);
    }
    return { kept: keptB.detach(), spun: spunB.detach(), grid: gridB.detach() };
  }, [slides, width, base, headroom, ceilingDeg, believed]);

  return (
    <Canvas style={{ width, height }} testID={testID}>
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
      {/* a spin is drawn, never filled: it happened, and nobody held it */}
      <Path path={spun} color={rgba(colors.red, 0.85)} style="stroke" strokeWidth={2} strokeJoin="round" strokeCap="round" />
    </Canvas>
  );
}
