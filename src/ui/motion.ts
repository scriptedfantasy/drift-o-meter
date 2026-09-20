/** Reanimated bindings for the motion tokens in `theme.ts`. */
import { Easing, type WithTimingConfig } from 'react-native-reanimated';

import { motion } from './theme';

function bezier(points: readonly [number, number, number, number]) {
  return Easing.bezier(points[0], points[1], points[2], points[3]);
}

export const easings = {
  out: bezier(motion.easing.out),
  inOut: bezier(motion.easing.inOut),
  in: bezier(motion.easing.in),
  overshoot: bezier(motion.easing.overshoot),
  linear: Easing.linear,
};

/** Ready-made `withTiming` configs. */
export const timing: Record<keyof typeof motion.duration, WithTimingConfig> = {
  fast: { duration: motion.duration.fast, easing: easings.out },
  base: { duration: motion.duration.base, easing: easings.out },
  slow: { duration: motion.duration.slow, easing: easings.inOut },
  cinematic: { duration: motion.duration.cinematic, easing: easings.inOut },
};
