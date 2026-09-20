/**
 * The frame around the HUD: ambient ember bloom at the screen edges, the status strip
 * (clock, lap, source, GPS / mount pills) and the integrity banner.
 *
 * Integrity is deliberately two-speed. While the run is clean the verdicts are two small
 * outline pills that nobody has to read; the moment the mount goes loose, the physics stop
 * adding up or GPS is lost, a full-width banner takes over with the engine's plain-language
 * message. Nothing in between shouts.
 *
 * The bloom is clipped to a rounded rectangle, which both matches the phone's own corners and
 * keeps the extreme corner pixels at bg0 (the harness checks them).
 */
import { LinearGradient } from 'expo-linear-gradient';
import { memo } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { useAnimatedStyle, useDerivedValue, withRepeat, withTiming } from 'react-native-reanimated';

import { AppText, Micro } from '../Text';
import { formatDuration } from '../format';
import { alpha, colors, fontFamilies, radii, space } from '../theme';
import type { HudSignals } from './signals';
import type { HudSnapshot } from './useDriveRun';

const TRANSPARENT = 'rgba(255,90,31,0)';

export const EdgeBloom = memo(function EdgeBloom({ signals }: { signals: HudSignals }) {
  const bloom = useAnimatedStyle(() => ({ opacity: 0.06 + 0.94 * signals.intensity.value }));
  const flash = useAnimatedStyle(() => ({ opacity: 0.22 * signals.flash.value }));
  return (
    <View style={styles.bloomClip} pointerEvents="none">
      <Animated.View style={[StyleSheet.absoluteFill, bloom]}>
        <LinearGradient colors={[alpha(colors.ember, 0.22), TRANSPARENT]} style={[styles.bloomEdge, styles.bloomTop]} />
        <LinearGradient colors={[TRANSPARENT, alpha(colors.ember, 0.26)]} style={[styles.bloomEdge, styles.bloomBottom]} />
        <LinearGradient colors={[alpha(colors.ember, 0.2), TRANSPARENT]} start={{ x: 0, y: 0.5 }} end={{ x: 1, y: 0.5 }} style={[styles.bloomEdge, styles.bloomLeft]} />
        <LinearGradient colors={[TRANSPARENT, alpha(colors.ember, 0.2)]} start={{ x: 0, y: 0.5 }} end={{ x: 1, y: 0.5 }} style={[styles.bloomEdge, styles.bloomRight]} />
      </Animated.View>
      <Animated.View style={[StyleSheet.absoluteFill, styles.flash, flash]} />
    </View>
  );
});

export interface StatusStripProps {
  snapshot: HudSnapshot;
  sourceLabel: string | null;
  testID?: string;
}

export const StatusStrip = memo(function StatusStrip({ snapshot, sourceLabel, testID }: StatusStripProps) {
  const gps = snapshot.integrity.gps;
  const mount = snapshot.integrity.mount;
  return (
    <View style={styles.strip} testID={testID}>
      <View style={styles.stripLeft}>
        <AppText numeric style={styles.clock}>
          {formatDuration(snapshot.elapsedS)}
        </AppText>
        <View style={styles.lap}>
          <Micro>Lap</Micro>
          <AppText numeric style={styles.lapValue}>
            {snapshot.lapCount + 1}
          </AppText>
        </View>
      </View>
      <View style={styles.stripRight}>
        <Pill
          label={gps === 'good' ? 'GPS' : gps === 'poor' ? 'GPS WEAK' : 'NO GPS'}
          color={gps === 'good' ? colors.cyan : gps === 'poor' ? colors.gold : colors.red}
          filled={gps !== 'good'}
        />
        {mount === 'rigid' ? null : <Pill label={mount === 'loose' ? 'MOUNT LOOSE' : 'MOUNT SHAKING'} color={mount === 'loose' ? colors.red : colors.gold} filled />}
        {sourceLabel ? <Pill label={sourceLabel} color={colors.muted} /> : null}
      </View>
    </View>
  );
});

function Pill({ label, color, filled = false }: { label: string; color: string; filled?: boolean }) {
  return (
    <View style={[styles.pill, { borderColor: alpha(color, filled ? 0.9 : 0.45), backgroundColor: filled ? alpha(color, 0.2) : 'transparent' }]}>
      <AppText variant="micro" color={color} style={styles.pillText}>
        {label}
      </AppText>
    </View>
  );
}

/** The loud half of integrity: only mounted when something is actually wrong. */
export const IntegrityBanner = memo(function IntegrityBanner({ snapshot, testID }: { snapshot: HudSnapshot; testID?: string }) {
  const { mount, gps, physics, message } = snapshot.integrity;
  const severe = mount === 'loose' || gps === 'none' || physics === 'implausible';
  const warn = mount === 'suspect' || gps === 'poor';
  const pulse = useDerivedValue(() => withRepeat(withTiming(1, { duration: 900 }), -1, true), []);
  const style = useAnimatedStyle(() => ({ opacity: 0.72 + 0.28 * pulse.value }));
  if (!severe && !warn) return null;
  const tone = severe ? colors.red : colors.gold;
  const heading = mount === 'loose' ? 'LOOSE MOUNT' : mount === 'suspect' ? 'MOUNT SHAKING' : gps === 'none' ? 'GPS LOST' : gps === 'poor' ? 'WEAK GPS' : 'IMPLAUSIBLE READINGS';
  return (
    <Animated.View style={[styles.banner, { borderColor: alpha(tone, 0.85), backgroundColor: alpha(tone, 0.16) }, style]} testID={testID}>
      <View style={[styles.bannerBar, { backgroundColor: tone }]} />
      <View style={styles.bannerText}>
        <AppText style={[styles.bannerHeading, { color: tone }]}>{heading}</AppText>
        <AppText variant="small" color={colors.text} numberOfLines={2}>
          {message}
        </AppText>
      </View>
    </Animated.View>
  );
});

const styles = StyleSheet.create({
  bloomClip: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, borderRadius: 46, overflow: 'hidden' },
  bloomEdge: { position: 'absolute' },
  bloomTop: { top: 0, left: 0, right: 0, height: 86 },
  bloomBottom: { bottom: 0, left: 0, right: 0, height: 110 },
  bloomLeft: { top: 0, bottom: 0, left: 0, width: 54 },
  bloomRight: { top: 0, bottom: 0, right: 0, width: 54 },
  flash: { backgroundColor: colors.magenta },

  strip: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space[3] },
  stripLeft: { flexDirection: 'row', alignItems: 'baseline', gap: space[3] },
  stripRight: { flexDirection: 'row', alignItems: 'center', gap: space[2], flexShrink: 1, flexWrap: 'wrap', justifyContent: 'flex-end' },
  clock: { fontFamily: fontFamilies.display.bold, fontSize: 22, lineHeight: 24, color: colors.text, letterSpacing: 0.4 },
  lap: { flexDirection: 'row', alignItems: 'baseline', gap: space[1] },
  lapValue: { fontFamily: fontFamilies.display.bold, fontSize: 18, lineHeight: 20, color: colors.muted },
  pill: { borderWidth: 1, borderRadius: radii.pill, paddingHorizontal: space[2], paddingVertical: 2 },
  pillText: { fontSize: 10, lineHeight: 13 },

  banner: { flexDirection: 'row', alignItems: 'center', gap: space[3], borderWidth: 1, borderRadius: radii.md, padding: space[2], paddingRight: space[3] },
  bannerBar: { width: 4, alignSelf: 'stretch', borderRadius: 2 },
  bannerText: { flex: 1, gap: 1 },
  bannerHeading: { fontFamily: fontFamilies.display.extraboldItalic, fontSize: 20, lineHeight: 22, letterSpacing: 0.4 },
});
