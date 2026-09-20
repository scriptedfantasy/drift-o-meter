/**
 * The session total, counting up.
 *
 * The digits themselves are the DRIVE DISPLAY's odometer (`src/ui/hud/Odometer.tsx`), not a
 * second implementation of one: it worked out the three rules that keep a rolling number
 * legible — only the units column spins, every column above it carries in the last 4 % of the
 * decade below, and each window is fade-masked so a glyph leaving it dissolves instead of being
 * sliced — and a driver should not meet two different odometers in one app.
 *
 * What lives here is the only thing the results screen needs on top: a value that counts from
 * zero to the session total once, when the page is allowed to start. (The HUD's third rule,
 * filtering at sample rate rather than re-aiming a tween, is about a value that keeps moving;
 * this one has a known target, so a single tween is right.)
 *
 * `background` is the surface the number sits on, because the fade masks paint it: pass the
 * colour actually behind the digits or the mask leaves a rectangle.
 */
import { useEffect } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { cancelAnimation, Easing, useSharedValue, withTiming } from 'react-native-reanimated';

import HudOdometer from '../hud/Odometer';
import { colors } from '../theme';

export interface OdometerProps {
  /** Final value. */
  value: number;
  /** Start the roll. While false the odometer waits at zero — it must never flash the answer. */
  run?: boolean;
  durationMs?: number;
  fontSize: number;
  color?: string;
  /** The surface behind the digits; the fade masks are drawn in it. */
  background?: string;
  /** Keep the digits still: the value arrives quickly instead of rolling. */
  reduceMotion?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function Odometer({
  value,
  run = true,
  durationMs = 1300,
  fontSize,
  color = colors.ember,
  background = colors.bg0,
  reduceMotion = false,
  style,
  testID,
}: OdometerProps) {
  const target = Math.max(0, Math.round(Number.isFinite(value) ? value : 0));
  const v = useSharedValue(0);
  const columns = Math.min(7, Math.max(1, String(target).length));

  useEffect(() => {
    cancelAnimation(v);
    if (!run) {
      // waiting behind the reveal: zero, never a glimpse of the total before it counts up
      v.value = 0;
      return;
    }
    v.value = 0;
    v.value = withTiming(target, { duration: reduceMotion ? 320 : durationMs, easing: Easing.bezier(0.16, 1, 0.3, 1) });
  }, [run, target, durationMs, reduceMotion, v]);

  return (
    <View style={style} accessibilityLabel={`${target} points`}>
      <HudOdometer value={v} columns={columns} size={fontSize} color={color} background={background} testID={testID} />
    </View>
  );
}
