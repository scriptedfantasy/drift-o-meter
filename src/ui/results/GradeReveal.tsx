/**
 * The grade reveal: letterbox bars close, a beat of black, then the letter SLAMS in with a
 * shockwave and embers, and the screen hands over to the readable page behind it.
 *
 * One shared value (`t`, elapsed milliseconds) drives every element, which buys three things:
 * a tap anywhere can jump `t` to the end (skip), the harness can freeze `t` at a chosen frame
 * for a reproducible screenshot (`?reveal=hold|slam`), and reduce-motion is a different, shorter
 * timeline rather than a pile of conditionals — state changes keep, shake and embers go.
 */
import { useEffect } from 'react';
import { Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';
import Animated, { cancelAnimation, Easing, Extrapolation, interpolate, runOnJS, useAnimatedStyle, useDerivedValue, useSharedValue, withTiming } from 'react-native-reanimated';

import type { Grade } from '../../engine/types';
import { AppText } from '../Text';
import { alpha, colors, fontFamilies, space } from '../theme';
import GradeBurstView from './skia/GradeBurstView';
import { GRADE_WORDS } from './palette';

/** `full` plays it; `off` skips it; the rest freeze a frame for the screenshot harness. */
export type RevealMode = 'full' | 'off' | 'hold' | 'slam' | 'settle';

export const REVEAL_MODES: RevealMode[] = ['full', 'off', 'hold', 'slam', 'settle'];

export interface GradeRevealProps {
  grade: Grade;
  color: string;
  /** 0..100 rating shown under the letter. */
  rating: number;
  /** Small uppercase line under the rating (track · laps · date). */
  kicker: string;
  mode?: RevealMode;
  reduceMotion?: boolean;
  onDone(): void;
  testID?: string;
}

const BARS_IN = 360;
const HOLD_UNTIL = 900;
const SLAM = HOLD_UNTIL;
const BURST_MS = 900;
const BARS_OUT = 1880;
const TOTAL = 2280;

const RM_TOTAL = 1050;

/** Frames the harness can freeze on. */
const FROZEN: Partial<Record<RevealMode, number>> = { hold: 640, slam: 1060, settle: 1980 };

export function GradeReveal({ grade, color, rating, kicker, mode = 'full', reduceMotion = false, onDone, testID }: GradeRevealProps) {
  const { width, height } = useWindowDimensions();
  const frozenAt = FROZEN[mode];
  const total = reduceMotion ? RM_TOTAL : TOTAL;
  const t = useSharedValue(frozenAt ?? 0);
  const letterSize = Math.min(width * 0.62, height * 0.34);
  const burstSize = Math.min(width * 1.5, height * 0.9);
  const barH = Math.round(height * 0.18);

  useEffect(() => {
    cancelAnimation(t);
    if (frozenAt !== undefined) {
      t.value = frozenAt;
      return;
    }
    t.value = 0;
    t.value = withTiming(total, { duration: total, easing: Easing.linear }, (finished) => {
      if (finished) runOnJS(onDone)();
    });
    return () => cancelAnimation(t);
    // onDone is stable for the life of the screen
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frozenAt, total]);

  const skip = () => {
    if (frozenAt !== undefined) return;
    cancelAnimation(t);
    t.value = total;
    onDone();
  };

  const burst = useDerivedValue(() => (reduceMotion ? 0 : Math.max(0, Math.min(1, (t.value - SLAM) / BURST_MS))));

  const backdrop = useAnimatedStyle(() =>
    reduceMotion
      ? { opacity: interpolate(t.value, [0, 80, RM_TOTAL - 260, RM_TOTAL], [1, 1, 1, 0], Extrapolation.CLAMP) }
      : { opacity: interpolate(t.value, [0, 40, BARS_OUT + 120, TOTAL], [1, 1, 1, 0], Extrapolation.CLAMP) },
  );

  const bar = useAnimatedStyle(() => ({
    height: reduceMotion ? 0 : interpolate(t.value, [0, BARS_IN, BARS_OUT, BARS_OUT + 420], [0, barH, barH, 0], Extrapolation.CLAMP),
  }));

  const shake = useAnimatedStyle(() => {
    if (reduceMotion) return { transform: [{ translateX: 0 }, { translateY: 0 }] };
    const x = interpolate(t.value, [SLAM, SLAM + 45, SLAM + 95, SLAM + 145, SLAM + 200], [0, 6, -4.5, 2.5, 0], Extrapolation.CLAMP);
    const y = interpolate(t.value, [SLAM, SLAM + 45, SLAM + 95, SLAM + 145, SLAM + 200], [0, -3.5, 3, -1.5, 0], Extrapolation.CLAMP);
    return { transform: [{ translateX: x }, { translateY: y }] };
  });

  const letter = useAnimatedStyle(() => {
    if (reduceMotion) {
      return { opacity: interpolate(t.value, [0, 220], [0, 1], Extrapolation.CLAMP), transform: [{ scale: 1 }] };
    }
    return {
      opacity: interpolate(t.value, [SLAM - 30, SLAM + 70], [0, 1], Extrapolation.CLAMP),
      transform: [{ scale: interpolate(t.value, [SLAM, SLAM + 95, SLAM + 200, SLAM + 320], [3.4, 1.08, 0.96, 1], Extrapolation.CLAMP) }],
    };
  });

  const meta = useAnimatedStyle(() => ({
    opacity: reduceMotion
      ? interpolate(t.value, [140, 360], [0, 1], Extrapolation.CLAMP)
      : interpolate(t.value, [SLAM + 180, SLAM + 420], [0, 1], Extrapolation.CLAMP),
    transform: [{ translateY: reduceMotion ? 0 : interpolate(t.value, [SLAM + 180, SLAM + 460], [14, 0], Extrapolation.CLAMP) }],
  }));

  const judging = useAnimatedStyle(() => ({
    opacity: reduceMotion ? 0 : interpolate(t.value, [120, 300, HOLD_UNTIL - 120, HOLD_UNTIL], [0, 1, 1, 0], Extrapolation.CLAMP),
  }));

  const scan = useAnimatedStyle(() => ({
    opacity: reduceMotion ? 0 : interpolate(t.value, [BARS_IN, BARS_IN + 90, HOLD_UNTIL - 60, HOLD_UNTIL], [0, 0.85, 0.5, 0], Extrapolation.CLAMP),
    transform: [{ translateY: interpolate(t.value, [BARS_IN, HOLD_UNTIL], [-height * 0.18, height * 0.2], Extrapolation.CLAMP) }],
  }));

  const hint = useAnimatedStyle(() => ({
    opacity: reduceMotion ? 0 : interpolate(t.value, [420, 640, BARS_OUT - 200, BARS_OUT], [0, 0.55, 0.55, 0], Extrapolation.CLAMP),
  }));

  const burstStyle = useAnimatedStyle(() => ({ opacity: burst.value > 0 && burst.value < 1 ? 1 : 0 }));

  return (
    <Animated.View style={[StyleSheet.absoluteFill, styles.root, backdrop]} pointerEvents="auto" testID={testID}>
      <Pressable style={StyleSheet.absoluteFill} onPress={skip} accessibilityRole="button" accessibilityLabel="Skip the grade reveal" testID="reveal-skip">
        <Animated.View style={[styles.stage, shake]}>
          <Animated.View style={[styles.scan, { backgroundColor: alpha(colors.ember, 0.9), width }, scan]} pointerEvents="none" />

          {reduceMotion ? null : (
            <Animated.View style={[styles.burst, { width: burstSize, height: burstSize, marginLeft: -burstSize / 2, marginTop: -burstSize / 2 }, burstStyle]} pointerEvents="none">
              <GradeBurstView size={burstSize} color={color} progress={burst} testID="grade-burst" />
            </Animated.View>
          )}

          <Animated.Text
            accessibilityRole="header"
            style={[
              styles.letter,
              { color, fontSize: letterSize, lineHeight: letterSize * 1.02, textShadowColor: alpha(color, 0.65) },
              letter,
            ]}>
            {grade}
          </Animated.Text>

          <Animated.View style={[styles.meta, meta]}>
            <View style={[styles.ratingRule, { backgroundColor: alpha(color, 0.5) }]} />
            <AppText variant="heading" color={color} uppercase style={styles.word}>
              {GRADE_WORDS[grade]}
            </AppText>
            <AppText variant="telemetry" color="text" numeric style={styles.rating}>
              {rating.toFixed(1)}
              <AppText variant="label" color="muted">
                {'  '}/ 100
              </AppText>
            </AppText>
            <AppText variant="micro" color="muted" style={styles.kicker}>
              {kicker}
            </AppText>
          </Animated.View>

          <Animated.View style={[styles.hint, judging]} pointerEvents="none">
            <AppText variant="micro" color="ember">
              Judging the run
            </AppText>
          </Animated.View>

          <Animated.View style={[styles.skipHint, hint]} pointerEvents="none">
            <AppText variant="micro" color="muted">
              Tap to skip
            </AppText>
          </Animated.View>
        </Animated.View>

        <Animated.View style={[styles.barTop, { borderBottomColor: alpha(color, 0.55) }, bar]} pointerEvents="none" />
        <Animated.View style={[styles.barBottom, { borderTopColor: alpha(color, 0.55) }, bar]} pointerEvents="none" />
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  root: { backgroundColor: colors.bg0, zIndex: 20 },
  stage: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' },
  burst: { position: 'absolute', left: '50%', top: '50%' },
  letter: {
    fontFamily: fontFamilies.display.extraboldItalic,
    letterSpacing: -6,
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 48,
    includeFontPadding: false,
  },
  meta: { alignItems: 'center', gap: space[1], marginTop: space[2] },
  ratingRule: { width: 64, height: 2, marginBottom: space[3] },
  word: { letterSpacing: 2 },
  rating: { marginTop: space[1] },
  kicker: { marginTop: space[2] },
  hint: { position: 'absolute', top: '22%' },
  skipHint: { position: 'absolute', bottom: '14%' },
  barTop: { position: 'absolute', top: 0, left: 0, right: 0, backgroundColor: '#000000', borderBottomWidth: 1 },
  barBottom: { position: 'absolute', bottom: 0, left: 0, right: 0, backgroundColor: '#000000', borderTopWidth: 1 },
  scan: { position: 'absolute', height: 2, opacity: 0 },
});
