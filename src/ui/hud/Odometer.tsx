/**
 * The score, as an odometer — built to be read WHILE it moves, because on a live HUD the score
 * is climbing the whole time the driver is sideways. Three rules keep it legible mid-roll:
 *
 *  1. Only the units column spins continuously. Every column above it parks on its digit and
 *    turns over only while the column BELOW it is crossing 9 → 0, the way a mechanical drum
 *    does — so a five-digit score has at most one column in motion at any instant, never five,
 *    and at rest the figure on screen is exactly `Math.round(value)`. The arithmetic (and what
 *    it fixes) is in `odometerColumns.ts`, where a sweep test can reach it.
 *  2. A glyph leaving the window DISSOLVES rather than being sliced off, and the dissolve is on
 *    the GLYPH, not on the background. A painted fade is only honest over a flat surface: on the
 *    drive display the odometer sits in the left gutter, inside the ember edge bloom, and a bg0
 *    fade punched a visible plate through it — background rgb(31,17,15) at x = 80 in
 *    `drive-peak.png`, rgb(9,9,13) inside the mask bands, a 22/255 step in a ~290 × 55 pt
 *    rectangle. So each digit carries its own opacity, from its own distance out of the window
 *    centre (`EDGE_SOLID` … 1 digit height), which costs nothing to be right over a gradient, a
 *    glow or a photograph. `background` remains for a surface that really IS one flat colour and
 *    paints the old fade on top of it. Leading zeros are hidden, not dimmed, and the thousands
 *    comma is part of the layout, so the score reads like the figures printed beside it.
 *  3. The value it renders is filtered at SAMPLE rate by the sample callback, not by an
 *    animation: re-aiming a tween a hundred times a second leaves each one a few milliseconds
 *    to run, and the digits end up trailing the real score by thousands of points. See
 *    `HudSignals.totalDisplay`.
 *  4. HOW MANY columns are in use is decided on the UI thread too, per column, from the value
 *    (`columnVisible`) — never through React state. A count is a number of views, so a count
 *    raised from a worklet cannot take effect until the next commit, and for that commit the
 *    leading digit is not drawn at all. That is not a subtle artefact: the measured reading went
 *    9,014 → "0,924" → 14,330 across one decade crossing of the results reveal.
 */
import { LinearGradient } from 'expo-linear-gradient';
import { Fragment, memo, useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { useAnimatedStyle, type SharedValue } from 'react-native-reanimated';

import { AppText } from '../Text';
import { alpha, colors, fontFamilies } from '../theme';
import { columnOffset, columnVisible } from './odometerColumns';

export interface OdometerProps {
  /** Live value (points). */
  value: SharedValue<number>;
  /** Most columns the field will ever hold (it uses only as many as the number needs). */
  columns?: number;
  size: number;
  color?: string;
  /**
   * The FLAT colour immediately behind the digits, if there is one. It paints the top/bottom
   * fade masks, so passing a colour that is not what is actually behind them draws a plate of
   * it. Leave it out over anything lit, textured or gradient — the window still clips.
   */
  background?: string | null;
  testID?: string;
}

const DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '0'];

/**
 * How far out of the window's centre a glyph stays at full opacity, in digit heights. Beyond it
 * the glyph fades linearly to nothing at one full height, where the window's clip would have cut
 * it. 0.28 keeps a parked digit solid and leaves both halves of a drum caught mid-turn at 0.69,
 * which reads as a dissolve rather than as two dim digits.
 */
const EDGE_SOLID = 0.28;

/** A glyph's opacity given its index on the strip and where the strip sits. */
function glyphOpacity(index: number, offset: number): number {
  'worklet';
  const d = Math.abs(index - offset);
  if (d <= EDGE_SOLID) return 1;
  const o = 1 - (d - EDGE_SOLID) / (1 - EDGE_SOLID);
  return o > 0 ? o : 0;
}

function OdometerImpl({ value, columns = 6, size, color = colors.ember, background = null, testID }: OdometerProps) {
  // `value` is already smoothed at sample rate (see `HudSignals.totalDisplay`), so the columns
  // are a pure function of it: no animation scheduler between the score and the digits.
  const display = value;
  const rowH = Math.round(size * 0.94);
  const colW = Math.round(size * 0.56);

  // Every column the field could ever need is MOUNTED, and each one decides on the UI thread
  // whether it is in use at this value (`columnVisible`) — collapsing to zero width when it is
  // not, so the digits still start next to the SCORE label instead of floating half a screen
  // away behind hidden leading zeros.
  //
  // The count used to be React state, raised through `runOnJS(setUsed)` from a UI-thread
  // reaction, and this file used to claim the count "grows on the frame the score crosses a
  // decade". It did not: a commit is not a frame. On the reveal's own captured frames the hero
  // odometer read 9,014 at t=1420 ms, "0,924" at t=1444 — the value was 10,924 and the leading
  // column had not been rendered yet — and 14,330 at t=1491. The number went backwards by ten
  // thousand at every decade, on the one screen whose odometer is ONLY ever read in motion.
  // Nothing about the column count is committed now, so nothing about it can lag.
  const places = useMemo(() => Array.from({ length: Math.max(1, columns) }, (_, i) => Math.max(1, columns) - 1 - i), [columns]);

  return (
    <View style={[styles.row, { height: rowH }]} testID={testID}>
      {places.map((place) => (
        <Fragment key={place}>
          <Column place={place} columns={columns} display={display} rowH={rowH} colW={colW} size={size} color={color} background={background} />
          {place === 3 && columns > 3 ? <Separator display={display} rowH={rowH} size={size} color={color} /> : null}
        </Fragment>
      ))}
    </View>
  );
}

/**
 * The thousands comma. Part of the layout whenever the field is wide enough to need one, and it
 * takes its width back below 1 000 — on the UI thread, with the column beside it, so the two
 * never disagree about how wide the number is.
 */
function Separator({ display, rowH, size, color }: { display: SharedValue<number>; rowH: number; size: number; color: string }) {
  const w = Math.round(size * 0.24);
  const style = useAnimatedStyle(() => {
    const on = (display.value > 0 ? display.value : 0) >= 1000;
    return { opacity: on ? 1 : 0, width: on ? w : 0 };
  });
  return (
    <Animated.View style={[{ height: rowH }, style]}>
      <AppText numeric color={color} style={[styles.digit, { height: rowH, lineHeight: rowH, fontSize: size, width: w }]}>
        ,
      </AppText>
    </Animated.View>
  );
}

function Column({
  place,
  columns,
  display,
  rowH,
  colW,
  size,
  color,
  background,
}: {
  place: number;
  columns: number;
  display: SharedValue<number>;
  rowH: number;
  colW: number;
  size: number;
  color: string;
  background: string | null;
}) {
  const strip = useAnimatedStyle(() => ({ transform: [{ translateY: -columnOffset(display.value, place) * rowH }] }));
  // In use or not, decided from the value itself on the UI thread — and a column that is not in
  // use gives its WIDTH back as well as its ink, or the field would be as wide as its largest
  // possible score from the first frame. Leading zeros are hidden outright rather than dimmed:
  // at 16 % they measured 1.3:1 against the background, which reads as a smudge next to a digit
  // rather than as a zero.
  const fade = useAnimatedStyle(() => {
    const on = columnVisible(display.value, place, columns);
    return { opacity: on ? 1 : 0, width: on ? colW : 0 };
  });
  const maskH = Math.max(5, Math.round(rowH * 0.16));
  const solid = background;
  const clear = background === null ? null : alpha(background, 0);

  // Two nested views on purpose: the OUTER one is animated (so a hidden leading zero takes its
  // masks with it instead of leaving a dark block on the background) and the INNER one is plain,
  // because Reanimated rewrites the style attribute of the views it animates and an inline
  // `overflow: hidden` there does not survive on web.
  return (
    <Animated.View style={[{ width: colW, height: rowH }, fade]}>
      <View style={[styles.window, { width: colW, height: rowH }]}>
        <Animated.View style={[styles.strip, strip]}>
          {DIGITS.map((d, i) => (
            <Glyph key={i} index={i} digit={d} display={display} place={place} rowH={rowH} colW={colW} size={size} color={color} />
          ))}
        </Animated.View>
        {solid !== null && clear !== null ? (
          <>
            <LinearGradient colors={[solid, clear]} style={[styles.mask, { top: 0, height: maskH }]} pointerEvents="none" />
            <LinearGradient colors={[clear, solid]} style={[styles.mask, { bottom: 0, height: maskH }]} pointerEvents="none" />
          </>
        ) : null}
      </View>
    </Animated.View>
  );
}

/**
 * One digit on a drum, carrying its own edge fade. The opacity is a pure function of where the
 * strip sits, evaluated on the UI thread beside the translate that moves it — so a glyph leaving
 * the window dissolves over whatever is behind it, with nothing painted on top.
 */
function Glyph({
  index,
  digit,
  display,
  place,
  rowH,
  colW,
  size,
  color,
}: {
  index: number;
  digit: string;
  display: SharedValue<number>;
  place: number;
  rowH: number;
  colW: number;
  size: number;
  color: string;
}) {
  const style = useAnimatedStyle(() => ({ opacity: glyphOpacity(index, columnOffset(display.value, place)) }));
  return (
    <Animated.View style={style}>
      <AppText numeric color={color} style={[styles.digit, { height: rowH, lineHeight: rowH, fontSize: size, width: colW }]}>
        {digit}
      </AppText>
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
