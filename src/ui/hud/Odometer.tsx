/**
 * The score, as an odometer — built to be read WHILE it moves, because on a live HUD the score
 * is climbing the whole time the driver is sideways. Three rules keep it legible mid-roll:
 *
 *  1. Only the units column spins continuously. Every column above it parks on its digit and
 *    turns over in the last 4 % of the decade below, the way a mechanical drum does — so a
 *    five-digit score has at most one column in motion at any instant, never five.
 *  2. Each window is masked by a short vertical fade at the top and bottom, so a glyph leaving
 *    the window dissolves instead of being sliced off. A partial digit then reads as motion,
 *    not as a broken character.
 *  3. The roll itself is a 260 ms linear tween, re-aimed whenever the score changes. While the
 *    points pour in that chains into one continuous roll; the moment the score stops, the last
 *    tween finishes and every column parks on a whole digit. (Exponential smoothing in a frame
 *    callback looks the same in motion but never settles on web, which leaves a parked score
 *    frozen mid-digit.)
 */
import { LinearGradient } from 'expo-linear-gradient';
import { memo, useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { Easing, useAnimatedReaction, useAnimatedStyle, useSharedValue, withTiming, type SharedValue } from 'react-native-reanimated';

import { AppText } from '../Text';
import { alpha, colors, fontFamilies } from '../theme';

export interface OdometerProps {
  /** Live value (points). */
  value: SharedValue<number>;
  /** Number of digit columns; the value is shown zero-padded to this width. */
  columns?: number;
  size: number;
  color?: string;
  /** Background the mask fades into (the surface the odometer sits on). */
  background?: string;
  /** Seconds for the display to cover a change (the tween lasts 2 × this). */
  tau?: number;
  testID?: string;
}

const DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '0'];

function OdometerImpl({ value, columns = 6, size, color = colors.ember, background = colors.bg0, tau = 0.13, testID }: OdometerProps) {
  const display = useSharedValue(0);
  const rowH = Math.round(size * 0.94);
  const colW = Math.round(size * 0.56);

  useAnimatedReaction(
    () => Math.round(value.value),
    (target, prev) => {
      if (prev === null) {
        display.value = target;
      } else if (target !== prev) {
        display.value = withTiming(target, { duration: Math.round(tau * 2000), easing: Easing.linear });
      }
    },
    [],
  );

  const places = useMemo(() => Array.from({ length: columns }, (_, i) => columns - 1 - i), [columns]);

  return (
    <View style={[styles.row, { height: rowH }]} testID={testID}>
      {places.map((place) => (
        <Column key={place} place={place} display={display} rowH={rowH} colW={colW} size={size} color={color} background={background} />
      ))}
    </View>
  );
}

function Column({
  place,
  display,
  rowH,
  colW,
  size,
  color,
  background,
}: {
  place: number;
  display: SharedValue<number>;
  rowH: number;
  colW: number;
  size: number;
  color: string;
  background: string;
}) {
  const pow = Math.pow(10, place);
  const strip = useAnimatedStyle(() => {
    const v = Math.max(0, display.value);
    const q = v / pow;
    const p = pow === 1 ? q % 10 : (Math.floor(q) % 10) + Math.max(0, (q % 1) - 0.96) / 0.04;
    return { transform: [{ translateY: -p * rowH }] };
  });
  const fade = useAnimatedStyle(() => ({ opacity: Math.max(0, display.value) >= pow || pow === 1 ? 1 : 0.16 }));
  const maskH = Math.max(6, Math.round(rowH * 0.2));
  const solid = background;
  const clear = alpha(background, 0);

  // The clipping window is a PLAIN view: Reanimated rewrites the style attribute of the views it
  // animates, and an inline `overflow: hidden` there does not survive on web.
  return (
    <View style={[styles.window, { width: colW, height: rowH }]}>
      <Animated.View style={[styles.strip, strip, fade]}>
        {DIGITS.map((d, i) => (
          <AppText key={i} numeric color={color} style={[styles.digit, { height: rowH, lineHeight: rowH, fontSize: size, width: colW }]}>
            {d}
          </AppText>
        ))}
      </Animated.View>
      <LinearGradient colors={[solid, clear]} style={[styles.mask, { top: 0, height: maskH }]} pointerEvents="none" />
      <LinearGradient colors={[clear, solid]} style={[styles.mask, { bottom: 0, height: maskH }]} pointerEvents="none" />
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'flex-start' },
  window: { overflow: 'hidden' },
  strip: { position: 'absolute', top: 0, left: 0 },
  mask: { position: 'absolute', left: 0, right: 0 },
  digit: { fontFamily: fontFamilies.display.extraboldItalic, textAlign: 'center', letterSpacing: -1 },
});

export const Odometer = memo(OdometerImpl);
export default Odometer;
