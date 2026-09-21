/**
 * The grade slot of a session row — and the one state that is not a grade.
 *
 * When the engine refuses to vouch for a run (`SessionIntegrity.scoreTrusted === false`) the
 * list may not show a letter, so it shows the same red NOT SCORED plate the results screen
 * shows, at row scale. Until the run's verdict has been read off disk the slot is a skeleton:
 * the alternative is guessing, and guessing here means printing an achievement that the engine
 * has already refused.
 *
 * The rule itself lives in `grade.ts`, so it can be tested without a renderer.
 */
import { useEffect } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { useAnimatedStyle, useReducedMotion, useSharedValue, withTiming } from 'react-native-reanimated';

import { AppText } from '../Text';
import { easings } from '../motion';
import { alpha, colors, gradeColors, motion, radii, space } from '../theme';
import { gradeStateColor, gradeStateOf, type GradeState } from './grade';

export { gradeStateColor, gradeStateOf };
export type { GradeState };

export interface GradeBadgeProps {
  state: GradeState;
  /** Cap height of the letter in dp. The plate and the skeleton scale with it. */
  size: number;
  /** Punch the letter in when it first appears. The last-run card asks for it; rows do not. */
  animate?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function GradeBadge({ state, size, animate = false, style, testID }: GradeBadgeProps) {
  const grade = state.kind === 'grade' ? state.grade : null;
  const reduced = useReducedMotion();
  // One shared value, whatever the branch below renders: hooks may not be conditional.
  const scale = useSharedValue(1);
  useEffect(() => {
    if (!animate || reduced || grade === null) {
      scale.value = 1;
      return;
    }
    // The grade you just earned, arriving: over-large for an instant, then settling.
    scale.value = 1.34;
    scale.value = withTiming(1, { duration: motion.duration.slow, easing: easings.overshoot });
  }, [animate, grade, reduced, scale]);
  const punch = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  if (state.kind === 'void') {
    const word = Math.max(11, size * 0.26);
    return (
      <View style={[styles.plate, { borderRadius: radii.sm, paddingHorizontal: word * 0.45, paddingVertical: word * 0.22, width: size * 0.92 }, style]} testID={testID ?? 'not-scored'}>
        <AppText variant="display" color="red" style={[styles.word, { fontSize: word, lineHeight: word * 0.98 }]}>
          NOT
        </AppText>
        <AppText variant="display" color="red" style={[styles.word, { fontSize: word, lineHeight: word * 0.98 }]}>
          SCORED
        </AppText>
      </View>
    );
  }
  if (state.kind === 'pending') {
    return <View style={[styles.pending, { width: size * 0.8, height: size * 0.8, borderRadius: radii.sm }, style]} testID={testID} />;
  }
  const color = gradeColors[state.grade] ?? colors.muted;
  // No `numberOfLines`: on web that clips the element, and the letter's glow with it.
  return (
    <Animated.View style={[styles.box, { width: size * 1.06 }, style, punch]} testID={testID}>
      <AppText
        variant="hero"
        color={color}
        style={[
          styles.letter,
          { fontSize: size, lineHeight: size * 1.02, letterSpacing: -size * 0.05, textShadowColor: color, textShadowRadius: size * 0.26 },
        ]}>
        {state.grade}
      </AppText>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  box: { alignItems: 'center', justifyContent: 'center' },
  letter: { textShadowOffset: { width: 0, height: 0 }, includeFontPadding: false, textAlign: 'center' },
  plate: { borderWidth: 2, borderColor: colors.red, alignItems: 'center', justifyContent: 'center', backgroundColor: alpha(colors.red, 0.08) },
  word: { letterSpacing: -0.5, textAlign: 'center' },
  pending: { backgroundColor: colors.bg2, borderWidth: 1, borderColor: colors.line, marginVertical: space[1] },
});
