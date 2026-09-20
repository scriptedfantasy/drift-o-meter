/**
 * Odometer: the session total rolling up, the way a score should arrive.
 *
 * Only the low columns actually turn (`rollPlaces`, default the ones and tens). Everything above
 * them SNAPS to its digit on carry, exactly like a mechanical drum whose higher wheels only move
 * when the one below completes a revolution — and, more importantly, because a number with five
 * columns caught mid-glyph at five different offsets is not a number, it is confetti. The count
 * is the moment the driver is watching; it has to stay readable the whole way up.
 *
 * The turning columns get a short gradient cap top and bottom, so a half-glyph reads as motion
 * rather than as a character sliced in half.
 */
import { useEffect } from 'react';
import { LinearGradient } from 'expo-linear-gradient';
import { StyleSheet, Text, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';
import Animated, { cancelAnimation, Easing, useAnimatedStyle, useSharedValue, withDelay, withTiming, type SharedValue } from 'react-native-reanimated';

import { alpha, colors, fontFamilies } from '../theme';

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
  /** How many of the lowest columns roll continuously; the rest snap on carry. */
  rollPlaces?: number;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

const CELLS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '0'];

export function Odometer({ value, run = true, durationMs = 1300, fontSize, color = colors.ember, reduceMotion = false, rollPlaces = 2, style, testID }: OdometerProps) {
  const target = Math.max(0, Math.round(Number.isFinite(value) ? value : 0));
  const text = target.toLocaleString('en-US');
  const v = useSharedValue(run ? 0 : target);
  // 0 while the drums are turning, 1 once they have to sit still on the final digits: the carry
  // fraction is only correct mid-count, so it is eased out at the end
  const settle = useSharedValue(run ? 0 : 1);
  const digitH = Math.round(fontSize * 0.98);
  const digitW = Math.round(fontSize * 0.52);

  useEffect(() => {
    cancelAnimation(v);
    cancelAnimation(settle);
    if (!run) {
      v.value = target;
      settle.value = 1;
      return;
    }
    const d = reduceMotion ? 320 : durationMs;
    v.value = 0;
    settle.value = 0;
    v.value = withTiming(target, { duration: d, easing: Easing.bezier(0.16, 1, 0.3, 1) });
    settle.value = withDelay(Math.max(0, d - 220), withTiming(1, { duration: 220, easing: Easing.linear }));
  }, [run, target, durationMs, reduceMotion, v, settle]);

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
          <Digit
            key={`d${i}`}
            place={digitsAfter[i]}
            rolls={digitsAfter[i] < rollPlaces && !reduceMotion}
            v={v}
            settle={settle}
            digitH={digitH}
            digitW={digitW}
            fontSize={fontSize}
            color={color}
          />
        ),
      )}
    </View>
  );
}

function Digit({
  place,
  rolls,
  v,
  settle,
  digitH,
  digitW,
  fontSize,
  color,
}: {
  place: number;
  rolls: boolean;
  v: SharedValue<number>;
  settle: SharedValue<number>;
  digitH: number;
  digitW: number;
  fontSize: number;
  color: string;
}) {
  const scale = Math.pow(10, place);
  const strip = useAnimatedStyle(() => {
    const pos = v.value / scale;
    const whole = Math.floor(pos);
    const digit = ((whole % 10) + 10) % 10;
    if (!rolls) return { transform: [{ translateY: -digit * digitH }] };
    // sit still, then flip: the drum only turns in the last quarter of each count
    const frac = pos - whole;
    const f = Math.min(1, Math.max(0, (frac - 0.72) / 0.28)) * (1 - settle.value);
    return { transform: [{ translateY: -(digit + f) * digitH }] };
  });
  const dim = useAnimatedStyle(() => ({ opacity: v.value >= scale || place === 0 ? 1 : 0.2 }));
  const capH = Math.max(4, Math.round(digitH * 0.16));

  return (
    <Animated.View style={[styles.window, { height: digitH, width: digitW }, dim]}>
      <Animated.View style={strip}>
        {CELLS.map((c, i) => (
          <Text key={i} style={[styles.digit, { color, fontSize, lineHeight: digitH, height: digitH }]}>
            {c}
          </Text>
        ))}
      </Animated.View>
      {rolls ? (
        <>
          <LinearGradient
            colors={[alpha(colors.bg0, 0.92), alpha(colors.bg0, 0)]}
            style={[styles.cap, { top: 0, height: capH }]}
            pointerEvents="none"
          />
          <LinearGradient
            colors={[alpha(colors.bg0, 0), alpha(colors.bg0, 0.92)]}
            style={[styles.cap, { bottom: 0, height: capH }]}
            pointerEvents="none"
          />
        </>
      ) : null}
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
  cap: { position: 'absolute', left: 0, right: 0 },
  digit: { ...numberStyle },
  comma: { ...numberStyle, textAlign: 'left' },
});
