/**
 * A glowing gauge ring: the visual root of the HUD's slip-angle dial. Ember arc on a dark
 * track, a soft halo that breathes, tick marks, and a cyan sweep that circles like a radar.
 *
 * Imports Skia directly, so on web it must only ever be loaded through `GlowRingView`.
 */
import { BlurMask, Canvas, Circle, Group, Path, Skia, SweepGradient, useClock, vec } from '@shopify/react-native-skia';
import { useMemo } from 'react';
import { useDerivedValue } from 'react-native-reanimated';

import { colors, rgba } from '../theme';

export interface GlowRingProps {
  /** Canvas size in dp (square). */
  size: number;
  /** Arc fill, 0..1. */
  progress?: number;
  color?: string;
  accent?: string;
  /** Breathe the halo and spin the sweep. */
  animated?: boolean;
  testID?: string;
}

const START_DEG = 135;
const SWEEP_DEG = 270;
const TICKS = 27;

export default function GlowRing({ size, progress = 0.72, color = colors.ember, accent = colors.cyan, animated = true, testID }: GlowRingProps) {
  const stroke = Math.max(6, size * 0.045);
  const c = size / 2;
  const r = c - stroke * 2.4;
  const pct = Math.max(0, Math.min(1, Number.isFinite(progress) ? progress : 0));

  const clock = useClock();
  const sweep = useDerivedValue(() => [{ rotate: animated ? (clock.value / 3200) * Math.PI * 2 : 0 }]);
  const haloOpacity = useDerivedValue(() => (animated ? 0.3 + 0.16 * (0.5 + 0.5 * Math.sin(clock.value / 650)) : 0.38));

  const rect = useMemo(() => ({ x: c - r, y: c - r, width: 2 * r, height: 2 * r }), [c, r]);

  // Skia 2.x: build paths with PathBuilder (the mutable SkPath.addArc/moveTo/lineTo are deprecated).
  const track = useMemo(() => Skia.PathBuilder.Make().addArc(rect, START_DEG, SWEEP_DEG).detach(), [rect]);

  const arc = useMemo(() => {
    const b = Skia.PathBuilder.Make();
    if (pct > 0) b.addArc(rect, START_DEG, SWEEP_DEG * pct);
    return b.detach();
  }, [rect, pct]);

  const ticks = useMemo(() => {
    const b = Skia.PathBuilder.Make();
    for (let i = 0; i <= TICKS; i++) {
      const a = ((START_DEG + (SWEEP_DEG * i) / TICKS) * Math.PI) / 180;
      const major = i % 3 === 0;
      const outer = r - stroke * 1.2;
      const inner = outer - (major ? stroke * 0.9 : stroke * 0.45);
      b.moveTo(c + Math.cos(a) * inner, c + Math.sin(a) * inner).lineTo(c + Math.cos(a) * outer, c + Math.sin(a) * outer);
    }
    return b.detach();
  }, [c, r, stroke]);

  return (
    <Canvas style={{ width: size, height: size }} testID={testID}>
      {/* halo */}
      <Circle cx={c} cy={c} r={r} color={color} style="stroke" strokeWidth={stroke * 2.2} opacity={haloOpacity}>
        <BlurMask blur={stroke * 1.5} style="normal" />
      </Circle>
      {/* dark track */}
      <Path path={track} color={colors.line} style="stroke" strokeWidth={stroke} strokeCap="round" />
      {/* ember fill */}
      <Path path={arc} color={color} style="stroke" strokeWidth={stroke} strokeCap="round" />
      {/* hot core on the fill */}
      <Path path={arc} color={rgba('#FFFFFF', 0.35)} style="stroke" strokeWidth={stroke * 0.28} strokeCap="round" />
      {/* ticks */}
      <Path path={ticks} color={rgba(colors.text, 0.32)} style="stroke" strokeWidth={1.5} />
      {/* radar sweep */}
      <Group origin={vec(c, c)} transform={sweep}>
        <Circle cx={c} cy={c} r={r + stroke * 1.35} style="stroke" strokeWidth={2}>
          <SweepGradient c={vec(c, c)} colors={[rgba(accent, 0), rgba(accent, 0), accent]} positions={[0, 0.78, 1]} />
        </Circle>
      </Group>
    </Canvas>
  );
}
