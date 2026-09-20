/**
 * The score, as an odometer: each column is a strip of 0–9 that slides, so the number rolls
 * instead of cutting. The units column rolls continuously while points accumulate, the tens
 * follow a tenth as fast, and a CHAIN LOST unwinds the whole thing backwards.
 *
 * The strips are driven by ONE shared value, smoothed on the UI thread by a frame callback
 * (`display += (target − display) · k`), so a 100 Hz score stream and a 4 000-point drop both
 * come out as motion. React renders this component once per run.
 */
import { memo, useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { useAnimatedStyle, useFrameCallback, useSharedValue, type SharedValue } from 'react-native-reanimated';

import { AppText } from '../Text';
import { colors, fontFamilies } from '../theme';

export interface OdometerProps {
  /** Live value (points). */
  value: SharedValue<number>;
  /** Number of digit columns; the value is shown zero-padded to this width. */
  columns?: number;
  size: number;
  color?: string;
  /** Seconds for the display to cover ~63 % of a change. */
  tau?: number;
  testID?: string;
}

const DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '0'];

function OdometerImpl({ value, columns = 6, size, color = colors.ember, tau = 0.13, testID }: OdometerProps) {
  const display = useSharedValue(0);
  const rowH = Math.round(size * 0.94);
  const colW = Math.round(size * 0.56);

  useFrameCallback((info) => {
    'worklet';
    const dt = Math.min(0.05, Math.max(0.001, (info.timeSincePreviousFrame ?? 16) / 1000));
    const k = 1 - Math.exp(-dt / tau);
    const target = Math.round(value.value);
    const next = display.value + (target - display.value) * k;
    display.value = Math.abs(target - next) < 0.05 ? target : next;
  }, true);

  const places = useMemo(() => Array.from({ length: columns }, (_, i) => columns - 1 - i), [columns]);

  return (
    <View style={[styles.row, { height: rowH }]} testID={testID}>
      {places.map((place) => (
        <Column key={place} place={place} display={display} rowH={rowH} colW={colW} size={size} color={color} />
      ))}
    </View>
  );
}

function Column({ place, display, rowH, colW, size, color }: { place: number; display: SharedValue<number>; rowH: number; colW: number; size: number; color: string }) {
  const pow = Math.pow(10, place);
  const strip = useAnimatedStyle(() => {
    const v = Math.max(0, display.value);
    const q = v / pow;
    // Units roll continuously (that is the spinning wheel); every column above it sits crisply
    // on its digit and only turns over in the last 4 % of the decade below, the way a mechanical
    // odometer does. Wider than that and a parked score reads as half-rolled mush.
    const p = pow === 1 ? q % 10 : (Math.floor(q) % 10) + Math.max(0, (q % 1) - 0.96) / 0.04;
    return { transform: [{ translateY: -p * rowH }] };
  });
  const fade = useAnimatedStyle(() => ({ opacity: Math.max(0, display.value) >= pow || pow === 1 ? 1 : 0.16 }));

  // The clipping window is a PLAIN view: Reanimated rewrites the style attribute of the views it
  // animates, and an inline `overflow: hidden` there does not survive on web.
  return (
    <View style={[styles.window, { width: colW, height: rowH }]}>
      <Animated.View style={[styles.strip, strip, fade]}>
        {DIGITS.map((d, i) => (
          <AppText
            key={i}
            numeric
            color={color}
            style={[styles.digit, { height: rowH, lineHeight: rowH, fontSize: size, width: colW }]}
          >
            {d}
          </AppText>
        ))}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'flex-start' },
  window: { overflow: 'hidden' },
  strip: { position: 'absolute', top: 0, left: 0 },
  digit: { fontFamily: fontFamilies.display.extraboldItalic, textAlign: 'center', letterSpacing: -1 },
});

export const Odometer = memo(OdometerImpl);
export default Odometer;
