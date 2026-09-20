/**
 * Odometer: the session total rolling up, digit by digit, the way a score should arrive.
 * Higher digits only move when the ones below them wrap, so it reads like mechanical drums
 * rather than five independent spinners.
 */
import { useEffect } from 'react';
import { StyleSheet, Text, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';
import Animated, { cancelAnimation, Easing, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

import { colors, fontFamilies } from '../theme';

export interface OdometerProps {
  /** Final value. */
  value: number;
  /** Start the roll. While false the odometer sits at its final value (no animation). */
  run?: boolean;
  durationMs?: number;
  fontSize: number;
  color?: string;
  /** Keep the digits still (reduce-motion): the value simply appears. */
  reduceMotion?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

const CELLS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '0'];

export function Odometer({ value, run = true, durationMs = 1300, fontSize, color = colors.ember, reduceMotion = false, style, testID }: OdometerProps) {
  const target = Math.max(0, Math.round(Number.isFinite(value) ? value : 0));
  const text = target.toLocaleString('en-US');
  const v = useSharedValue(run ? 0 : target);
  const digitH = Math.round(fontSize * 0.98);
  const digitW = Math.round(fontSize * 0.54);

  useEffect(() => {
    cancelAnimation(v);
    if (!run) {
      v.value = target;
      return;
    }
    v.value = 0;
    v.value = withTiming(target, { duration: reduceMotion ? 320 : durationMs, easing: Easing.bezier(0.16, 1, 0.3, 1) });
  }, [run, target, durationMs, reduceMotion, v]);

  // place exponent per character: the rightmost digit is 10^0
  const digitsAfter: number[] = [];
  let seen = 0;
  for (let i = text.length - 1; i >= 0; i--) {
    digitsAfter[i] = seen;
    if (text[i] !== ',') seen++;
  }

  return (
    <View style={[styles.row, { height: digitH }, style]} testID={testID} accessibilityLabel={`${target} points`}>
      {text.split('').map((ch, i) =>
        ch === ',' ? (
          <Text key={`c${i}`} style={[styles.comma, { color, fontSize, lineHeight: digitH, width: Math.round(fontSize * 0.24) }]}>
            ,
          </Text>
        ) : (
          <Digit key={`d${i}`} place={digitsAfter[i]} v={v} digitH={digitH} digitW={digitW} fontSize={fontSize} color={color} />
        ),
      )}
    </View>
  );
}

function Digit({
  place,
  v,
  digitH,
  digitW,
  fontSize,
  color,
}: {
  place: number;
  v: { value: number };
  digitH: number;
  digitW: number;
  fontSize: number;
  color: string;
}) {
  const scale = Math.pow(10, place);
  const strip = useAnimatedStyle(() => {
    const pos = v.value / scale;
    const whole = Math.floor(pos);
    const frac = pos - whole;
    // sit still, then flip: the drum only turns in the last quarter of each count
    const f = Math.min(1, Math.max(0, (frac - 0.72) / 0.28));
    const digit = ((whole % 10) + 10) % 10;
    return { transform: [{ translateY: -(digit + f) * digitH }] };
  });
  const dim = useAnimatedStyle(() => ({ opacity: v.value >= scale || place === 0 ? 1 : 0.2 }));

  return (
    <Animated.View style={[styles.window, { height: digitH, width: digitW }, dim]}>
      <Animated.View style={strip}>
        {CELLS.map((c, i) => (
          <Text key={i} style={[styles.digit, { color, fontSize, lineHeight: digitH, height: digitH }]}>
            {c}
          </Text>
        ))}
      </Animated.View>
    </Animated.View>
  );
}

const numberStyle: TextStyle = {
  fontFamily: fontFamilies.display.extraboldItalic,
  fontVariant: ['tabular-nums'],
  textAlign: 'center',
  letterSpacing: -1,
};

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'flex-start', overflow: 'hidden' },
  window: { overflow: 'hidden' },
  digit: { ...numberStyle },
  comma: { ...numberStyle, textAlign: 'left' },
});
