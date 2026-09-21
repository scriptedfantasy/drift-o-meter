/**
 * Cold telemetry: speed and the lateral-g ball.
 *
 * The number is on the 10 Hz snapshot (a speed that steps 10 times a second reads as steady at
 * arm's length); the ball itself is a shared value, so it swings with every sample — it is the
 * only thing on the HUD that shows what the car is doing BETWEEN degrees of slip.
 */
import { memo } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { useAnimatedStyle } from 'react-native-reanimated';

import { AppText, Micro } from '../Text';
import { formatSpeed, speedUnitLabel, type SpeedUnits } from '../format';
import { alpha, colors, fontFamilies, space } from '../theme';
import type { HudSignals } from './signals';

/**
 * Lateral acceleration that pins the ball to the end of its track, in g.
 *
 * MEASURED, not chosen: over 12 runs (2 tracks × 3 seeds × 2 aggressions, 91 877 drifting
 * samples) |a_y| while the car is sideways has a median of 0.34 g, p90 0.64 and p99 0.77. At
 * the old 1.2 g full scale the median ball sat 28 % of the way out — 14 px of a 50 px half
 * track — and in 5 of 8 live frames it was inside a ball-width of centre, which is a meter that
 * does not visibly move. At 0.8 g the median travels 42 %, p90 reaches 80 %, and only 0.6 % of
 * drifting samples pin it, so the top of the scale still means something.
 */
const FULL_SCALE_G = 0.8;

export interface TelemetryRowProps {
  signals: HudSignals;
  speedKmh: number;
  units: SpeedUnits;
  vertical?: boolean;
  size?: number;
  testID?: string;
}

function TelemetryRowImpl({ signals, speedKmh, units, vertical = false, size = 64, testID }: TelemetryRowProps) {
  const trackW = vertical ? 132 : 118;
  return (
    <View style={[styles.wrap, vertical && styles.wrapVertical]} testID={testID}>
      <View style={styles.speed}>
        <View style={styles.speedLine}>
          <AppText numeric style={[styles.speedValue, { fontSize: size, lineHeight: size * 0.96 }]}>
            {formatSpeed(speedKmh / 3.6, units)}
          </AppText>
          <Micro style={styles.unit}>{speedUnitLabel(units)}</Micro>
        </View>
      </View>
      <GBall signals={signals} width={trackW} />
    </View>
  );
}

function GBall({ signals, width }: { signals: HudSignals; width: number }) {
  const half = width / 2 - 9;
  const ball = useAnimatedStyle(() => {
    const g = Math.max(-1, Math.min(1, -signals.ayG.value / FULL_SCALE_G));
    const heat = Math.min(1, Math.abs(g));
    return {
      transform: [{ translateX: g * half }, { scale: 1 + 0.35 * heat }],
      backgroundColor: heat > 0.66 ? colors.ember : colors.cyan,
    };
  });
  const halo = useAnimatedStyle(() => ({ opacity: 0.12 + 0.5 * Math.min(1, Math.abs(signals.ayG.value) / FULL_SCALE_G) }));

  return (
    <View style={styles.gWrap}>
      <View style={[styles.gTrack, { width }]}>
        <Animated.View style={[styles.gHalo, halo]} />
        <View style={styles.gCentre} />
        <Animated.View style={[styles.gBall, ball]} />
      </View>
      <View style={[styles.gLabels, { width }]}>
        <Micro>L</Micro>
        <Micro>Lateral g</Micro>
        <Micro>R</Micro>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: 'row', alignItems: 'flex-end', gap: space[5] },
  wrapVertical: { flexDirection: 'column', alignItems: 'flex-start', gap: space[3] },
  speed: { gap: 0 },
  speedLine: { flexDirection: 'row', alignItems: 'baseline', gap: space[2] },
  speedValue: { fontFamily: fontFamilies.display.extraboldItalic, color: colors.cyan, letterSpacing: -2 },
  unit: { marginBottom: 4 },
  gWrap: { gap: 4, marginBottom: 6 },
  gTrack: {
    height: 18,
    borderRadius: 9,
    backgroundColor: alpha(colors.bg2, 0.9),
    borderWidth: 1,
    borderColor: colors.line,
    alignItems: 'center',
    justifyContent: 'center',
  },
  gHalo: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, borderRadius: 9, backgroundColor: alpha(colors.cyan, 0.35) },
  gCentre: { position: 'absolute', width: 1, top: 3, bottom: 3, backgroundColor: alpha(colors.text, 0.35) },
  gBall: { width: 14, height: 14, borderRadius: 7, backgroundColor: colors.cyan },
  gLabels: { flexDirection: 'row', justifyContent: 'space-between' },
});

export const TelemetryRow = memo(TelemetryRowImpl);
export default TelemetryRow;
