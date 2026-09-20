/**
 * The slip-angle gauge: a wide arc tachometer for signed β, with the hero numeral inside it.
 *
 * Straight up is 0°, the needle sweeps LEFT for a left-hand slide (β < 0) and RIGHT for a
 * right-hand one, ticks every 10°, and a ghost tick holds the peak of the drift in progress.
 * The arc fills out from the centre, blooms ember with |β| and shifts toward gold past 40°.
 *
 * Nothing here re-renders: every moving part is a Reanimated shared value written by the sample
 * callback (see `useDriveRun`) and read on the UI thread, including the numeral's TEXT — it is
 * drawn by Skia from the same shared value, so the biggest number on the screen updates at
 * display rate without React knowing.
 *
 * Imports Skia directly, so on web it must only ever be loaded through `AngleGaugeView`.
 */
import {
  BlurMask,
  Canvas,
  Circle,
  Group,
  Path,
  RadialGradient,
  Skia,
  Text as SkText,
  useFont,
  vec,
} from '@shopify/react-native-skia';
import { useMemo } from 'react';
import { interpolateColor, useDerivedValue } from 'react-native-reanimated';

import { colors, rgba } from '../theme';
import type { HudSignals } from './signals';

// The face of the gauge, in degrees on screen (0 = straight up, + = clockwise).
const HALF_SWEEP = 62;
/** |β| at the ends of the arc. */
const MAX_BETA = 90;
const DEG = Math.PI / 180;

const NUMERAL_FONT = require('@expo-google-fonts/barlow-condensed/800ExtraBold_Italic/BarlowCondensed_800ExtraBold_Italic.ttf');
const LABEL_FONT = require('@expo-google-fonts/barlow-condensed/700Bold/BarlowCondensed_700Bold.ttf');

export interface AngleGaugeProps {
  width: number;
  height: number;
  signals: HudSignals;
  testID?: string;
}

export default function AngleGauge({ width, height, signals, testID }: AngleGaugeProps) {
  const cx = width / 2;
  const cy = height * 0.96;
  const r = Math.min(width * 0.47, height * 0.82);
  const stroke = Math.max(10, r * 0.075);
  const numeralSize = Math.min(height * 0.46, width * 0.42);

  const font = useFont(NUMERAL_FONT, numeralSize);
  const labelFont = useFont(LABEL_FONT, Math.max(11, Math.round(numeralSize * 0.14)));
  const degFont = useFont(NUMERAL_FONT, numeralSize * 0.44);

  /** Digit advance and the width of "°", measured once: lets the worklet centre the numeral. */
  const metrics = useMemo(() => {
    if (!font || !degFont) return { advance: numeralSize * 0.5, deg: numeralSize * 0.25 };
    const one = font.measureText('0').width;
    const two = font.measureText('00').width;
    const advance = two - one > 1 ? two - one : one;
    return { advance, deg: degFont.measureText('°').width };
  }, [degFont, font, numeralSize]);

  const rect = useMemo(() => ({ x: cx - r, y: cy - r, width: 2 * r, height: 2 * r }), [cx, cy, r]);

  // The arc: from the left end, clockwise to the right end. t = 0.5 is straight up (β = 0).
  const arc = useMemo(() => Skia.PathBuilder.Make().addArc(rect, -90 - HALF_SWEEP, 2 * HALF_SWEEP).detach(), [rect]);

  const ticks = useMemo(() => {
    const b = Skia.PathBuilder.Make();
    for (let d = -MAX_BETA; d <= MAX_BETA; d += 10) {
      const major = d % 30 === 0;
      const a = (d / MAX_BETA) * HALF_SWEEP * DEG - Math.PI / 2;
      const outer = r - stroke * 1.15;
      const inner = outer - (major ? stroke * 1.0 : stroke * 0.5);
      b.moveTo(cx + Math.cos(a) * inner, cy + Math.sin(a) * inner).lineTo(cx + Math.cos(a) * outer, cy + Math.sin(a) * outer);
    }
    return b.detach();
  }, [cx, cy, r, stroke]);

  const needle = useMemo(() => {
    const tip = r - stroke * 2.2;
    const base = r * 0.2;
    const halfBase = Math.max(3.5, r * 0.022);
    const halfTip = Math.max(1.5, r * 0.007);
    return Skia.PathBuilder.Make()
      .moveTo(cx - halfBase, cy - base)
      .lineTo(cx - halfTip, cy - tip)
      .lineTo(cx + halfTip, cy - tip)
      .lineTo(cx + halfBase, cy - base)
      .close()
      .detach();
  }, [cx, cy, r, stroke]);

  /** One tick mark at 12 o'clock; rotated to the peak angle. */
  const ghost = useMemo(() => {
    const outer = r - stroke * 0.25;
    const inner = r - stroke * 2.5;
    const half = Math.max(1.5, r * 0.009);
    return Skia.PathBuilder.Make()
      .moveTo(cx - half, cy - inner)
      .lineTo(cx - half, cy - outer)
      .lineTo(cx + half, cy - outer)
      .lineTo(cx + half, cy - inner)
      .close()
      .detach();
  }, [cx, cy, r, stroke]);

  const chevron = useMemo(() => {
    const s = numeralSize * 0.16;
    const b = Skia.PathBuilder.Make();
    for (let i = 0; i < 2; i++) {
      const x = i * s * 0.78;
      b.moveTo(x, -s).lineTo(x - s * 0.62, 0).lineTo(x, s).lineTo(x + s * 0.28, s * 0.72).lineTo(x - s * 0.2, 0).lineTo(x + s * 0.28, -s * 0.72).close();
    }
    return b.detach();
  }, [numeralSize]);

  // ── animated derivations (UI thread) ────────────────────────────────────────────────
  const clamped = useDerivedValue(() => Math.max(-MAX_BETA, Math.min(MAX_BETA, signals.betaDeg.value)));
  const fillStart = useDerivedValue(() => Math.min(0.5, 0.5 + clamped.value / (2 * MAX_BETA)));
  const fillEnd = useDerivedValue(() => Math.max(0.5, 0.5 + clamped.value / (2 * MAX_BETA)));
  const needleTransform = useDerivedValue(() => [{ rotate: (clamped.value / MAX_BETA) * HALF_SWEEP * DEG }]);
  const peakTransform = useDerivedValue(() => [
    { rotate: (Math.max(-MAX_BETA, Math.min(MAX_BETA, signals.peakDeg.value)) / MAX_BETA) * HALF_SWEEP * DEG },
  ]);
  const peakOpacity = useDerivedValue(() => (Math.abs(signals.peakDeg.value) > 8 ? 0.85 : 0));
  const hot = useDerivedValue(() => interpolateColor(signals.absDeg.value, [0, 26, 40, 62], [colors.ember, colors.ember, colors.ember, colors.gold]));
  const glowOpacity = useDerivedValue(() => 0.25 + 0.6 * signals.intensity.value);
  const bowlOpacity = useDerivedValue(() => 0.1 + 0.5 * signals.intensity.value);

  const numeral = useDerivedValue(() => String(Math.round(Math.min(99, signals.absDeg.value))));
  const numeralWidth = useDerivedValue(() => numeral.value.length * metrics.advance);
  const numeralX = useDerivedValue(() => cx - (numeralWidth.value + metrics.deg) / 2);
  const degX = useDerivedValue(() => cx - (numeralWidth.value + metrics.deg) / 2 + numeralWidth.value + metrics.advance * 0.06);
  const numeralScale = useDerivedValue(() => [{ scale: 1 + 0.08 * signals.punch.value }]);
  const chevronTransform = useDerivedValue(() => [
    { translateX: cx + signals.side.value * (metrics.advance * 1.35 + metrics.deg * 0.9 + numeralSize * 0.3) },
    { translateY: baselineY - numeralSize * 0.34 },
    { scaleX: signals.side.value },
  ]);
  const sideLetter = useDerivedValue(() => (signals.side.value < 0 ? 'L' : 'R'));

  const baselineY = cy - r * 0.26;
  const numeralOrigin = useMemo(() => vec(cx, baselineY - numeralSize * 0.34), [cx, baselineY, numeralSize]);

  return (
    <Canvas style={{ width, height }} testID={testID}>
      {/* the bowl: ember light pooling inside the arc */}
      <Circle cx={cx} cy={cy} r={r * 0.98} opacity={bowlOpacity}>
        <RadialGradient c={vec(cx, cy)} r={r} colors={[rgba(colors.ember, 0.32), rgba(colors.ember, 0.1), rgba(colors.ember, 0)]} positions={[0, 0.55, 1]} />
      </Circle>

      {/* dark track + ticks */}
      <Path path={arc} color={rgba(colors.line, 0.9)} style="stroke" strokeWidth={stroke} strokeCap="butt" />
      <Path path={ticks} color={rgba(colors.text, 0.38)} style="stroke" strokeWidth={Math.max(1.5, r * 0.009)} />

      {/* the ghost tick: peak of the drift in progress */}
      <Group origin={vec(cx, cy)} transform={peakTransform} opacity={peakOpacity}>
        <Path path={ghost} color={colors.gold}>
          <BlurMask blur={3} style="solid" />
        </Path>
      </Group>

      {/* the live arc, blooming out of the centre */}
      <Group opacity={glowOpacity}>
        <Path path={arc} color={hot} style="stroke" strokeWidth={stroke * 2.1} strokeCap="round" start={fillStart} end={fillEnd}>
          <BlurMask blur={stroke * 1.3} style="normal" />
        </Path>
      </Group>
      <Path path={arc} color={hot} style="stroke" strokeWidth={stroke} strokeCap="butt" start={fillStart} end={fillEnd} />
      <Path path={arc} color={rgba('#FFFFFF', 0.5)} style="stroke" strokeWidth={stroke * 0.22} strokeCap="butt" start={fillStart} end={fillEnd} />

      {/* needle */}
      <Group origin={vec(cx, cy)} transform={needleTransform}>
        <Path path={needle} color={hot} opacity={0.9}>
          <BlurMask blur={6} style="solid" />
        </Path>
        <Path path={needle} color={rgba('#FFFFFF', 0.85)} />
      </Group>
      <Circle cx={cx} cy={cy} r={Math.max(5, r * 0.035)} color={colors.bg0} />
      <Circle cx={cx} cy={cy} r={Math.max(5, r * 0.035)} color={hot} style="stroke" strokeWidth={2} />

      {/* the hero numeral */}
      {font && degFont ? (
        <Group origin={numeralOrigin} transform={numeralScale}>
          <Group opacity={0.55}>
            <SkText x={numeralX} y={baselineY} text={numeral} font={font} color={hot}>
              <BlurMask blur={18} style="normal" />
            </SkText>
          </Group>
          <SkText x={numeralX} y={baselineY} text={numeral} font={font} color={hot} />
          <SkText x={degX} y={baselineY - numeralSize * 0.42} text="°" font={degFont} color={hot} opacity={0.85} />
          <Group transform={chevronTransform}>
            <Path path={chevron} color={hot} opacity={0.9} />
          </Group>
          {labelFont ? <SkText x={cx + 0} y={baselineY} text="" font={labelFont} color={colors.muted} /> : null}
        </Group>
      ) : null}

      {/* side letter under the chevron */}
      {labelFont ? (
        <Group>
          <SkText
            x={useDerivedValue(() => cx + signals.side.value * (metrics.advance * 1.35 + metrics.deg * 0.9 + numeralSize * 0.3) - labelFont.measureText('R').width * 0.5)}
            y={baselineY}
            text={sideLetter}
            font={labelFont}
            color={hot}
          />
        </Group>
      ) : null}
    </Canvas>
  );
}
