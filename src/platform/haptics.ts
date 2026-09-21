/**
 * Native haptic port — expo-haptics 57. (Web: `haptics.web.ts`.)
 *
 * Written against the installed declarations, not from memory:
 *   node_modules/expo-haptics/build/Haptics.d.ts        impactAsync(style?), notificationAsync(type?)
 *   node_modules/expo-haptics/build/Haptics.types.d.ts  ImpactFeedbackStyle {Light, Medium, Heavy,
 *                                                       Soft, Rigid}, NotificationFeedbackType
 *                                                       {Success, Warning, Error}
 *
 * Both calls return a Promise that rejects with `UnavailabilityError` on a device with no haptic
 * engine, so every call here is fire-and-forget with a `.catch`. A phone that cannot buzz must
 * not take the run down with it.
 *
 * The mapping from event to style lives in `src/ui/audio/bank.ts`, beside the mapping from event
 * to clip, so there is one taxonomy for the whole feel layer rather than two that drift apart.
 * This file only translates the vocabulary into the SDK's enums.
 */
import * as Haptics from 'expo-haptics';

import type { HapticPort } from './audioTypes';

const IMPACTS = {
  light: Haptics.ImpactFeedbackStyle.Light,
  medium: Haptics.ImpactFeedbackStyle.Medium,
  heavy: Haptics.ImpactFeedbackStyle.Heavy,
  soft: Haptics.ImpactFeedbackStyle.Soft,
  rigid: Haptics.ImpactFeedbackStyle.Rigid,
} as const;

const NOTIFICATIONS = {
  success: Haptics.NotificationFeedbackType.Success,
  warning: Haptics.NotificationFeedbackType.Warning,
  error: Haptics.NotificationFeedbackType.Error,
} as const;

export interface PreparedHapticPort extends HapticPort {
  readonly available: boolean;
  describe(): string;
  /** The last few shapes asked for. Empty on native: the phone itself is the record. */
  recent(): readonly string[];
}

export function createHapticPort(): PreparedHapticPort {
  return {
    available: true,
    impact(shape) {
      Haptics.impactAsync(IMPACTS[shape]).catch(() => {});
    },
    notify(shape) {
      Haptics.notificationAsync(NOTIFICATIONS[shape]).catch(() => {});
    },
    describe() {
      return 'expo-haptics · UIImpactFeedbackGenerator / UINotificationFeedbackGenerator';
    },
    recent() {
      return [];
    },
  };
}
