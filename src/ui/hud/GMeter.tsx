/**
 * The g-meter: a friction circle with the acceleration vector drawn out of the middle.
 *
 * Right is a right-hand acceleration, up is throttle, down is brake — the vector is WHERE THE
 * CAR IS BEING PUSHED, not where the driver is being thrown. That is the same convention the
 * gauge above it uses (a right-hand slide sweeps the needle right), and on a screen with two
 * instruments they have to agree about which way right is or neither can be read at a glance.
 *
 * IT IS A VECTOR AND NOT A LOOSE BALL. A dot alone reads as a spirit level — something floating
 * in a bowl — and the first build of this looked like a radar screen for that reason. A line
 * anchored at zero and growing to the dot says the two things a bare dot only implies: that the
 * middle is no acceleration, and that what is being shown has a direction and a size.
 *
 * There is no text on it. The length of the vector IS the magnitude; a number beside it would be
 * the same fact drawn twice, which is why the gauge's "R" came off from beside a chevron already
 * pointing right.
 *
 * AND THERE IS NO PEAK RING, though the gauge has a ghost tick and the symmetry is tempting. It
 * was built and then measured out: across 88 drifts in 16 runs the per-drift peak |g| has a
 * MINIMUM of 0.645 g and a median of 0.861, and 39.8 % of drifts reach full scale outright. A
 * ring drawn from that never leaves the outer third of the face and sits on the rim two slides
 * in five, so it reads as a second rim rather than as a reading — which is exactly how it looked
 * on the first frame of it. A marker whose whole range is "near the edge" is decoration.
 *
 * Nothing here re-renders: the vector, its glow and the peak ring are Reanimated shared values
 * written by the sample callback (see `useDriveRun`) and read on the UI thread, so it moves at
 * display rate on every one of the ~100 samples a second, not at the 10 Hz snapshot rate. That
 * matters more here than anywhere else on the screen: g is the one quantity on the display that
 * says what the car is doing BETWEEN degrees of slip.
 *
 * Imports Skia directly, so on web it must only ever be loaded through `GMeterView`.
 */
import { BlurMask, Canvas, Circle, Group, Path, RadialGradient, Skia, vec } from '@shopify/react-native-skia';
import { useMemo } from 'react';
import { interpolateColor, useDerivedValue } from 'react-native-reanimated';

import { colors, rgba } from '../theme';
import { gHeading, gToFace } from './gVector';
import type { HudSignals } from './signals';

/**
 * |(a_x, a_y)| in g at the rim, MEASURED rather than chosen.
 *
 * Over 16 runs (2 tracks × 4 seeds × 2 aggressions, 168 165 valid frames, 113 172 of them at
 * |β| ≥ 8°), the magnitude the pipeline's own `SlipState` reports while the car is sideways has
 * median 0.471 g, p75 0.568, p90 0.669, p99 0.841 and max 1.315.
 *
 * At 0.8 g — the full scale the old one-dimensional lateral ball used — the median vector reaches
 * 59 % of the radius and p90 84 %, so it spends nearly its whole life against the rim, where a
 * circle's travel is most compressed and least readable. At 1.0 g the median reaches 47 %, p90
 * 67 % and p99 84 %: the vector ranges over the whole face and still hits the rim on the moments
 * that deserve it, pinning on 0.33 % of drifting samples. 1.0 g is also the one figure on this
 * scale a driver already has a feel for.
 */
export const FULL_SCALE_G = 1.0;

export interface GMeterProps {
  width: number;
  height: number;
  signals: HudSignals;
  testID?: string;
}

export default function GMeter({ width, height, signals, testID }: GMeterProps) {
  const cx = width / 2;
  const cy = height / 2;
  /** The rim. The rest of the box is the glow's room to fade out in rather than be clipped —
      a glow that ends in a hard edge reads as a rendering bug, the same lesson as the gauge's
      bowl (see `AngleGauge.tsx`). */
  const r = Math.min(width, height) * 0.37;
  const bezel = Math.max(6, r * 0.1);
  const dotR = Math.max(6, r * 0.17);
  const hair = Math.max(1, r * 0.02);

  const rim = useMemo(() => Skia.PathBuilder.Make().addCircle(cx, cy, r).detach(), [cx, cy, r]);
  /** One mark at half scale. Two or three rings turned the face into a target; one says where
      the middle of the range is and then gets out of the way. */
  const half = useMemo(() => Skia.PathBuilder.Make().addCircle(cx, cy, r * 0.5).detach(), [cx, cy, r]);

  // ── everything below moves on the UI thread ────────────────────────────────────────
  // The engine-axes-to-face conversion is `gToFace` / `gHeading` in `gVector.ts` rather than
  // four lines here, because a sign convention written out at each use site is a sign convention
  // that eventually disagrees with itself — and unlike the rest of this file it can be swept in
  // vitest (`hud.test.ts`) over the whole face, instead of judged from one screenshot.
  const face = useDerivedValue(() => gToFace(signals.ayG.value, signals.axG.value, FULL_SCALE_G));
  const mag = useDerivedValue(() => face.value.mag);

  /**
   * The vector is ONE STATIC PATH — a full-length line straight up out of the centre — spun to
   * the heading and trimmed to the magnitude, exactly the way the gauge fills its arc with
   * `start`/`end`. Building a two-point path per frame instead would allocate a native Skia
   * object 100 times a second for the life of the run, and `Skia.Path.Make` is not something to
   * reach for from a worklet at all.
   *
   * Trimming rather than scaling, because a `scale` transform scales the STROKE with it: the
   * line would be a hairline at 0.2 g and a slab at 1 g, which is the one thing a magnitude
   * readout must not do — make small readings hard to see.
   */
  const spoke = useMemo(() => Skia.PathBuilder.Make().moveTo(cx, cy).lineTo(cx, cy - r).detach(), [cx, cy, r]);
  const spokeTransform = useDerivedValue(() => [{ rotate: gHeading(signals.ayG.value, signals.axG.value) }]);
  const dotTransform = useDerivedValue(() => [{ translateX: face.value.x * r }, { translateY: face.value.y * r }]);

  // The same rule the gauge lives by: an instrument does not celebrate a reading the engine has
  // already thrown away. `trust` is 0 on a loose mount or implausible physics, and at 0 the whole
  // thing is grey with no glow — the g of a phone sliding around a cup holder is not the g of a
  // car, and it is the LARGEST reading of the two instruments when the mount is the thing moving.
  // EMBER, SHIFTING TO GOLD AT THE LIMIT — the gauge's own ramp, on this instrument's range.
  //
  // It was cyan-to-ember for one build and every ordinary reading came out mud: an RGB lerp a
  // quarter of the way from #2FD6F0 to ember lands on (102, 185, 187), a desaturated teal, and
  // 0.3 g — the measured median of a held slide — is a quarter of the way. A ramp between two
  // opposite hues has no good colours in the middle, which is where a meter lives. Cyan is also
  // the cold-telemetry colour in this app (speed), and there is no speed on this screen to be
  // cold about; tyre load is the hot quantity, so it is drawn in the hot colour throughout and
  // goes gold where the gauge goes gold, at the edge of what the car will do.
  const hot = useDerivedValue(() =>
    signals.trust.value <= 0
      ? colors.muted
      : interpolateColor(mag.value * FULL_SCALE_G, [0, 0.55, 0.75, 1.0], [colors.ember, colors.ember, colors.ember, colors.gold]),
  );
  const glow = useDerivedValue(() => (0.12 + 0.72 * mag.value) * signals.trust.value);
  const bowlOpacity = useDerivedValue(() => (0.1 + 0.45 * mag.value) * signals.trust.value);
  const dimmed = useDerivedValue(() => 0.5 + 0.3 * signals.valid.value + 0.2 * signals.trust.value);

  const centre = useMemo(() => vec(cx, cy), [cx, cy]);

  return (
    <Canvas style={{ width, height }} testID={testID}>
      {/* the light pooling in the face, brightening with the load */}
      <Circle cx={cx} cy={cy} r={r} opacity={bowlOpacity}>
        <RadialGradient c={centre} r={r} colors={[rgba(colors.ember, 0.3), rgba(colors.ember, 0.1), rgba(colors.ember, 0)]} positions={[0, 0.6, 1]} />
      </Circle>

      {/* the bezel, built the way the gauge's arc track is: a thick dark ring with a hairline
          on top, so it reads as a machined edge rather than as a drawn outline */}
      <Path path={half} color={rgba(colors.text, 0.14)} style="stroke" strokeWidth={hair} />
      <Path path={rim} color={colors.line} style="stroke" strokeWidth={bezel} />
      <Path path={rim} color={rgba(colors.text, 0.3)} style="stroke" strokeWidth={hair} />

      {/* zero */}
      <Circle cx={cx} cy={cy} r={hair * 1.6} color={rgba(colors.text, 0.35)} />

      {/* the vector, glow first */}
      <Group opacity={glow}>
        <Group origin={centre} transform={spokeTransform}>
          <Path path={spoke} color={hot} style="stroke" strokeWidth={dotR * 1.1} strokeCap="round" start={0} end={mag}>
            <BlurMask blur={dotR} style="normal" />
          </Path>
        </Group>
        <Group transform={dotTransform}>
          <Circle cx={cx} cy={cy} r={dotR * 1.7} color={hot}>
            <BlurMask blur={dotR * 1.2} style="normal" />
          </Circle>
        </Group>
      </Group>
      <Group opacity={dimmed}>
        <Group origin={centre} transform={spokeTransform}>
          <Path path={spoke} color={hot} style="stroke" strokeWidth={dotR * 0.55} strokeCap="round" start={0} end={mag} />
        </Group>
        <Group transform={dotTransform}>
          <Circle cx={cx} cy={cy} r={dotR} color={hot} />
          <Circle cx={cx} cy={cy} r={dotR * 0.3} color={rgba('#FFFFFF', 0.9)} />
        </Group>
      </Group>
    </Canvas>
  );
}
