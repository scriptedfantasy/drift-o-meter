/**
 * The slip-angle gauge: a wide arc tachometer for signed β, with the hero numeral inside it.
 *
 * Straight up is 0°, the needle sweeps LEFT for a left-hand slide (β < 0) and RIGHT for a
 * right-hand one, ticks every 10°, and a ghost tick holds the peak of the drift in progress.
 * The arc fills out from the centre, blooms ember with |β| and shifts toward gold past 40°.
 *
 * Nothing here re-renders: every moving part is a Reanimated shared value written by the sample
 * callback (see `useDriveRun`) and read on the UI thread — including the numeral's TEXT, which
 * Skia draws from the same shared value, so the biggest number on the screen updates at display
 * rate without React knowing about it.
 *
 * Imports Skia directly, so on web it must only ever be loaded through `AngleGaugeView`.
 */
import { BlurMask, Canvas, Circle, Group, Path, RadialGradient, Skia, type SkFont, Text as SkText, useFont, vec } from '@shopify/react-native-skia';
import { useMemo } from 'react';
import { interpolateColor, useDerivedValue } from 'react-native-reanimated';

import { colors, rgba } from '../theme';
import type { HudSignals } from './signals';

/** Half the angular width of the arc on screen, degrees (0 = straight up). */
const HALF_SWEEP = 78;
/**
 * |β| at the ends of the arc. A rigid, well-driven run peaks around 50–60°; 90° left the outer
 * third of the dial as dead travel, so the scale ends where a slide ends and anything past it
 * (a spin) pins the needle, which is the correct reading of a spin.
 */
const MAX_BETA = 70;
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
  const cy = height * 0.92;
  const r = Math.min(width * 0.47, height * 0.86);
  const stroke = Math.max(10, r * 0.085);
  // Sized so a two-digit numeral plus its degree sign stays inside the bowl: the block is
  // ~1.2 em wide either side of the centre, and the arc is only r·cos(asin(x/r)) high there.
  const numeralSize = r * 0.7;
  /** Cap height is ~0.72 em: this centres the numeral in the bowl rather than on its baseline. */
  const numeralMidY = cy - r * 0.5;
  const baselineY = numeralMidY + numeralSize * 0.35;

  const font = useFont(NUMERAL_FONT, numeralSize);
  const labelFont = useFont(LABEL_FONT, Math.max(12, Math.round(numeralSize * 0.26)));

  /**
   * Measured once per font: a digit's advance, the degree sign's advance, the side letter's half
   * width. `getTextWidth` (not `measureText`, which CanvasKit's RN-Web shim does not implement)
   * gives the ADVANCE, which is what a layout needs; Barlow Condensed's digits are tabular, so
   * one measurement covers all ten. The worklets below only multiply these numbers, so the hero
   * numeral is laid out on the UI thread without touching the font again.
   *
   * The degree sign is part of the numeral STRING rather than a second text node: placing it by
   * advance left it visibly detached after a narrow glyph like "1". Skia sets it where the
   * typeface says it goes.
   */
  const metrics = useMemo(() => {
    const width = (f: SkFont | null, text: string, fallback: number) => {
      if (!f) return fallback;
      try {
        const w = f.getTextWidth(text);
        return Number.isFinite(w) && w > 0 ? w : fallback;
      } catch {
        return fallback;
      }
    };
    const advance = width(font, '0', numeralSize * 0.5);
    const deg = width(font, '\u00B0', numeralSize * 0.3);
    const letterHalf = width(labelFont, 'R', numeralSize * 0.12) / 2;
    return { advance, deg, letterHalf };
  }, [font, labelFont, numeralSize]);

  /** Distance from the centre to the L/R chevron, wide enough to clear a two-digit numeral. */
  const chevronOffset = metrics.advance + metrics.deg * 0.5 + numeralSize * 0.14;

  const rect = useMemo(() => ({ x: cx - r, y: cy - r, width: 2 * r, height: 2 * r }), [cx, cy, r]);

  /** The face, drawn clockwise from the left end; t = 0.5 is straight up (β = 0). */
  const arc = useMemo(() => Skia.PathBuilder.Make().addArc(rect, -90 - HALF_SWEEP, 2 * HALF_SWEEP).detach(), [rect]);

  const ticks = useMemo(() => {
    const b = Skia.PathBuilder.Make();
    for (let d = -MAX_BETA; d <= MAX_BETA; d += 10) {
      const major = d % 30 === 0;
      const a = (d / MAX_BETA) * HALF_SWEEP * DEG - Math.PI / 2;
      const outer = r - stroke * 1.2;
      const inner = outer - (major ? stroke * 1.05 : stroke * 0.5);
      b.moveTo(cx + Math.cos(a) * inner, cy + Math.sin(a) * inner).lineTo(cx + Math.cos(a) * outer, cy + Math.sin(a) * outer);
    }
    return b.detach();
  }, [cx, cy, r, stroke]);

  /**
   * The needle lives in the outer ring ONLY (0.80 r → the arc). The numeral block reaches
   * 0.75 r, so at small angles a longer needle was drawn straight through the number exactly
   * when the driver is reading it to decide whether the car has taken a set.
   */
  const needle = useMemo(() => {
    const tip = r - stroke * 0.95;
    const base = r * 0.8;
    const halfBase = Math.max(4.5, r * 0.042);
    const halfTip = Math.max(2, r * 0.012);
    return Skia.PathBuilder.Make()
      .moveTo(cx - halfBase, cy - base)
      .lineTo(cx - halfTip, cy - tip)
      .lineTo(cx + halfTip, cy - tip)
      .lineTo(cx + halfBase, cy - base)
      .close()
      .detach();
  }, [cx, cy, r, stroke]);

  /** One bar across the arc at 12 o'clock, rotated to the peak angle. */
  const ghost = useMemo(() => {
    const outer = r - stroke * 0.1;
    const inner = r - stroke * 2.6;
    const half = Math.max(1.5, r * 0.0085);
    return Skia.PathBuilder.Make()
      .moveTo(cx - half, cy - inner)
      .lineTo(cx - half, cy - outer)
      .lineTo(cx + half, cy - outer)
      .lineTo(cx + half, cy - inner)
      .close()
      .detach();
  }, [cx, cy, r, stroke]);

  /** Two stacked chevrons pointing away from the centre, drawn around (0, 0). */
  const chevron = useMemo(() => {
    const s = numeralSize * 0.125;
    const b = Skia.PathBuilder.Make();
    for (let i = 0; i < 2; i++) {
      const x = i * s * 0.8;
      b.moveTo(x - s * 0.34, -s)
        .lineTo(x + s * 0.3, 0)
        .lineTo(x - s * 0.34, s)
        .lineTo(x - s * 0.02, s)
        .lineTo(x + s * 0.62, 0)
        .lineTo(x - s * 0.02, -s)
        .close();
    }
    return b.detach();
  }, [numeralSize]);

  // ── everything below moves on the UI thread ────────────────────────────────────────
  const clamped = useDerivedValue(() => Math.max(-MAX_BETA, Math.min(MAX_BETA, signals.betaDeg.value)));
  const fillStart = useDerivedValue(() => Math.min(0.5, 0.5 + clamped.value / (2 * MAX_BETA)));
  const fillEnd = useDerivedValue(() => Math.max(0.5, 0.5 + clamped.value / (2 * MAX_BETA)));
  const needleTransform = useDerivedValue(() => [{ rotate: (clamped.value / MAX_BETA) * HALF_SWEEP * DEG }]);
  const peakTransform = useDerivedValue(() => [{ rotate: (Math.max(-MAX_BETA, Math.min(MAX_BETA, signals.peakDeg.value)) / MAX_BETA) * HALF_SWEEP * DEG }]);
  const peakOpacity = useDerivedValue(() => (Math.abs(signals.peakDeg.value) > 8 ? 0.9 : 0));
  // Ember through 34°, shifting to gold from 40° and fully gold by 55° — the design's promise,
  // on the range a real slide actually uses. An untrusted reading is drawn in muted grey
  // instead: the engine is not scoring it, so the dial does not celebrate it.
  const hot = useDerivedValue(() =>
    signals.trust.value <= 0
      ? colors.muted
      : interpolateColor(signals.absDeg.value, [0, 34, 40, 55], [colors.ember, colors.ember, colors.ember, colors.gold]),
  );
  const glowOpacity = useDerivedValue(() => (0.22 + 0.68 * signals.intensity.value) * signals.trust.value);
  const bowlOpacity = useDerivedValue(() => (0.12 + 0.5 * signals.intensity.value) * signals.trust.value);
  const dimmed = useDerivedValue(() => 0.45 + 0.35 * signals.valid.value + 0.2 * signals.trust.value);

  const digits = useDerivedValue(() => String(Math.round(Math.min(99, signals.absDeg.value))));
  const numeral = useDerivedValue(() => digits.value + '\u00B0');
  const blockLeft = useDerivedValue(() => cx - (digits.value.length * metrics.advance + metrics.deg) / 2);
  const numeralScale = useDerivedValue(() => [{ scale: 1 + 0.08 * signals.punch.value }]);
  const chevronTransform = useDerivedValue(() => [
    { translateX: cx + signals.side.value * chevronOffset },
    { translateY: numeralMidY },
    { scaleX: signals.side.value },
  ]);
  const letterX = useDerivedValue(() => cx + signals.side.value * chevronOffset - metrics.letterHalf);
  const sideLetter = useDerivedValue(() => (signals.side.value < 0 ? 'L' : 'R'));

  const numeralOrigin = useMemo(() => vec(cx, numeralMidY), [cx, numeralMidY]);

  return (
    <Canvas style={{ width, height }} testID={testID}>
      {/* the bowl: ember light pooling inside the arc */}
      <Circle cx={cx} cy={cy} r={r * 0.99} opacity={bowlOpacity}>
        <RadialGradient c={vec(cx, cy)} r={r} colors={[rgba(colors.ember, 0.34), rgba(colors.ember, 0.11), rgba(colors.ember, 0)]} positions={[0, 0.5, 1]} />
      </Circle>

      {/* dark track + ticks */}
      <Path path={arc} color={rgba(colors.line, 0.95)} style="stroke" strokeWidth={stroke} strokeCap="butt" />
      <Path path={arc} color={rgba(colors.text, 0.13)} style="stroke" strokeWidth={1} strokeCap="butt" />
      <Path path={ticks} color={rgba(colors.text, 0.42)} style="stroke" strokeWidth={Math.max(1.5, r * 0.0085)} />


      {/* ghost tick: the peak of the drift in progress */}
      <Group origin={vec(cx, cy)} transform={peakTransform} opacity={peakOpacity}>
        <Path path={ghost} color={colors.gold}>
          <BlurMask blur={4} style="solid" />
        </Path>
      </Group>

      {/* the live arc, blooming out of the centre */}
      <Group opacity={glowOpacity}>
        <Path path={arc} color={hot} style="stroke" strokeWidth={stroke * 2.1} strokeCap="round" start={fillStart} end={fillEnd}>
          <BlurMask blur={stroke * 1.35} style="normal" />
        </Path>
      </Group>
      <Group opacity={dimmed}>
        <Path path={arc} color={hot} style="stroke" strokeWidth={stroke} strokeCap="butt" start={fillStart} end={fillEnd} />
        <Path path={arc} color={rgba('#FFFFFF', 0.45)} style="stroke" strokeWidth={stroke * 0.2} strokeCap="butt" start={fillStart} end={fillEnd} />

        {/* needle */}
        <Group origin={vec(cx, cy)} transform={needleTransform}>
          <Path path={needle} color={hot} opacity={0.95}>
            <BlurMask blur={7} style="solid" />
          </Path>
          <Path path={needle} color={rgba('#FFFFFF', 0.9)} />
        </Group>
        <Circle cx={cx} cy={cy} r={Math.max(4, r * 0.026)} color={colors.bg0} />
        <Circle cx={cx} cy={cy} r={Math.max(4, r * 0.026)} color={hot} style="stroke" strokeWidth={1.5} />
      </Group>

      {/* the hero numeral */}
      {font ? (
        <Group origin={numeralOrigin} transform={numeralScale} opacity={dimmed}>
          <Group opacity={0.5}>
            <SkText x={blockLeft} y={baselineY} text={numeral} font={font} color={hot}>
              <BlurMask blur={20} style="normal" />
            </SkText>
          </Group>
          <SkText x={blockLeft} y={baselineY} text={numeral} font={font} color={hot} />
          <Group transform={chevronTransform}>
            <Path path={chevron} color={hot} opacity={0.95} />
          </Group>
          {labelFont ? <SkText x={letterX} y={baselineY} text={sideLetter} font={labelFont} color={hot} opacity={0.95} /> : null}
        </Group>
      ) : null}
    </Canvas>
  );
}
