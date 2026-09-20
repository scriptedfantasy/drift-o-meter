/**
 * Live mini-map: the line the car has drawn so far, ember where it was sideways, with the car
 * at the head. Positions come from `frame.state.x/y` (local ENU metres, north up).
 *
 * The two paths are built in WORLD coordinates and drawn through one group transform, so a
 * re-fit (the map grows with the run) costs a transform and not a rebuild; the head is a
 * shared-value transform, so the car moves at display rate while the paths are rebuilt at the
 * HUD's 10 Hz snapshot rate.
 *
 * Imports Skia directly, so on web it must only ever be loaded through `MiniMapView`.
 */
import { BlurMask, Canvas, Circle, Group, Path, Skia } from '@shopify/react-native-skia';
import { useMemo } from 'react';
import { useDerivedValue } from 'react-native-reanimated';

import { colors, rgba } from '../theme';
import type { HudSignals } from './signals';
import { fitTrail, type Trail } from './trail';

export interface MiniMapProps {
  width: number;
  height: number;
  trail: Trail;
  /** Points committed so far — changing it is what rebuilds the paths. */
  count: number;
  signals: HudSignals;
  testID?: string;
}

/** Rebuild at most every REBUILD_EVERY new points, and never draw more than MAX_SEGMENTS. */
const REBUILD_EVERY = 8;
const MAX_SEGMENTS = 600;

export default function MiniMap({ width, height, trail, count, signals, testID }: MiniMapProps) {
  // Both paths are rebuilt from scratch, so the cost is bounded twice: by how OFTEN (once per
  // 8 new points, about 1 Hz, not with every 10 Hz snapshot) and by how MANY (the trail is
  // strided down to 600 segments). A twenty-minute run costs the same as a one-minute run.
  const generation = Math.floor(Math.min(count, trail.n) / REBUILD_EVERY);
  const fit = useMemo(() => fitTrail(trail, width, height, 14, 80), [trail, width, height, generation]);

  const paths = useMemo(() => {
    const cold = Skia.PathBuilder.Make();
    const hot = Skia.PathBuilder.Make();
    const n = Math.min(count, trail.n);
    const step = Math.max(1, Math.ceil(n / MAX_SEGMENTS));
    if (n > step) {
      cold.moveTo(trail.x[0], trail.y[0]);
      for (let i = step; i < n; i += step) cold.lineTo(trail.x[i], trail.y[i]);
      let open = false;
      for (let i = step; i < n; i += step) {
        if (trail.drift[i] === 1) {
          if (!open) {
            hot.moveTo(trail.x[i - step], trail.y[i - step]);
            open = true;
          }
          hot.lineTo(trail.x[i], trail.y[i]);
        } else {
          open = false;
        }
      }
    }
    return { cold: cold.detach(), hot: hot.detach() };
  }, [generation, trail]);

  const worldTransform = useMemo(
    () => [{ translateX: fit.ox }, { translateY: fit.oy }, { scaleX: fit.scale }, { scaleY: -fit.scale }],
    [fit.ox, fit.oy, fit.scale],
  );

  const carTransform = useDerivedValue(() => [
    { translateX: fit.ox + signals.carX.value * fit.scale },
    { translateY: fit.oy - signals.carY.value * fit.scale },
    { rotate: -signals.carHeading.value },
  ]);
  const carColor = useDerivedValue(() => (signals.trust.value <= 0 ? colors.muted : signals.active.value > 0.5 ? colors.ember : colors.cyan));
  // "You were sideways here" is a reward statement. While the engine disowns the reading, the
  // trail is drawn in the same grey as the dial rather than in ember.
  const hotColor = useDerivedValue(() => (signals.trust.value <= 0 ? rgba(colors.muted, 0.75) : colors.ember));
  const hotGlow = useDerivedValue(() => (signals.trust.value <= 0 ? rgba(colors.muted, 0.25) : rgba(colors.ember, 0.55)));
  const coldColor = useDerivedValue(() => (signals.trust.value <= 0 ? rgba(colors.muted, 0.3) : rgba(colors.cyan, 0.42)));
  const carOpacity = useDerivedValue(() => (signals.valid.value > 0.5 ? 1 : 0.25));

  const car = useMemo(() => {
    const s = Math.max(5, Math.min(width, height) * 0.055);
    return Skia.PathBuilder.Make()
      .moveTo(s, 0)
      .lineTo(-s * 0.72, s * 0.62)
      .lineTo(-s * 0.34, 0)
      .lineTo(-s * 0.72, -s * 0.62)
      .close()
      .detach();
  }, [height, width]);

  const lineW = 2.4 / (fit.scale || 1);

  return (
    <Canvas style={{ width, height }} testID={testID}>
      <Group transform={worldTransform}>
        <Path path={paths.cold} color={coldColor} style="stroke" strokeWidth={lineW} strokeCap="round" strokeJoin="round" />
        <Path path={paths.hot} color={hotGlow} style="stroke" strokeWidth={lineW * 3.4} strokeCap="round" strokeJoin="round">
          <BlurMask blur={lineW * 2.4} style="normal" />
        </Path>
        <Path path={paths.hot} color={hotColor} style="stroke" strokeWidth={lineW * 1.7} strokeCap="round" strokeJoin="round" />
        {count > 1 ? <Circle cx={trail.x[0]} cy={trail.y[0]} r={lineW * 2} color={rgba(colors.text, 0.55)} /> : null}
      </Group>

      <Group transform={carTransform} opacity={carOpacity}>
        <Path path={car} color={carColor}>
          <BlurMask blur={5} style="solid" />
        </Path>
        <Path path={car} color={rgba('#FFFFFF', 0.92)} />
      </Group>

      {fit.empty ? <Circle cx={width / 2} cy={height / 2} r={3} color={rgba(colors.muted, 0.5)} /> : null}
    </Canvas>
  );
}
