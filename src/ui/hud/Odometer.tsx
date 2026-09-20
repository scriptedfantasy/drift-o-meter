/**
 * The score, as an odometer — built to be read WHILE it moves, because on a live HUD the score
 * is climbing the whole time the driver is sideways. Three rules keep it legible mid-roll:
 *
 *  1. Only the units column spins continuously. Every column above it parks on its digit and
 *    turns over in the last 4 % of the decade below, the way a mechanical drum does — so a
 *    five-digit score has at most one column in motion at any instant, never five.
 *  2. Each window is masked by a short vertical fade at the top and bottom, so a glyph leaving
 *    the window dissolves instead of being sliced off. A partial digit then reads as motion,
 *    not as a broken character. Leading zeros are hidden, not dimmed, and the thousands comma
 *    is part of the layout, so the score reads like the figures printed beside it.
 *  3. The value it renders is filtered at SAMPLE rate by the sample callback, not by an
 *    animation: re-aiming a tween a hundred times a second leaves each one a few milliseconds
 *    to run, and the digits end up trailing the real score by thousands of points. See
 *    `HudSignals.totalDisplay`.
 */
import { LinearGradient } from 'expo-linear-gradient';
import { Fragment, memo, useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { useAnimatedStyle, type SharedValue } from 'react-native-reanimated';

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
  testID?: string;
}

const DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '0'];

function OdometerImpl({ value, columns = 6, size, color = colors.ember, background = colors.bg0, testID }: OdometerProps) {
  // `value` is already smoothed at sample rate (see `HudSignals.totalDisplay`), so the columns
  // are a pure function of it: no animation scheduler between the score and the digits.
  const display = value;
  const rowH = Math.round(size * 0.94);
  const colW = Math.round(size * 0.56);

  const places = useMemo(() => Array.from({ length: columns }, (_, i) => columns - 1 - i), [columns]);

  return (
    <View style={[styles.row, { height: rowH }]} testID={testID}>
      {places.map((place) => (
        <Fragment key={place}>
          <Column place={place} display={display} rowH={rowH} colW={colW} size={size} color={color} background={background} />
          {place === 3 ? <Separator display={display} rowH={rowH} size={size} color={color} /> : null}
        </Fragment>
      ))}
    </View>
  );
}

/** The thousands comma. Present in the layout at all times, invisible below 1 000. */
function Separator({ display, rowH, size, color }: { display: SharedValue<number>; rowH: number; size: number; color: string }) {
  const style = useAnimatedStyle(() => ({ opacity: Math.max(0, display.value) >= 1000 ? 1 : 0 }));
  return (
    <Animated.View style={[{ height: rowH }, style]}>
      <AppText numeric color={color} style={[styles.digit, { height: rowH, lineHeight: rowH, fontSize: size, width: Math.round(size * 0.24) }]}>
        ,
      </AppText>
    </Animated.View>
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
  // Leading zeros are hidden outright rather than dimmed: at 16 % they measured 1.3:1 against
  // the background, which reads as a smudge next to a digit rather than as a zero.
  const fade = useAnimatedStyle(() => ({ opacity: Math.max(0, display.value) >= pow || pow === 1 ? 1 : 0 }));
  const maskH = Math.max(5, Math.round(rowH * 0.16));
  const solid = background;
  const clear = alpha(background, 0);

  // Two nested views on purpose: the OUTER one is animated (so a hidden leading zero takes its
  // masks with it instead of leaving a dark block on the background) and the INNER one is plain,
  // because Reanimated rewrites the style attribute of the views it animates and an inline
  // `overflow: hidden` there does not survive on web.
  return (
    <Animated.View style={[{ width: colW, height: rowH }, fade]}>
      <View style={[styles.window, { width: colW, height: rowH }]}>
        <Animated.View style={[styles.strip, strip]}>
          {DIGITS.map((d, i) => (
            <AppText key={i} numeric color={color} style={[styles.digit, { height: rowH, lineHeight: rowH, fontSize: size, width: colW }]}>
              {d}
            </AppText>
          ))}
        </Animated.View>
        <LinearGradient colors={[solid, clear]} style={[styles.mask, { top: 0, height: maskH }]} pointerEvents="none" />
        <LinearGradient colors={[clear, solid]} style={[styles.mask, { bottom: 0, height: maskH }]} pointerEvents="none" />
      </View>
    </Animated.View>
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
