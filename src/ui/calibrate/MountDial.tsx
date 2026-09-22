/**
 * The calibration dial: how the phone is sitting, and how much the engine believes it — one
 * object, because they are one question.
 *
 * Outside: a 270° confidence arc with a hard tick at the bar the judge actually uses, so the
 * number is never floating free of what it has to clear. Inside: an attitude indicator. The
 * horizon is the world, the phone is drawn as it is really hanging in the car — rolled by the
 * in-plane direction of gravity, foreshortened by how far it is reclined out of the screen
 * plane — so a phone face-up on a seat collapses to a sliver and a phone in a vent clip stands
 * up straight. Every number in here comes from the gravity vector and the calibrator; nothing
 * is decorative.
 *
 * Imports Skia directly: on web it must only ever be reached through `MountDialView`.
 */
import { BlurMask, Canvas, Circle, Group, Path, RoundedRect, Skia, vec } from '@shopify/react-native-skia';
import { useMemo } from 'react';

import { colors, rgba } from '../theme';

export interface MountDialProps {
  /** Square canvas size in dp. */
  size: number;
  /** In-plane rotation of the phone, degrees (0 upright, +90 = right edge down). */
  rollDeg: number;
  /** Tilt out of the screen plane, degrees (0 standing up, +90 face-up flat). */
  reclineDeg: number;
  /** Calibration confidence, 0..1. */
  quality: number;
  /** Where the judge's bar sits on that arc, 0..1. */
  threshold: number;
  /**
   * A second, softer mark: above it the results screen stops qualifying the score. REQUIRED —
   * it used to default to 0.75 here, which made this file a third copy of a threshold that
   * three screens already disagreed about. One owner (`SHARP_QUALITY` in `model.ts`), passed in.
   */
  sharp: number;
  /**
   * Arc colour, taken from the same band the words use so the two never disagree. A `theme.ts`
   * token: `blue` while the engine is still working, `green` past its bar, `greenHot` a
   * caution, `red` a stop.
   */
  tone?: 'blue' | 'green' | 'greenHot' | 'red';
  /** The vertical has settled — the horizon locks and brightens. */
  settled?: boolean;
  /** The forward axis is resolved: the dial gains its fore/aft axis. */
  resolved?: boolean;
  /** The phone is moving against the car. Everything goes red. */
  loose?: boolean;
  /** The calibration clears the bar: the judge's tick lights up. */
  ready?: boolean;
  /** No readings at all yet. */
  idle?: boolean;
  testID?: string;
}

const START_DEG = 135;
const SWEEP_DEG = 270;
const TICKS = 24;
const DEG = Math.PI / 180;

export default function MountDial({
  size,
  rollDeg,
  reclineDeg,
  quality,
  threshold,
  sharp,
  tone = 'blue',
  settled = false,
  resolved = false,
  loose = false,
  ready = false,
  idle = false,
  testID,
}: MountDialProps) {
  const stroke = Math.max(6, size * 0.042);
  const c = size / 2;
  const arcR = c - stroke * 2;
  const faceR = arcR - stroke * 2.1;
  const pct = clamp01(quality);
  const arcColor = colors[tone];
  const faceColor = loose ? colors.red : settled ? colors.blue : colors.muted;

  const rect = useMemo(() => ({ x: c - arcR, y: c - arcR, width: 2 * arcR, height: 2 * arcR }), [c, arcR]);

  const track = useMemo(() => Skia.PathBuilder.Make().addArc(rect, START_DEG, SWEEP_DEG).detach(), [rect]);
  const arc = useMemo(() => {
    const b = Skia.PathBuilder.Make();
    if (pct > 0.004) b.addArc(rect, START_DEG, SWEEP_DEG * pct);
    return b.detach();
  }, [rect, pct]);

  const ticks = useMemo(() => {
    const b = Skia.PathBuilder.Make();
    for (let i = 0; i <= TICKS; i++) {
      const a = (START_DEG + (SWEEP_DEG * i) / TICKS) * DEG;
      const major = i % 4 === 0;
      const outer = arcR - stroke * 1.05;
      const inner = outer - (major ? stroke * 0.85 : stroke * 0.42);
      b.moveTo(c + Math.cos(a) * inner, c + Math.sin(a) * inner).lineTo(c + Math.cos(a) * outer, c + Math.sin(a) * outer);
    }
    return b.detach();
  }, [c, arcR, stroke]);

  /** The bar the engine uses: one hard tick straight through the arc. */
  const barMark = useMemo(() => mark(c, arcR, stroke, clamp01(threshold), 2.0), [c, arcR, stroke, threshold]);
  /** The softer one: above it the results screen stops qualifying the score. */
  const sharpMark = useMemo(() => mark(c, arcR, stroke, clamp01(sharp), 1.25), [c, arcR, stroke, sharp]);

  const face = useMemo(() => Skia.PathBuilder.Make().addCircle(c, c, faceR).detach(), [c, faceR]);

  /** Ground below the horizon, clipped to the dial face. */
  const ground = useMemo(() => {
    const b = Skia.PathBuilder.Make();
    b.addRect({ x: c - faceR, y: c, width: 2 * faceR, height: faceR });
    return b.detach();
  }, [c, faceR]);

  const horizon = useMemo(() => {
    const b = Skia.PathBuilder.Make();
    b.moveTo(c - faceR * 0.98, c).lineTo(c + faceR * 0.98, c);
    for (let i = -2; i <= 2; i++) {
      if (i === 0) continue;
      const x = c + (faceR * 0.34) * i;
      b.moveTo(x, c - faceR * 0.1).lineTo(x, c + faceR * 0.1);
    }
    return b.detach();
  }, [c, faceR]);

  /** The gravity arrow: always straight down, because that is where down is. Sits clear of the
   * phone, in the bottom of the face, so it annotates the glyph instead of crossing it. */
  const arrow = useMemo(() => {
    const b = Skia.PathBuilder.Make();
    const top = c + faceR * 0.62;
    const tip = c + faceR * 0.9;
    b.moveTo(c, top).lineTo(c, tip);
    b.moveTo(c - faceR * 0.07, tip - faceR * 0.1).lineTo(c, tip).lineTo(c + faceR * 0.07, tip - faceR * 0.1);
    return b.detach();
  }, [c, faceR]);

  /** The fore/aft axis the calibrator resolved, drawn across the phone once it has it. */
  const foreAft = useMemo(() => {
    const b = Skia.PathBuilder.Make();
    const r = faceR * 0.74;
    b.moveTo(c - r, c).lineTo(c + r, c);
    return b.detach();
  }, [c, faceR]);

  const phoneW = faceR * 0.52;
  const phoneH = faceR * 0.9;
  const squash = Math.max(0.06, Math.cos(clampDeg(reclineDeg) * DEG));
  const roll = clampDeg(rollDeg) * DEG;
  const body = useMemo(
    () => [{ rotate: roll }, { scaleY: squash }],
    [roll, squash],
  );

  return (
    <Canvas style={{ width: size, height: size }} testID={testID}>
      {/* halo behind the earned arc */}
      {pct > 0.02 ? (
        <Path path={arc} color={arcColor} style="stroke" strokeWidth={stroke * 2.1} strokeCap="round" opacity={idle ? 0 : 0.34}>
          <BlurMask blur={stroke * 1.4} style="normal" />
        </Path>
      ) : null}
      <Path path={track} color={colors.line} style="stroke" strokeWidth={stroke} strokeCap="round" />
      <Path path={arc} color={arcColor} style="stroke" strokeWidth={stroke} strokeCap="round" />
      <Path path={arc} color={rgba('#FFFFFF', 0.3)} style="stroke" strokeWidth={stroke * 0.26} strokeCap="round" />
      <Path path={ticks} color={rgba(colors.text, 0.28)} style="stroke" strokeWidth={1.4} />
      <Path path={sharpMark} color={rgba(colors.text, 0.3)} style="stroke" strokeWidth={2} strokeCap="square" />
      <Path path={barMark} color={ready ? colors.green : colors.text} style="stroke" strokeWidth={2.6} strokeCap="square" />

      {/* the dial face: the world, with the phone hanging in it */}
      <Circle cx={c} cy={c} r={faceR} color={colors.bg1} />
      <Group clip={face}>
        <Path path={ground} color={rgba(faceColor, settled ? 0.16 : 0.07)} />
        <Path path={horizon} color={rgba(faceColor, settled ? 0.75 : 0.32)} style="stroke" strokeWidth={1.6} />
        {resolved ? <Path path={foreAft} color={rgba(colors.green, 0.5)} style="stroke" strokeWidth={1.4} /> : null}
      </Group>
      <Circle cx={c} cy={c} r={faceR} color={rgba(colors.line, 1)} style="stroke" strokeWidth={1.2} />

      {/* the phone, as it is really sitting */}
      <Group origin={vec(c, c)} transform={body}>
        <RoundedRect
          x={c - phoneW / 2}
          y={c - phoneH / 2}
          width={phoneW}
          height={phoneH}
          r={phoneW * 0.16}
          color={rgba(faceColor, 0.16)}
        />
        <RoundedRect
          x={c - phoneW / 2}
          y={c - phoneH / 2}
          width={phoneW}
          height={phoneH}
          r={phoneW * 0.16}
          color={faceColor}
          style="stroke"
          strokeWidth={Math.max(2, size * 0.011)}
        />
        <RoundedRect x={c - phoneW * 0.16} y={c - phoneH / 2 + phoneH * 0.055} width={phoneW * 0.32} height={Math.max(2, phoneH * 0.022)} r={2} color={rgba(faceColor, 0.85)} />
      </Group>

      <Path path={arrow} color={rgba(colors.text, 0.42)} style="stroke" strokeWidth={1.8} strokeCap="round" strokeJoin="round" />
    </Canvas>
  );
}

/** One radial tick across the arc at `f` (0..1 of the sweep). */
function mark(c: number, arcR: number, stroke: number, f: number, len: number) {
  const a = (START_DEG + SWEEP_DEG * f) * DEG;
  const inner = arcR - stroke * 0.62;
  const outer = arcR + stroke * (len - 0.62);
  return Skia.PathBuilder.Make()
    .moveTo(c + Math.cos(a) * inner, c + Math.sin(a) * inner)
    .lineTo(c + Math.cos(a) * outer, c + Math.sin(a) * outer)
    .detach();
}

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
}

function clampDeg(v: number): number {
  return Number.isFinite(v) ? Math.max(-180, Math.min(180, v)) : 0;
}
