/**
 * Callouts and banners — the loud part of the HUD.
 *
 * A callout SLAMS in (scale 1.8 → 1.0 with overshoot over 320 ms, sliding in from the side),
 * holds, then recedes as newer ones push it down the stack. Up to three are on screen; the
 * stack itself is owned by `useDriveRun` and expires by RECORDING time, so a frozen frame keeps
 * whatever had just fired.
 *
 * `ScoreBanner` is the chain verdict: "BANKED +1,240" rising over 900 ms in green, or
 * "CHAIN LOST −2,345" in red.
 */
import { useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withDelay, withSpring, withTiming } from 'react-native-reanimated';

import { AppText, Micro } from '../Text';
import { alpha, colors, fontFamilies, motion, radii, space } from '../theme';
import { easings } from '../motion';
import type { EventTone, HudBanner, HudEvent } from './useDriveRun';

const TONES: Record<EventTone, string> = {
  ember: colors.ember,
  magenta: colors.magenta,
  gold: colors.gold,
  green: colors.green,
  cyan: colors.cyan,
  red: colors.red,
};

export interface CalloutStackProps {
  events: HudEvent[];
  /** Slam in from the right instead of the left. */
  fromRight?: boolean;
  size?: number;
  testID?: string;
}

export function CalloutStack({ events, fromRight = false, size = 26, testID }: CalloutStackProps) {
  return (
    <View style={[styles.stack, fromRight && styles.stackRight]} pointerEvents="none" testID={testID}>
      {events.map((e, i) => (
        <Callout key={e.key} event={e} depth={i} fromRight={fromRight} size={size} />
      ))}
    </View>
  );
}

function Callout({ event, depth, fromRight, size }: { event: HudEvent; depth: number; fromRight: boolean; size: number }) {
  const tone = TONES[event.tone];
  const enter = useSharedValue(0);
  const depthV = useSharedValue(depth);

  useEffect(() => {
    enter.value = 0;
    enter.value = withTiming(1, { duration: motion.duration.base, easing: easings.overshoot });
  }, [enter]);

  useEffect(() => {
    depthV.value = withTiming(depth, { duration: motion.duration.base, easing: easings.out });
  }, [depth, depthV]);

  const style = useAnimatedStyle(() => {
    const p = enter.value;
    const scale = 1.8 - 0.8 * p;
    const slide = (1 - p) * (fromRight ? 64 : -64);
    return {
      opacity: Math.min(1, p * 3) * (1 - 0.2 * depthV.value),
      transform: [{ translateX: slide }, { scale }],
    };
  });

  return (
    <Animated.View style={[styles.callout, fromRight && styles.calloutRight, { backgroundColor: alpha(tone, 0.12) }, style]}>
      <View style={[styles.bar, { backgroundColor: tone }]} />
      <AppText numberOfLines={1} style={[styles.label, { fontSize: size, lineHeight: size * 1.02, color: tone, textShadowColor: alpha(tone, 0.85) }]}>
        {event.label}
      </AppText>
      {event.points > 0 ? (
        <AppText numeric style={[styles.points, { fontSize: size * 0.66, lineHeight: size * 1.02, color: alpha(tone, 0.85) }]}>
          +{Math.round(event.points).toLocaleString('en-US')}
        </AppText>
      ) : null}
    </Animated.View>
  );
}

export interface ScoreBannerProps {
  banner: HudBanner | null;
  size?: number;
  align?: 'left' | 'right';
}

export function ScoreBanner({ banner, size = 30, align = 'left' }: ScoreBannerProps) {
  if (!banner) return null;
  return <Banner key={banner.key} banner={banner} size={size} align={align} />;
}

function Banner({ banner, size, align }: { banner: HudBanner; size: number; align: 'left' | 'right' }) {
  const rise = useSharedValue(0);
  const [shown, setShown] = useState(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const banked = banner.kind === 'banked';
  const tone = banked ? colors.green : colors.red;

  useEffect(() => {
    rise.value = 0;
    rise.value = withTiming(1, { duration: motion.duration.cinematic, easing: easings.out });
  }, [rise]);

  // The points TICK UP over 420 ms: 14 renders of one text node, not a jump cut.
  useEffect(() => {
    const steps = 14;
    let i = 0;
    setShown(0);
    timer.current = setInterval(() => {
      i++;
      setShown(Math.round((banner.points * i) / steps));
      if (i >= steps && timer.current) clearInterval(timer.current);
    }, 30);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [banner.points]);

  const style = useAnimatedStyle(() => ({
    opacity: Math.min(1, rise.value * 4),
    transform: [{ translateY: (1 - rise.value) * 26 }],
  }));

  return (
    <Animated.View style={[styles.banner, align === 'right' && styles.bannerRight, style]}>
      <AppText style={[styles.bannerText, { fontSize: size, lineHeight: size * 1.05, color: tone, textShadowColor: alpha(tone, 0.8) }]} numeric>
        {banked ? 'BANKED +' : 'CHAIN LOST −'}
        {shown.toLocaleString('en-US')}
      </AppText>
    </Animated.View>
  );
}

/** A quiet line that says what the HUD is waiting for, when nothing is happening. */
export function HudHint({ text }: { text: string }) {
  const pulse = useSharedValue(0);
  useEffect(() => {
    pulse.value = withDelay(400, withSpring(1, { damping: 14, stiffness: 90 }));
  }, [pulse]);
  const style = useAnimatedStyle(() => ({ opacity: 0.35 + 0.35 * pulse.value }));
  return (
    <Animated.View style={style}>
      <Micro>{text}</Micro>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  stack: { alignItems: 'flex-start', gap: space[2] },
  stackRight: { alignItems: 'flex-end' },
  callout: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[2],
    paddingVertical: space[1],
    paddingRight: space[3],
    paddingLeft: space[2],
    borderRadius: radii.sm,
    transformOrigin: 'left center',
  },
  calloutRight: { transformOrigin: 'right center' },
  bar: { width: 3, alignSelf: 'stretch', borderRadius: 2 },
  label: { fontFamily: fontFamilies.display.extraboldItalic, letterSpacing: 0.4, textShadowOffset: { width: 0, height: 0 }, textShadowRadius: 14 },
  points: { fontFamily: fontFamilies.display.boldItalic },
  banner: { alignSelf: 'flex-start' },
  bannerRight: { alignSelf: 'flex-end' },
  bannerText: { fontFamily: fontFamilies.display.extraboldItalic, letterSpacing: 0.5, textShadowOffset: { width: 0, height: 0 }, textShadowRadius: 18 },
});
