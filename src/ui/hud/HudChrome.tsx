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
import Animated, { useAnimatedStyle, useDerivedValue, useReducedMotion, withRepeat, withTiming } from 'react-native-reanimated';

import { AppText, Micro } from '../Text';
import { formatDuration } from '../format';
import { alpha, colors, fontFamilies, radii, space } from '../theme';
import type { HudSignals } from './signals';
import type { HudSnapshot } from './useDriveRun';

const TRANSPARENT = 'rgba(255,90,31,0)';

export const EdgeBloom = memo(function EdgeBloom({ signals }: { signals: HudSignals }) {
  const bloom = useAnimatedStyle(() => ({ opacity: 0.06 + 0.94 * signals.intensity.value }));
  const flash = useAnimatedStyle(() => ({ opacity: 0.18 * signals.flash.value }));
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
  /** Health verdicts are only meaningful once samples are flowing. */
  live?: boolean;
  testID?: string;
}

export const StatusStrip = memo(function StatusStrip({ snapshot, sourceLabel, live = true, testID }: StatusStripProps) {
  const gps = snapshot.integrity.gps;
  const mount = snapshot.integrity.mount;
  const tier = live ? readIntegrity(snapshot).tier : 'ok';
  // One row, always: when there is something wrong to say, the source chip gives up its space
  // rather than wrapping the strip onto a second line and pushing STOP off the screen.
  const showSource = tier === 'ok' || tier === 'calibrating';
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
        {live ? (
          <Pill
            label={gps === 'good' ? 'GPS' : gps === 'poor' ? 'GPS WEAK' : snapshot.gpsEverGood ? 'GPS LOST' : 'NO GPS YET'}
            color={gps === 'good' ? colors.cyan : gps === 'none' && snapshot.gpsEverGood ? colors.red : colors.text}
            filled={gps === 'none' && snapshot.gpsEverGood}
          />
        ) : null}
        {!live || mount === 'rigid' || (!snapshot.forwardResolved && mount !== 'loose') ? null : (
          <Pill label={mount === 'loose' ? 'MOUNT LOOSE' : 'MOUNT SHAKING'} color={mount === 'loose' ? colors.red : colors.text} filled={mount === 'loose'} />
        )}
        {sourceLabel && showSource ? <Pill label={sourceLabel} color={colors.muted} /> : null}
      </View>
    </View>
  );
});

function Pill({ label, color, filled = false }: { label: string; color: string; filled?: boolean }) {
  return (
    <View style={[styles.pill, { borderColor: alpha(color, filled ? 0.9 : 0.45), backgroundColor: filled ? alpha(color, 0.2) : 'transparent' }]}>
      <AppText variant="micro" color={color} style={styles.pillText} numberOfLines={1}>
        {label}
      </AppText>
    </View>
  );
}

/**
 * The live drift strip: what the slide in progress has earned so far — peak angle, how long it
 * has been held, how many times it has been flicked. It sits under the gauge, where the callout
 * stack lands, so the middle of the screen always says something instead of going black between
 * callouts. All three values step slowly enough for the 10 Hz snapshot.
 */
export const DriftStrip = memo(function DriftStrip({ snapshot, testID }: { snapshot: HudSnapshot; testID?: string }) {
  const live = snapshot.phase !== 'idle' && snapshot.phase !== 'exit';
  const chained = snapshot.chainActive && snapshot.chainPoints > 0;
  if (!live) {
    return (
      <View style={styles.stripRow} testID={testID}>
        <AppText variant="micro" color={chained ? colors.ember : colors.muted} style={styles.hint}>
          {chained ? 'CHAIN OPEN — GET BACK SIDEWAYS TO KEEP IT' : 'WAITING FOR A SLIDE'}
        </AppText>
      </View>
    );
  }
  // An untrusted reading gets untrusted numbers: same values, no colour claiming they are good.
  const trusted = snapshot.trust > 0;
  return (
    <View style={styles.stripRow} testID={testID}>
      <StripCell label="Peak" value={`${Math.round(snapshot.peakDeg)}°`} tone={trusted ? colors.gold : colors.muted} />
      <StripCell label="Held" value={`${snapshot.driftDurationS.toFixed(1)}s`} tone={trusted ? colors.text : colors.muted} />
      <StripCell label="Flicks" value={`×${snapshot.transitions}`} tone={trusted && snapshot.transitions > 0 ? colors.magenta : colors.muted} last />
    </View>
  );
});

function StripCell({ label, value, tone, last }: { label: string; value: string; tone: string; last?: boolean }) {
  return (
    <View style={[styles.cell, !last && styles.cellBorder]}>
      <Micro>{label}</Micro>
      <AppText numeric style={[styles.cellValue, { color: tone }]}>
        {value}
      </AppText>
    </View>
  );
}

/**
 * What integrity is saying, and how loudly. ONE function decides both, because deriving the
 * tone from one field and the headline from another is how every run used to open with a red
 * alarm titled MOUNT SHAKING while the actual condition was "no GPS lock yet".
 *
 * Until the calibrator has resolved which way the car points, no mount verdict means anything —
 * the monitor is describing its own startup, so the HUD says that, calmly, in cyan.
 */
export type IntegrityTier = 'ok' | 'calibrating' | 'warn' | 'severe';

export interface IntegrityView {
  tier: IntegrityTier;
  heading: string;
  message: string;
  /**
   * What the score block should admit, or null when the numbers can be taken at face value.
   * Deliberately specific: with no fix the scorer really is not counting, while with a loose
   * mount it IS counting points off a reading nobody should stand behind. Saying "not scoring"
   * in both cases would be wrong in one of them.
   */
  scoreNote: string | null;
}

/** How long the calibrator is allowed to be "still working it out" before that is a fault. */
const CALIBRATION_GRACE_S = 8;

export function readIntegrity(snapshot: HudSnapshot): IntegrityView {
  const { mount, gps, physics, message } = snapshot.integrity;
  const settling = !snapshot.forwardResolved && snapshot.elapsedS < CALIBRATION_GRACE_S;
  // "Not scoring" is the SCORER's word (`LiveFrame.score.counting`), never this component's
  // guess. Through a GPS dropout the engine dead-reckons β and keeps paying; a note inferred
  // from `gps: 'none'` claimed the opposite, and the results screen then banked those points.
  const counting = snapshot.counting;
  const stopped = (reason: string) => `${reason} — NOT SCORING`;

  if (mount === 'loose') {
    return { tier: 'severe', heading: 'LOOSE MOUNT', message, scoreNote: counting ? 'MOUNT LOOSE — THESE POINTS MAY NOT STAND' : stopped('MOUNT LOOSE') };
  }
  if (physics === 'implausible') {
    return { tier: 'severe', heading: 'IMPLAUSIBLE READINGS', message, scoreNote: counting ? 'READINGS ARE NOT PHYSICALLY POSSIBLE' : stopped('IMPLAUSIBLE READINGS') };
  }
  if (gps === 'none' && snapshot.gpsEverGood) {
    return { tier: 'severe', heading: 'GPS LOST', message, scoreNote: counting ? 'NO FIX — DEAD-RECKONED FROM THE GYRO' : stopped('NO FIX') };
  }
  // The first seconds of every run: no fix yet and the forward axis still unknown. That is the
  // monitor describing its own startup, not an alarm, and it gets said calmly.
  if (settling) return { tier: 'calibrating', heading: 'FINDING FORWARD', message, scoreNote: counting ? null : 'WAITING FOR THE FIRST FIX' };
  if (gps === 'none') return { tier: 'warn', heading: 'WAITING FOR GPS', message, scoreNote: counting ? 'NO FIX YET — DEAD-RECKONED' : 'WAITING FOR THE FIRST FIX' };
  if (gps === 'poor') return { tier: 'warn', heading: 'WEAK GPS', message, scoreNote: counting ? null : stopped('WEAK GPS') };
  if (mount === 'suspect') return { tier: 'warn', heading: 'MOUNT SHAKING', message, scoreNote: counting ? null : stopped('MOUNT SHAKING') };
  if (!snapshot.forwardResolved) return { tier: 'warn', heading: 'FINDING FORWARD', message, scoreNote: counting ? null : null };
  // Everything reads fine and the scorer is simply not paying — parked, crawling, between
  // slides. That is not a fault and the HUD does not nag about it.
  return { tier: 'ok', heading: '', message, scoreNote: null };
}

/**
 * The loud half of integrity. Three treatments, deliberately different in FORM and not only in
 * hue: severe is a filled red slab that pulses, warn is an outlined slab with a plain white
 * headline, calibrating is the same outline in cyan. Gold appears nowhere here — it is the
 * colour of an extreme angle and of the multiplier, and the same hue cannot mean "you are a
 * hero" and "your phone is loose".
 */
export const IntegrityBanner = memo(function IntegrityBanner({ snapshot, testID }: { snapshot: HudSnapshot; testID?: string }) {
  const view = readIntegrity(snapshot);
  const reduced = useReducedMotion();
  const severe = view.tier === 'severe';
  // An element that pulses for ever is exactly what reduce-motion exists to stop.
  const pulse = useDerivedValue(() => (severe && !reduced ? withRepeat(withTiming(1, { duration: 900 }), -1, true) : 1), [severe, reduced]);
  const style = useAnimatedStyle(() => ({ opacity: severe ? 0.74 + 0.26 * pulse.value : 1 }));
  if (view.tier === 'ok') return null;
  const tone = severe ? colors.red : view.tier === 'calibrating' ? colors.cyan : colors.text;
  return (
    <Animated.View
      style={[
        styles.banner,
        severe
          ? { borderColor: alpha(colors.red, 0.85), backgroundColor: alpha(colors.red, 0.16) }
          : { borderColor: colors.line, backgroundColor: 'transparent' },
        style,
      ]}
      testID={testID}>
      <View style={[styles.bannerBar, { backgroundColor: severe ? colors.red : alpha(tone, 0.7) }]} />
      <View style={styles.bannerText}>
        <AppText style={[styles.bannerHeading, { color: tone }]}>{view.heading}</AppText>
        <AppText variant="small" color={colors.muted} numberOfLines={2}>
          {view.message}
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
  stripRight: { flexDirection: 'row', alignItems: 'center', gap: space[2], flexShrink: 1, flexWrap: 'nowrap', justifyContent: 'flex-end' },
  clock: { fontFamily: fontFamilies.display.bold, fontSize: 22, lineHeight: 24, color: colors.text, letterSpacing: 0.4 },
  lap: { flexDirection: 'row', alignItems: 'baseline', gap: space[1] },
  lapValue: { fontFamily: fontFamilies.display.bold, fontSize: 18, lineHeight: 20, color: colors.muted },
  pill: { borderWidth: 1, borderRadius: radii.pill, paddingHorizontal: space[2], paddingVertical: 2 },
  pillText: { fontSize: 11, lineHeight: 14 },

  stripRow: { flexDirection: 'row', alignItems: 'center', alignSelf: 'stretch', gap: space[3] },
  cell: { flexDirection: 'row', alignItems: 'baseline', gap: space[2], paddingRight: space[3] },
  cellBorder: { borderRightWidth: 1, borderRightColor: colors.line },
  cellValue: { fontFamily: fontFamilies.display.boldItalic, fontSize: 20, lineHeight: 22 },
  hint: { letterSpacing: 1.4 },

  banner: { flexDirection: 'row', alignItems: 'center', gap: space[3], borderWidth: 1, borderRadius: radii.md, padding: space[2], paddingRight: space[3] },
  bannerBar: { width: 4, alignSelf: 'stretch', borderRadius: 2 },
  bannerText: { flex: 1, gap: 1 },
  bannerHeading: { fontFamily: fontFamilies.display.extraboldItalic, fontSize: 20, lineHeight: 22, letterSpacing: 0.4 },
});
