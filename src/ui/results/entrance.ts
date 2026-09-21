/**
 * Entrance motion for the review's blocks: fade and rise, once the page is up.
 *
 * `useFill` lived here too — a bar that grew to a 0..100 sub-score. There are no sub-scores and
 * no bars, so it went with them rather than staying as a hook nothing calls.
 */
import { useEffect } from 'react';
import { Easing, useAnimatedStyle, useSharedValue, withDelay, withTiming, type AnimatedStyle } from 'react-native-reanimated';
import type { ViewStyle } from 'react-native';

const OUT = Easing.bezier(0.16, 1, 0.3, 1);

/** Fade + rise, once `run` is true. Reduce-motion keeps the fade and drops the movement. */
export function useEnter(delay: number, run: boolean, reduceMotion = false): AnimatedStyle<ViewStyle> {
  const p = useSharedValue(0);
  useEffect(() => {
    if (!run) {
      p.value = 0;
      return;
    }
    p.value = withDelay(reduceMotion ? 0 : delay, withTiming(1, { duration: reduceMotion ? 180 : 420, easing: OUT }));
  }, [run, delay, reduceMotion, p]);
  return useAnimatedStyle(() => ({ opacity: p.value, transform: [{ translateY: reduceMotion ? 0 : (1 - p.value) * 18 }] }));
}
