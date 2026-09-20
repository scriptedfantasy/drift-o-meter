/**
 * Swipe a session sideways, or hold it, to throw it away.
 *
 * The pan only takes over once the finger has clearly gone sideways (and never once it has
 * gone down), so the list still scrolls normally. Nothing is deleted by the gesture itself:
 * it asks, and the screen puts up a confirmation. A long press does the same thing for anyone
 * who never discovers the swipe — and for a driver wearing gloves.
 */
import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withSpring, withTiming } from 'react-native-reanimated';

import { AppText } from '../Text';
import { alpha, colors, radii, space } from '../theme';

/** How far the row can travel, and how far it has to travel to mean it. */
const TRAVEL = 128;
const COMMIT = 76;

export interface SwipeToDeleteProps {
  children: ReactNode;
  onDelete(): void;
  /** Disabled while a confirmation is already open. */
  enabled?: boolean;
  label?: string;
  testID?: string;
}

export function SwipeToDelete({ children, onDelete, enabled = true, label = 'Delete', testID }: SwipeToDeleteProps) {
  const dx = useSharedValue(0);

  const pan = Gesture.Pan()
    .enabled(enabled)
    .activeOffsetX([-14, 14])
    .failOffsetY([-12, 12])
    .onUpdate((e) => {
      dx.value = Math.max(-TRAVEL, Math.min(0, e.translationX));
    })
    .onEnd(() => {
      if (dx.value <= -COMMIT) {
        dx.value = withTiming(0, { duration: 180 });
        runOnJS(onDelete)();
      } else {
        dx.value = withSpring(0, { damping: 18, stiffness: 220, mass: 0.6 });
      }
    });

  const slide = useAnimatedStyle(() => ({ transform: [{ translateX: dx.value }] }));
  const reveal = useAnimatedStyle(() => ({ opacity: Math.min(1, -dx.value / COMMIT) }));

  return (
    <View style={styles.wrap} testID={testID}>
      <Animated.View style={[styles.behind, reveal]} pointerEvents="none">
        <AppText variant="subheading" color="red" style={styles.behindLabel}>
          {label}
        </AppText>
      </Animated.View>
      <GestureDetector gesture={pan}>
        <Animated.View style={slide}>{children}</Animated.View>
      </GestureDetector>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'relative' },
  behind: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: alpha(colors.red, 0.16),
    borderWidth: 1,
    borderColor: alpha(colors.red, 0.7),
    borderRadius: radii.lg,
    alignItems: 'flex-end',
    justifyContent: 'center',
    paddingRight: space[5],
  },
  behindLabel: { letterSpacing: 2 },
});
