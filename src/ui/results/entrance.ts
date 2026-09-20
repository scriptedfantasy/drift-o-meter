/** Entrance motion shared by the results sections: fade-up, and bars that fill. */
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

/** A bar that fills to `value` (0..1) once `run` is true. */
export function useFill(value: number, delay: number, run: boolean, reduceMotion = false): AnimatedStyle<ViewStyle> {
  const target = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
  const w = useSharedValue(0);
  useEffect(() => {
    if (!run) {
      w.value = 0;
      return;
    }
    w.value = withDelay(reduceMotion ? 0 : delay, withTiming(target, { duration: reduceMotion ? 220 : 820, easing: OUT }));
  }, [run, target, delay, reduceMotion, w]);
  return useAnimatedStyle(() => ({ width: `${w.value * 100}%` }));
}
