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
import { readIntegrity } from './integrityView';
import type { HudSignals } from './signals';
import type { HudSnapshot } from './useDriveRun';

// `readIntegrity` moved to `integrityView.ts` so a test can reach it without React Native; it
// is re-exported here because this is where a reader of the HUD chrome expects to find it.
export { readIntegrity, CALIBRATION_GRACE_S } from './integrityView';
export type { IntegrityTier, IntegrityView } from './integrityView';

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
        {/* LAP is shown only once the track model has closed one. A point-to-point road never
            closes, `lap.count` stays 0 for the whole run, and "LAP 1" on it is a circuit the
            driver is not on. `lapProgress` is finite only when a closed reference lap exists. */}
        {snapshot.lapCount > 0 || snapshot.lapProgress > 0 ? (
          <View style={styles.lap}>
            <Micro>Lap</Micro>
            <AppText numeric style={styles.lapValue}>
              {snapshot.lapCount + 1}
            </AppText>
          </View>
        ) : null}
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
 * callouts. All values step slowly enough for the 10 Hz snapshot.
 *
 * BETWEEN SLIDES IT KEEPS SAYING SOMETHING, because between slides is the normal state: callouts
 * hold for 3.2 s and a measured idle frame lit 0.71 % of this band against 45.6 % with three
 * callouts up. So the strip falls back to the RUN — how many slides, and the best angle of them —
 * and the one line of coaching underneath is set at a size a driver can read at arm's length
 * rather than at 11 px, which made the most urgent sentence on the screen the smallest text on it.
 */
export const DriftStrip = memo(function DriftStrip({ snapshot, testID }: { snapshot: HudSnapshot; testID?: string }) {
  const live = snapshot.phase !== 'idle' && snapshot.phase !== 'exit';
  const chained = snapshot.chainActive && snapshot.chainPoints > 0;
  // An untrusted reading gets untrusted numbers: same values, no colour claiming they are good.
  const trusted = snapshot.trust > 0;
  if (!live) {
    // BETWEEN SLIDES THE RUN IS THE SUBJECT, so its two numbers are set at the size of a value
    // rather than of a footnote: on a portrait idle frame this band and the mini-map beside it
    // are the only things on the screen between the gauge and the speed row, and at 20 px they
    // left it reading as empty.
    return (
      <View style={styles.stripStack} testID={testID}>
        <View style={styles.stripRow}>
          <StripCell label="Slides" value={String(snapshot.driftCount)} tone={snapshot.driftCount > 0 ? colors.text : colors.muted} big />
          <StripCell
            label="Best"
            value={snapshot.runPeakDeg >= 1 ? `${Math.round(snapshot.runPeakDeg)}°` : '—'}
            tone={snapshot.runPeakDeg >= 1 ? colors.gold : colors.muted}
            big
            last
          />
        </View>
        <AppText color={chained ? colors.ember : colors.muted} style={styles.hint} numberOfLines={1} adjustsFontSizeToFit>
          {chained ? 'CHAIN OPEN — GET BACK SIDEWAYS' : 'WAITING FOR A SLIDE'}
        </AppText>
      </View>
    );
  }
  return (
    <View style={styles.stripRow} testID={testID}>
      <StripCell label="Peak" value={`${Math.round(snapshot.peakDeg)}°`} tone={trusted ? colors.gold : colors.muted} />
      <StripCell label="Held" value={`${snapshot.driftDurationS.toFixed(1)}s`} tone={trusted ? colors.text : colors.muted} />
      <StripCell label="Flicks" value={`×${snapshot.transitions}`} tone={trusted && snapshot.transitions > 0 ? colors.magenta : colors.muted} last />
    </View>
  );
});

function StripCell({ label, value, tone, last, big }: { label: string; value: string; tone: string; last?: boolean; big?: boolean }) {
  return (
    <View style={[styles.cell, !last && styles.cellBorder]}>
      <Micro>{label}</Micro>
      <AppText numeric style={[styles.cellValue, big && styles.cellValueBig, { color: tone }]}>
        {value}
      </AppText>
    </View>
  );
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

  stripStack: { alignSelf: 'stretch', gap: space[1] },
  stripRow: { flexDirection: 'row', alignItems: 'center', alignSelf: 'stretch', gap: space[3] },
  cell: { flexDirection: 'row', alignItems: 'baseline', gap: space[2], paddingRight: space[3] },
  cellBorder: { borderRightWidth: 1, borderRightColor: colors.line },
  cellValue: { fontFamily: fontFamilies.display.boldItalic, fontSize: 20, lineHeight: 22 },
  cellValueBig: { fontSize: 34, lineHeight: 36 },
  // 17 px, not the 11 px micro: this is the only coaching line on the display, and it appears
  // exactly when the driver has something to do about it.
  hint: { fontFamily: fontFamilies.display.bold, fontSize: 17, lineHeight: 20, letterSpacing: 1.2 },

  banner: { flexDirection: 'row', alignItems: 'center', gap: space[3], borderWidth: 1, borderRadius: radii.md, padding: space[2], paddingRight: space[3] },
  bannerBar: { width: 4, alignSelf: 'stretch', borderRadius: 2 },
  bannerText: { flex: 1, gap: 1 },
  bannerHeading: { fontFamily: fontFamilies.display.extraboldItalic, fontSize: 20, lineHeight: 22, letterSpacing: 0.4 },
});
