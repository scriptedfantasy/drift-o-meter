/**
 * The live drive HUD — the screen a driver actually looks at, clamped to a dashboard, at night.
 *
 * Layout: the angle gauge and the hero numeral own the frame, the callout stack sits above them
 * and never over the number, cold telemetry and the score sit under them, the mini-map and the
 * STOP control close the screen. Landscape is a different arrangement of the same parts, not a
 * squeezed portrait: gauge left, telemetry and score right, mini-map bottom-right.
 *
 * Everything that moves comes from `useDriveRun`, which pushes ~100 motion samples a second into
 * the engine and writes shared values; this component re-renders at ~10 Hz for words and on
 * events. Skia components are imported through their `*View` wrappers so the web build never
 * evaluates Skia before CanvasKit is ready.
 */
import { useRouter } from 'expo-router';
import { Platform, Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';
import Animated, { useAnimatedStyle } from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useSettings } from '@/platform';
import { AppText, Body, Button, colors, fontFamilies, gutter, Micro, Panel, radii, space } from '@/ui';
import AngleGaugeView from '@/ui/hud/AngleGaugeView';
import { CalloutStack, ScoreBanner } from '@/ui/hud/CalloutStack';
import { EdgeBloom, IntegrityBanner, StatusStrip } from '@/ui/hud/HudChrome';
import MiniMapView from '@/ui/hud/MiniMapView';
import ScorePanel from '@/ui/hud/ScorePanel';
import { useHudSignals } from '@/ui/hud/signals';
import TelemetryRow from '@/ui/hud/TelemetryRow';
import { useDriveRun } from '@/ui/hud/useDriveRun';

export default function DriveScreen() {
  const signals = useHudSignals();
  const run = useDriveRun(signals);
  const { settings } = useSettings();
  const router = useRouter();
  const { width, height } = useWindowDimensions();
  const landscape = width > height;

  const shake = useAnimatedStyle(() => ({ transform: [{ translateX: signals.shake.value * 2 }, { translateY: signals.shake.value * -1.2 }] }));

  const live = run.status === 'running' || run.status === 'held' || run.status === 'saving';
  const stageW = width - gutter * 2;

  const gauge = landscape
    ? { w: Math.min(stageW * 0.54, height * 1.25), h: Math.min(height - 96, stageW * 0.42) }
    : { w: stageW, h: Math.min(stageW * 0.82, height * 0.4) };

  const map = landscape ? { w: 168, h: 116 } : { w: 132, h: 108 };

  return (
    <View style={styles.root} testID="screen-drive">
      <EdgeBloom signals={signals} />
      <Animated.View style={[styles.fill, shake]}>
        <SafeAreaView style={styles.fill} edges={['top', 'bottom', 'left', 'right']}>
          <View style={[styles.frame, landscape && styles.frameLandscape]}>
            {landscape ? (
              <View style={styles.landscapeRow}>
                <View style={styles.leftColumn}>
                  <StatusStrip snapshot={run.snapshot} sourceLabel={run.sourceLabel} testID="hud-status" />
                  <View style={styles.gaugeWrapLandscape}>
                    <AngleGaugeView width={gauge.w} height={gauge.h} signals={signals} testID="hud-gauge" />
                  </View>
                </View>

                <View style={styles.rightColumn}>
                  <View style={styles.calloutsLandscape} pointerEvents="none">
                    <CalloutStack events={run.events} fromRight size={22} testID="hud-callouts" />
                  </View>
                  <IntegrityBanner snapshot={run.snapshot} testID="hud-integrity" />
                  <TelemetryRow signals={signals} speedKmh={run.snapshot.speedKmh} units={settings.units} size={56} testID="hud-telemetry" />
                  <View style={styles.scoreRowLandscape}>
                    <View style={styles.scoreCell}>
                      <ScoreBanner banner={run.banner} size={24} />
                      <ScorePanel signals={signals} snapshot={run.snapshot} size={46} testID="hud-score" />
                    </View>
                    <MiniMapView width={map.w} height={map.h} trail={run.trail} count={run.snapshot.trailCount} signals={signals} testID="hud-map" />
                  </View>
                  {live ? <StopControl onPress={run.stop} compact /> : null}
                </View>
              </View>
            ) : (
              <>
                <StatusStrip snapshot={run.snapshot} sourceLabel={run.sourceLabel} testID="hud-status" />
                <IntegrityBanner snapshot={run.snapshot} testID="hud-integrity" />

                <View style={styles.stage}>
                  <View style={styles.callouts} pointerEvents="none">
                    <CalloutStack events={run.events} size={26} testID="hud-callouts" />
                  </View>
                  <AngleGaugeView width={gauge.w} height={gauge.h} signals={signals} testID="hud-gauge" />
                </View>

                <TelemetryRow signals={signals} speedKmh={run.snapshot.speedKmh} units={settings.units} size={64} testID="hud-telemetry" />

                <View style={styles.bottomRow}>
                  <View style={styles.scoreCell}>
                    <ScoreBanner banner={run.banner} size={26} />
                    <ScorePanel signals={signals} snapshot={run.snapshot} size={52} testID="hud-score" />
                  </View>
                  <MiniMapView width={map.w} height={map.h} trail={run.trail} count={run.snapshot.trailCount} signals={signals} testID="hud-map" />
                </View>

                {live ? <StopControl onPress={run.stop} /> : null}
              </>
            )}
          </View>
        </SafeAreaView>
      </Animated.View>

      {!live && run.status !== 'error' ? <ArmOverlay status={run.status} label={run.sourceLabel} onStart={run.start} landscape={landscape} /> : null}
      {run.status === 'error' && run.error ? (
        <ErrorOverlay title={run.error.title} body={run.error.body} retryable={run.error.retryable} onRetry={run.dismissError} onBack={() => router.replace('/')} />
      ) : null}
      {run.status === 'saving' ? <SavingOverlay /> : null}
    </View>
  );
}

function StopControl({ onPress, compact = false }: { onPress: () => void; compact?: boolean }) {
  return (
    <Pressable
      onPress={onPress}
      testID="cta-stop"
      accessibilityRole="button"
      accessibilityLabel="Stop the run and save it"
      hitSlop={10}
      style={({ pressed }) => [styles.stop, compact && styles.stopCompact, pressed && styles.pressed]}>
      <View style={styles.stopSquare} />
      <AppText style={styles.stopLabel}>STOP</AppText>
      <Micro color={colors.muted}>Save &amp; score</Micro>
    </Pressable>
  );
}

function ArmOverlay({ status, label, onStart, landscape }: { status: string; label: string | null; onStart: () => void; landscape: boolean }) {
  const starting = status === 'starting';
  return (
    <View style={[styles.overlay, landscape && styles.overlayLandscape]} pointerEvents="box-none">
      <View style={styles.armCard} pointerEvents="auto">
        <Micro color={colors.ember}>{label ?? (Platform.OS === 'web' ? 'SIMULATED SOURCE' : 'DEVICE SENSORS')}</Micro>
        <AppText style={styles.armTitle}>{starting ? 'ARMING' : 'READY TO DRIVE'}</AppText>
        <Body color="muted" style={styles.armBody}>
          {starting ? 'Waking the sensors and finding the car’s forward axis.' : 'Phone in the mount, screen toward you. Drive one straight line to calibrate, then get sideways.'}
        </Body>
        <Button label={starting ? 'Arming…' : 'Go'} size="lg" onPress={onStart} disabled={starting} testID="cta-go" style={styles.armButton} />
      </View>
    </View>
  );
}

function ErrorOverlay({ title, body, retryable, onRetry, onBack }: { title: string; body: string; retryable: boolean; onRetry: () => void; onBack: () => void }) {
  return (
    <View style={styles.overlay} testID="hud-error">
      <Panel accent={colors.red} style={styles.errorCard}>
        <AppText style={[styles.armTitle, { color: colors.red }]}>{title}</AppText>
        <Body color="muted">{body}</Body>
        <View style={styles.errorButtons}>
          {retryable ? <Button label="Try again" size="md" onPress={onRetry} testID="cta-retry" /> : null}
          <Button label="Garage" variant="secondary" size="md" onPress={onBack} testID="cta-garage" />
        </View>
      </Panel>
    </View>
  );
}

function SavingOverlay() {
  return (
    <View style={styles.saving} pointerEvents="none" testID="hud-saving">
      <AppText style={styles.savingText}>SAVING RUN</AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg0 },
  fill: { flex: 1 },
  frame: { flex: 1, paddingHorizontal: gutter, paddingTop: space[2], paddingBottom: space[3], gap: space[3] },
  frameLandscape: { paddingTop: space[1], paddingBottom: space[2] },

  stage: { flex: 1, justifyContent: 'flex-end', alignItems: 'center' },
  callouts: { position: 'absolute', top: 0, left: 0, right: 0, alignItems: 'flex-start' },

  landscapeRow: { flex: 1, flexDirection: 'row', gap: space[5] },
  leftColumn: { flex: 1.06, gap: space[2] },
  gaugeWrapLandscape: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  rightColumn: { flex: 1, justifyContent: 'flex-end', gap: space[3], paddingBottom: space[1] },
  calloutsLandscape: { flex: 1, justifyContent: 'flex-start', alignItems: 'flex-end', paddingTop: space[1] },
  scoreRowLandscape: { flexDirection: 'row', alignItems: 'flex-end', gap: space[4] },

  bottomRow: { flexDirection: 'row', alignItems: 'flex-end', gap: space[4] },
  scoreCell: { flex: 1, gap: space[1] },

  stop: {
    alignSelf: 'stretch',
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[3],
    borderWidth: 1,
    borderColor: alphaRed(0.55),
    backgroundColor: alphaRed(0.1),
    borderRadius: radii.md,
    paddingVertical: space[2],
    paddingHorizontal: space[4],
  },
  stopCompact: { paddingVertical: space[1] },
  stopSquare: { width: 16, height: 16, borderRadius: 3, backgroundColor: colors.red },
  stopLabel: { fontFamily: fontFamilies.display.extraboldItalic, fontSize: 26, lineHeight: 28, color: colors.red, letterSpacing: 1, flex: 1 },
  pressed: { opacity: 0.7 },

  overlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', padding: gutter, backgroundColor: 'rgba(7, 9, 13, 0.72)' },
  overlayLandscape: { justifyContent: 'center' },
  armCard: {
    maxWidth: 420,
    alignSelf: 'center',
    alignItems: 'flex-start',
    gap: space[2],
    backgroundColor: colors.bg1,
    borderWidth: 1,
    borderColor: colors.line,
    borderLeftWidth: 3,
    borderLeftColor: colors.ember,
    borderRadius: radii.lg,
    padding: space[5],
  },
  armTitle: { fontFamily: fontFamilies.display.extraboldItalic, fontSize: 40, lineHeight: 42, color: colors.text, letterSpacing: -0.5 },
  armBody: { maxWidth: 340 },
  armButton: { alignSelf: 'stretch', marginTop: space[2] },

  errorCard: { maxWidth: 420, gap: space[3] },
  errorButtons: { flexDirection: 'row', gap: space[3], marginTop: space[2] },

  saving: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(7, 9, 13, 0.82)' },
  savingText: { fontFamily: fontFamilies.display.extraboldItalic, fontSize: 34, lineHeight: 36, color: colors.ember, letterSpacing: 1 },
});

function alphaRed(a: number): string {
  return `rgba(255, 59, 59, ${a})`;
}
