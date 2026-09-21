/**
 * The grade reveal: letterbox bars close, a beat of black, then the letter SLAMS in with a
 * shockwave and embers, and the screen hands over to the readable page behind it.
 *
 * One shared value (`t`, elapsed milliseconds) drives every element, which buys three things:
 * a tap anywhere can jump `t` to the end (skip), the harness can freeze `t` at a chosen frame
 * for a reproducible screenshot (`?reveal=hold|slam`), and reduce-motion is a different, shorter
 * timeline rather than a pile of conditionals — state changes keep, shake and embers go.
 */
import { useEffect, useRef } from 'react';
import { Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';
import Animated, { cancelAnimation, Easing, Extrapolation, interpolate, runOnJS, useAnimatedStyle, useDerivedValue, useSharedValue, withTiming } from 'react-native-reanimated';

import type { Grade } from '../../engine/types';
import { AppText } from '../Text';
import { alpha, colors, fontFamilies, gutter, space } from '../theme';
import { feelCue, gradeCueFor } from '../audio';
import GradeBurstView from './skia/GradeBurstView';
import { resultsLayout } from './layout';
import { gradeWord } from './palette';

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
  /** How many slides the run contained: a lap with none is not graded "Rough". */
  drifts?: number;
  mode?: RevealMode;
  reduceMotion?: boolean;
  onDone(): void;
  testID?: string;
}

const BARS_IN = 360;
const HOLD_UNTIL = 900;
const SLAM = HOLD_UNTIL;
const BURST_MS = 760;
const BARS_OUT = 1880;
const TOTAL = 2280;

const RM_TOTAL = 1050;

/** Frames the harness can freeze on. */
const FROZEN: Partial<Record<RevealMode, number>> = { hold: 640, slam: 1170, settle: 1980 };

export function GradeReveal({ grade, color, rating, kicker, drifts = 1, mode = 'full', reduceMotion = false, onDone, testID }: GradeRevealProps) {
  const { width, height } = useWindowDimensions();
  const frozenAt = FROZEN[mode];
  const total = reduceMotion ? RM_TOTAL : TOTAL;
  const t = useSharedValue(frozenAt ?? 0);
  // The page behind decides the shape of the reveal too. A wide frame is not a tall one with the
  // sides painted black: the letter is sized off the HEIGHT it has, the word and the rating sit
  // beside each other on one line instead of stacking, the shockwave is wide enough to run off
  // both ends of the stage, and the letterbox is the bar a 2.4:1 frame wants rather than the deep
  // one a portrait page can afford.
  const L = resultsLayout(width, height);
  const wide = L.landscape;
  // wide: everything between the two bars has to fit BETWEEN them — letter, rule, word, rating
  // and kicker — so the letter takes a little over half the height and the meta closes up under it
  const letterSize = wide ? Math.min(width * 0.28, height * 0.54) : Math.min(width * 0.62, height * 0.34);
  const burstSize = wide ? Math.min(width * 0.78, height * 1.7) : Math.min(width * 1.5, height * 0.9);
  const barH = Math.round(height * (wide ? 0.13 : 0.18));

  // The grade cue, scheduled for the instant the letter lands rather than for the instant this
  // effect runs: the impact is at sample 0 of the clip, so SLAM is the cue time. It is NOT tied to
  // reduce-motion — sound is information, and a driver who has asked for less movement has not
  // asked to be told less.
  //
  // WHICH cue is the letter's own business, and `gradeCueFor` is the only place that decides.
  // The screen paints the letter with `gradeColors` — gold for S, ember for A, cyan for B, plain
  // text for C, MUTED for D — and the bank holds two renders of the same 1.65 s figure so the ear
  // can agree with it. A single gold fanfare with a Success notification under a grey "Rough" is
  // the two channels telling the driver different things about the same run.
  const gradeCue = useRef<ReturnType<typeof setTimeout> | null>(null);
  const gradeHeard = useRef(false);
  const hearGrade = () => {
    if (gradeHeard.current) return;
    gradeHeard.current = true;
    if (gradeCue.current) clearTimeout(gradeCue.current);
    gradeCue.current = null;
    feelCue(gradeCueFor(grade));
  };

  useEffect(() => {
    cancelAnimation(t);
    if (frozenAt !== undefined) {
      t.value = frozenAt;
      return;
    }
    t.value = 0;
    gradeHeard.current = false;
    gradeCue.current = setTimeout(hearGrade, SLAM);
    t.value = withTiming(total, { duration: total, easing: Easing.linear }, (finished) => {
      if (finished) runOnJS(onDone)();
    });
    return () => {
      if (gradeCue.current) clearTimeout(gradeCue.current);
      gradeCue.current = null;
      cancelAnimation(t);
    };
    // onDone and hearGrade are stable for the life of the screen
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frozenAt, total]);

  // A tap ends the reveal — including a frozen one, so a screenshot run can prove the skip works
  // without having to catch a 2-second window. Skipping puts the letter on screen NOW, so the
  // grade is heard now too: a driver who skips the animation has not asked for silence.
  const skip = () => {
    hearGrade();
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

  // the hairline on the inner edge of a bar must vanish with the bar, or a closed-to-zero bar
  // leaves a bright line along the very edge of the screen
  const bar = useAnimatedStyle(() => {
    const h = interpolate(t.value, [0, BARS_IN, BARS_OUT, BARS_OUT + 420], [0, barH, barH, 0], Extrapolation.CLAMP);
    return { height: h, borderTopWidth: h > 2 ? 1 : 0, borderBottomWidth: h > 2 ? 1 : 0 };
  });

  const shake = useAnimatedStyle(() => {
    if (reduceMotion) return { transform: [{ translateX: 0 }, { translateY: 0 }] };
    const x = interpolate(t.value, [SLAM, SLAM + 45, SLAM + 95, SLAM + 145, SLAM + 200], [0, 6, -4.5, 2.5, 0], Extrapolation.CLAMP);
    const y = interpolate(t.value, [SLAM, SLAM + 45, SLAM + 95, SLAM + 145, SLAM + 200], [0, -3.5, 3, -1.5, 0], Extrapolation.CLAMP);
    return { transform: [{ translateX: x }, { translateY: y }] };
  });

  // Where the page's own hero letter sits, so the reveal can hand the grade over to it instead
  // of cutting: the overlay letter flies to it and shrinks to its size as it fades. In landscape
  // the hero letter is in the verdict rail, well up and to the left of a portrait page's.
  const handoffX = (wide ? gutter + L.letterSize * 0.35 : width * 0.28) - width / 2;
  const handoffY = (wide ? space[12] + L.letterSize * 0.5 : height * 0.19) - height / 2;
  const handoffScale = L.letterSize / letterSize;

  const letter = useAnimatedStyle(() => {
    if (reduceMotion) {
      return { opacity: interpolate(t.value, [0, 220], [0, 1], Extrapolation.CLAMP), transform: [{ translateX: 0 }, { translateY: 0 }, { scale: 1 }] };
    }
    const slam = interpolate(t.value, [SLAM, SLAM + 95, SLAM + 200, SLAM + 320], [3.4, 1.08, 0.96, 1], Extrapolation.CLAMP);
    const hand = interpolate(t.value, [BARS_OUT, TOTAL], [0, 1], Extrapolation.CLAMP);
    return {
      opacity: interpolate(t.value, [SLAM - 30, SLAM + 70], [0, 1], Extrapolation.CLAMP),
      transform: [
        { translateX: handoffX * hand },
        { translateY: handoffY * hand },
        { scale: slam * (1 + (handoffScale - 1) * hand) },
      ],
    };
  });

  const meta = useAnimatedStyle(() => ({
    opacity: reduceMotion
      ? interpolate(t.value, [140, 360], [0, 1], Extrapolation.CLAMP)
      : interpolate(t.value, [SLAM + 180, SLAM + 420, BARS_OUT, BARS_OUT + 180], [0, 1, 1, 0], Extrapolation.CLAMP),
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
              <GradeBurstView size={burstSize} color={color} progress={burst} particles={34} testID="grade-burst" />
            </Animated.View>
          )}

          <Animated.Text
            accessibilityRole="header"
            style={[
              styles.letter,
              // a wide stage is short: the line box is tightened to the cap height so the letter
              // and the line under it are one object rather than two things sharing a screen
              { color, fontSize: letterSize, lineHeight: letterSize * (wide ? 0.88 : 1.02), textShadowColor: alpha(color, 0.65) },
              letter,
            ]}>
            {grade}
          </Animated.Text>

          <Animated.View style={[styles.meta, wide && styles.metaWide, meta]}>
            <View style={[styles.ratingRule, { backgroundColor: alpha(color, 0.5) }, wide && styles.ruleWide]} />
            <View style={wide ? styles.metaRow : undefined}>
              <AppText variant="heading" color={color} uppercase style={styles.word}>
                {gradeWord(grade, drifts)}
              </AppText>
              <AppText variant="telemetry" color="text" numeric style={wide ? undefined : styles.rating}>
                {Number.isFinite(rating) ? rating.toFixed(1) : '--'}
                <AppText variant="label" color="muted">
                  {'  '}/ 100
                </AppText>
              </AppText>
            </View>
            <AppText variant="micro" color="muted" style={wide ? styles.kickerWide : styles.kicker}>
              {kicker}
            </AppText>
          </Animated.View>

          <Animated.View style={[styles.hint, judging]} pointerEvents="none">
            <AppText variant="micro" color="ember">
              Judging the run
            </AppText>
          </Animated.View>

          {/* Wide: the meta line ends where a bottom-centred hint would sit, so the hint moves to
              the top-right of the stage — clear of the letter, the meta and the letterbox. */}
          <Animated.View style={[wide ? [styles.skipHintWide, { top: barH + space[3] }] : styles.skipHint, hint]} pointerEvents="none">
            <AppText variant="micro" color="muted">
              Tap to skip
            </AppText>
          </Animated.View>
        </Animated.View>

        {reduceMotion ? null : (
          <>
            <Animated.View style={[styles.barTop, { borderBottomColor: alpha(color, 0.55) }, bar]} pointerEvents="none" />
            <Animated.View style={[styles.barBottom, { borderTopColor: alpha(color, 0.55) }, bar]} pointerEvents="none" />
          </>
        )}
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  root: { backgroundColor: colors.bg0, zIndex: 20 },
  stage: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' },
  // an absolutely positioned sibling paints above static ones on web: the shockwave washed
  // out the bottom half of the grade letter until these two were given an explicit order
  burst: { position: 'absolute', left: '50%', top: '50%', zIndex: 0 },
  letter: {
    zIndex: 2,
    fontFamily: fontFamilies.display.extraboldItalic,
    letterSpacing: -6,
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 48,
    includeFontPadding: false,
  },
  meta: { alignItems: 'center', gap: space[1], marginTop: space[2], zIndex: 2 },
  metaWide: { marginTop: 0 },
  metaRow: { flexDirection: 'row', alignItems: 'baseline', gap: space[5] },
  ratingRule: { width: 64, height: 2, marginBottom: space[3] },
  ruleWide: { width: 180, marginBottom: space[1] },
  word: { letterSpacing: 2 },
  rating: { marginTop: space[1] },
  kicker: { marginTop: space[2] },
  kickerWide: { marginTop: space[1] },
  hint: { position: 'absolute', top: '22%' },
  skipHint: { position: 'absolute', bottom: '14%' },
  skipHintWide: { position: 'absolute', right: gutter },
  // Pure black on purpose, and the only place this screen leaves the palette: the bars have to
  // read as bars against the bg0 stage between them, which they cannot do in bg0. It is the same
  // letterbox device the replay uses, and it is why the harness warns that the corner pixels of
  // `results-reveal-hold` / `results-reveal-slam` are #000000 rather than #07090D.
  barTop: { position: 'absolute', top: 0, left: 0, right: 0, backgroundColor: '#000000', borderTopWidth: 0, borderTopColor: 'transparent' },
  barBottom: { position: 'absolute', bottom: 0, left: 0, right: 0, backgroundColor: '#000000', borderBottomWidth: 0, borderBottomColor: 'transparent' },
  scan: { position: 'absolute', height: 2, opacity: 0 },
});
