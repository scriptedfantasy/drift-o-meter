/**
 * The grade reveal: letterbox bars close, a beat of black, then the letter SLAMS in with a
 * shockwave and embers, and the screen hands over to the readable page behind it.
 *
 * One shared value (`t`, elapsed milliseconds) drives every element, which buys three things:
 * a tap anywhere can jump `t` to the end (skip), the harness can freeze `t` at a chosen frame
 * for a reproducible screenshot (`?reveal=hold|slam`), and reduce-motion is a different, shorter
 * timeline rather than a pile of conditionals — state changes keep, shake and embers go.
 */
import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, useWindowDimensions, View, type LayoutChangeEvent } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, { cancelAnimation, Easing, Extrapolation, interpolate, runOnJS, useAnimatedStyle, useDerivedValue, useSharedValue, withTiming } from 'react-native-reanimated';

import type { Grade } from '../../engine/types';
import { AppText } from '../Text';
import { alpha, colors, fontFamilies, gutter, space } from '../theme';
import { feelCueWhenReady, gradeCueFor } from '../audio';
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
const BARS_OUT = 1820;
/**
 * When the hand-off lands — and the backdrop does not start going until it has.
 *
 * It used to fly from 1880 to 2280 while the backdrop faded from 2000, so the overlay letter was
 * ~90 % of the way to the hero letter at ~12 % opacity: the grade did not land, it dissolved
 * beside the thing it was being handed to. Everything the flight is for happens in the 300 ms
 * before this mark; the 160 ms after it is the overlay lifting off a letter already in place.
 */
const HANDOFF_END = 2120;
const TOTAL = 2280;

const RM_TOTAL = 1050;

/**
 * Cap height of the display face as a fraction of its font size, measured off the rendered
 * glyph: the hero "S" inks 93 px tall at `fontSize` 133.6 on the shipped web export (0.70).
 * Used to keep the slam's letter inside the stage rather than inside its line box, because the
 * line box is not what a driver reads.
 */
const CAP_HEIGHT_RATIO = 0.7;

/** Frames the harness can freeze on. */
const FROZEN: Partial<Record<RevealMode, number>> = { hold: 640, slam: 1170, settle: 1980 };

export function GradeReveal({ grade, color, rating, kicker, drifts = 1, mode = 'full', reduceMotion = false, onDone, testID }: GradeRevealProps) {
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
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
  const burstSize = (wide ? Math.min(width * 0.78, height * 1.7) : Math.min(width * 1.5, height * 0.9)) * 0.5;
  const barH = Math.round(height * (wide ? 0.13 : 0.18));
  // What the letterbox leaves open. The burst's canvas is cropped to it — a blurred draw costs
  // its pixels whether or not they are on screen, and at 852 x 393 a square 664 dp canvas spent
  // 41 % of every blur behind the bars.
  const stageH = Math.max(120, height - barH * 2);
  const burstH = Math.min(burstSize, stageH) * 0.5;

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
  //
  // AND THE LATCH IS SET BY THE ANSWER, NOT BEFORE THE QUESTION. This used to read
  // `gradeHeard.current = true; feelCue(...)`, and `feelCue` is a no-op until the sound ports
  // are attached — so a reveal that beat the bank's 21 decodes marked itself heard and never
  // tried again. That is not a rare race: on native the garage never mounts `useDriftFeel`, so
  // nothing starts loading until `/results` mounts, and this screen's slam is 900 ms after that.
  // Measured on the shipped web export with every `.wav` delayed 2.5 s: the last decode landed
  // at 3083 ms, the slam at ~1900 ms, and the page made no sound at all — a later tap did not
  // recover it either, because the latch was already set. The fix is the call, not the order:
  // `feelCueWhenReady` takes the cue now if it can and HOLDS it otherwise, so there is no longer
  // a path where the reveal asks and nothing hears it.
  //
  // THE HOLD IS NOT CANCELLED HERE, deliberately. This overlay's whole life is 2.28 s and the
  // wait it is covering was measured at 3.0–3.3 s, so cancelling on unmount would throw the cue
  // away a second before the ports came up — the same silence by a different route. The hold
  // belongs to the RESULTS SCREEN, which is what mounts the feel layer, and `useDriftFeel`'s own
  // unmount drops it: navigate away and no grade arrives over the next screen.
  const gradeCue = useRef<ReturnType<typeof setTimeout> | null>(null);
  const gradeHeard = useRef(false);
  const hearGrade = () => {
    if (gradeHeard.current) return;
    if (gradeCue.current) clearTimeout(gradeCue.current);
    gradeCue.current = null;
    // Latched HERE and not a line earlier than it used to be, because `feelCueWhenReady` cannot
    // drop the cue the way `feelCue` could: it either plays it now or holds it until the ports
    // attach. The latch means "this reveal has asked, once", and now that is true either way.
    // A tap takes this same path, so the skip still plays the grade the instant it is tapped.
    gradeHeard.current = true;
    feelCueWhenReady(gradeCueFor(grade));
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

  /**
   * How big the letter is on the frame it lands, bounded by the frame it lands on.
   *
   * It was a flat 3.4x. In landscape that is a 721 dp letter on a 393 dp stage at partial
   * opacity, under a white flash disc and a 19 dp ring — the first ~200 ms of the reveal was not
   * a letter at all, it was a glossy bubble over an amber smear. NFS punches the grade oversize
   * and keeps it READABLE, which means the cap height stays inside the open stage. 3.4x survives
   * where there is room for it (portrait lands at ~3.2x); a landscape phone gets ~2.0x, which is
   * the number that frame can actually show.
   */
  const slamFrom = Math.max(1.6, Math.min(3.4, stageH / (CAP_HEIGHT_RATIO * letterSize)));

  const burst = useDerivedValue(() => (reduceMotion ? 0 : Math.max(0, Math.min(1, (t.value - SLAM) / BURST_MS))));

  const backdrop = useAnimatedStyle(() =>
    reduceMotion
      ? { opacity: interpolate(t.value, [0, 80, RM_TOTAL - 260, RM_TOTAL], [1, 1, 1, 0], Extrapolation.CLAMP) }
      : { opacity: interpolate(t.value, [0, 40, HANDOFF_END, TOTAL], [1, 1, 1, 0], Extrapolation.CLAMP) },
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

  /**
   * Where the page's own hero letter sits, so the reveal can hand the grade over to it instead of
   * dissolving next to it.
   *
   * THE TARGET IS THE LAYOUT'S, NOT A GUESS. This read `gutter + letterSize * 0.35` in landscape
   * and `width * 0.28` in portrait — 66.8 dp and 110 dp against a hero letter whose ink centre is
   * at ≈50 dp and ≈54 dp. One frame of the flight showed both letters at once, 44 dp apart.
   *
   * And it is measured, not modelled. The overlay letter reports its own line box through
   * `onLayout`; the hero letter's box is the same glyph in the same face, so its width is that
   * width times the size ratio and its height is `letterSize × letterLineRatio`. Aligning the two
   * BOX CENTRES and scaling by the size ratio puts the ink on the ink: with `includeFontPadding`
   * off, half-leading is symmetric, so a glyph's ink offset from its own box centre scales with
   * its font size whatever the line height either box was given.
   */
  const [ovBox, setOvBox] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const handoffScale = L.letterSize / letterSize;
  // `L` is measured inside the safe area; the reveal covers the whole screen.
  const heroLeft = insets.left + L.heroLetterLeft;
  const heroTop = insets.top + L.heroLetterTop;
  const heroCentreX = heroLeft + ((ovBox?.width ?? letterSize * 0.4) * handoffScale) / 2;
  const heroCentreY = heroTop + (L.letterSize * L.letterLineRatio) / 2;
  const handoffX = ovBox ? heroCentreX - (ovBox.x + ovBox.width / 2) : 0;
  const handoffY = ovBox ? heroCentreY - (ovBox.y + ovBox.height / 2) : 0;

  const letter = useAnimatedStyle(() => {
    if (reduceMotion) {
      return { opacity: interpolate(t.value, [0, 220], [0, 1], Extrapolation.CLAMP), transform: [{ translateX: 0 }, { translateY: 0 }, { scale: 1 }] };
    }
    const slam = interpolate(t.value, [SLAM, SLAM + 95, SLAM + 200, SLAM + 320], [slamFrom, 1.08, 0.96, 1], Extrapolation.CLAMP);
    const hand = interpolate(t.value, [BARS_OUT, HANDOFF_END], [0, 1], Extrapolation.CLAMP);
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
            <Animated.View style={[styles.burst, { width: burstSize, height: burstH, marginLeft: -burstSize / 2, marginTop: -burstH / 2 }, burstStyle]} pointerEvents="none">
              {/* 22, not 34. Each ember is a blurred draw and the count is what the reveal's
                  dropped frames were made of; 22 still fills the front without a gap in it. */}
              <GradeBurstView size={burstSize} height={burstH} color={color} progress={burst} particles={22} testID="grade-burst" />
            </Animated.View>
          )}

          <Animated.Text
            accessibilityRole="header"
            // its own line box, so the hand-off aims at the hero letter's box rather than at a
            // fraction of the frame — the stage is centred, the letter is not
            onLayout={(e: LayoutChangeEvent) => {
              const b = e.nativeEvent.layout;
              setOvBox((p) => (p && p.x === b.x && p.y === b.y && p.width === b.width && p.height === b.height ? p : { x: b.x, y: b.y, width: b.width, height: b.height }));
            }}
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
