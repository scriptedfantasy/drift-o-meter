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
import { Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';
import Animated, { useAnimatedStyle } from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useSettings } from '@/platform';
import { AppText, Body, Button, colors, fontFamilies, formatDuration, gradeColors, gutter, Micro, Panel, radii, space } from '@/ui';
import AngleGaugeView from '@/ui/hud/AngleGaugeView';
import { CalloutStack, ScoreBanner } from '@/ui/hud/CalloutStack';
import { DriftStrip, EdgeBloom, IntegrityBanner, StatusStrip } from '@/ui/hud/HudChrome';
import MiniMapView from '@/ui/hud/MiniMapView';
import ScorePanel from '@/ui/hud/ScorePanel';
import { useHudSignals } from '@/ui/hud/signals';
import TelemetryRow from '@/ui/hud/TelemetryRow';
import { useDriveRun, type RunError } from '@/ui/hud/useDriveRun';

export default function DriveScreen() {
  const signals = useHudSignals();
  const run = useDriveRun(signals);
  const { settings } = useSettings();
  const { width, height } = useWindowDimensions();
  const landscape = width > height;

  const shake = useAnimatedStyle(() => ({ transform: [{ translateX: signals.shake.value * 2 }, { translateY: signals.shake.value * -1.2 }] }));

  // The HUD is live from the moment the screen opens: there is no pre-run state to render.
  const live = run.status !== 'error';
  const stageW = width - gutter * 2;

  // The gauge's box is the arc's bounding box (a wide, shallow bowl): height ≈ 0.56 × width.
  // Portrait runs it full-bleed — the arc is the widest thing on the screen, as it should be.
  const gaugeW = landscape ? Math.min(stageW * 0.52, height * 1.3) : width;
  const gauge = { w: gaugeW, h: Math.min(gaugeW * 0.56, height * (landscape ? 0.62 : 0.32)) };

  const map = landscape ? { w: 168, h: 116 } : { w: 146, h: 150 };

  return (
    <View style={styles.root} testID="screen-drive">
      <EdgeBloom signals={signals} />
      <Animated.View style={[styles.fill, shake]}>
        <SafeAreaView style={styles.fill} edges={['top', 'bottom', 'left', 'right']}>
          <View style={[styles.frame, landscape && styles.frameLandscape, live && styles.frameLive, live && landscape && styles.frameLiveLandscape]}>
            {landscape ? (
              <View style={styles.landscapeRow}>
                <View style={styles.leftColumn}>
                  <StatusStrip snapshot={run.snapshot} sourceLabel={run.sourceLabel} live={live} testID="hud-status" />
                  <View style={styles.gaugeWrapLandscape}>
                    <AngleGaugeView width={gauge.w} height={gauge.h} signals={signals} testID="hud-gauge" />
                    {live ? <DriftStrip snapshot={run.snapshot} testID="hud-drift" /> : null}
                  </View>
                </View>

                <View style={styles.rightColumn}>
                  {live ? <IntegrityBanner snapshot={run.snapshot} testID="hud-integrity" /> : null}
                  <View style={styles.calloutsLandscape} pointerEvents="none">
                    <CalloutStack events={run.events} fromRight size={22} muted={run.snapshot.trust <= 0} testID="hud-callouts" />
                  </View>
                  {live ? (
                    <>
                      <TelemetryRow signals={signals} speedKmh={run.snapshot.speedKmh} units={settings.units} size={56} testID="hud-telemetry" />
                      <View style={styles.scoreRowLandscape}>
                        <View style={styles.scoreCell}>
                          <ScoreBanner banner={run.banner} size={24} />
                          <ScorePanel signals={signals} snapshot={run.snapshot} size={46} testID="hud-score" />
                        </View>
                        <MiniMapView width={map.w} height={map.h} trail={run.trail} count={run.snapshot.trailCount} signals={signals} testID="hud-map" />
                      </View>
                    </>
                  ) : null}
                </View>
              </View>
            ) : (
              <>
                <StatusStrip snapshot={run.snapshot} sourceLabel={run.sourceLabel} live={live} testID="hud-status" />
                {live ? <IntegrityBanner snapshot={run.snapshot} testID="hud-integrity" /> : null}

                {/* The gauge sits high: a phone in a dash mount is read from below, so the
                    clearest sightline is the top of the screen. */}
                <View style={styles.bleed}>
                  <AngleGaugeView width={gauge.w} height={gauge.h} signals={signals} testID="hud-gauge" />
                </View>

                {/* Middle band: what the slide is doing (strip), what it just earned (callouts)
                    and where it is happening (map). Nothing here is decoration. */}
                <View style={styles.stage}>
                  {live ? <DriftStrip snapshot={run.snapshot} testID="hud-drift" /> : null}
                  <View style={styles.stageRow}>
                    <View style={styles.stageCallouts}>
                      <CalloutStack events={run.events} size={24} muted={run.snapshot.trust <= 0} testID="hud-callouts" />
                    </View>
                    {live ? (
                      <MiniMapView width={map.w} height={map.h} trail={run.trail} count={run.snapshot.trailCount} signals={signals} testID="hud-map" />
                    ) : null}
                  </View>
                </View>

                {/* Nothing below the gauge claims a number until the run is actually armed. */}
                {live ? (
                  <>
                    <TelemetryRow signals={signals} speedKmh={run.snapshot.speedKmh} units={settings.units} size={68} testID="hud-telemetry" />

                    <View style={styles.scoreBlock}>
                      <ScoreBanner banner={run.banner} size={28} />
                      <ScorePanel signals={signals} snapshot={run.snapshot} size={58} testID="hud-score" />
                    </View>
                  </>
                ) : null}
              </>
            )}
          </View>
          {/* STOP is docked, not stacked: in a warning state the status strip and the banner
              grow, and a flex column has nowhere to put the excess but under the home
              indicator — which is exactly when the driver needs to reach it. */}
          {live ? (
            <View style={[styles.stopDock, landscape && styles.stopDockLandscape]}>
              <StopControl onPress={run.stop} compact={landscape} />
            </View>
          ) : null}
        </SafeAreaView>
      </Animated.View>

      {run.status === 'error' && run.error ? <ErrorOverlay error={run.error} onRetry={run.retry} onLeave={run.leave} /> : null}
      {run.status === 'discarded' ? <DiscardedOverlay onDriveAgain={run.restart} onLeave={run.leave} /> : null}
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

function ErrorOverlay({ error, onRetry, onLeave }: { error: RunError; onRetry: () => void; onLeave: () => void }) {
  const verdict = error.verdict;
  return (
    <View style={styles.overlay} testID="hud-error">
      <Panel accent={colors.red} style={styles.errorCard}>
        <AppText style={[styles.errorTitle, { color: colors.red }]}>{error.title}</AppText>
        {/* A finished run is not lost because the write failed: show what it scored. */}
        {verdict ? (
          <View style={styles.verdict} testID="hud-verdict">
            <AppText style={[styles.verdictGrade, { color: gradeColors[verdict.grade] }]}>{verdict.grade}</AppText>
            <View style={styles.verdictFacts}>
              <AppText numeric style={styles.verdictPoints}>
                {Math.round(verdict.points).toLocaleString('en-US')}
              </AppText>
              <Micro>
                {verdict.drifts === 1 ? '1 drift' : `${verdict.drifts} drifts`} · peak {Math.round(verdict.peakDeg)}° · {formatDuration(verdict.durationS)}
              </Micro>
            </View>
          </View>
        ) : null}
        <Body color="muted">{error.body}</Body>
        <View style={styles.errorButtons}>
          {error.retryable ? <Button label={error.retryLabel} size="md" onPress={onRetry} testID="cta-retry" /> : null}
          <Button label="Garage" variant="secondary" size="md" onPress={onLeave} testID="cta-garage" />
        </View>
      </Panel>
    </View>
  );
}

/**
 * A run that never got above walking pace: say so, rather than returning to an empty garage.
 *
 * The primary action is DRIVE AGAIN, and it restarts here. The driver is standing in step 3 of
 * the four-step flow with the phone already mounted; sending them to the garage to press DRIVE
 * is a detour back into step 2 for a run that was never anything but a false start.
 */
function DiscardedOverlay({ onDriveAgain, onLeave }: { onDriveAgain: () => void; onLeave: () => void }) {
  return (
    <View style={styles.overlay} testID="hud-discarded">
      <Panel style={styles.errorCard}>
        <AppText style={styles.errorTitle}>NOTHING TO SCORE</AppText>
        <Body color="muted">
          That run never got above walking pace and found no drifts, so it was not saved. Drive it like you stole it, then press STOP.
        </Body>
        <View style={styles.errorButtons}>
          <Button label="Drive again" size="md" onPress={onDriveAgain} testID="cta-drive-again" />
          <Button label="Garage" variant="secondary" size="md" onPress={onLeave} testID="cta-garage" />
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

/** Height reserved for the docked STOP control. */
const STOP_DOCK_H = 54;

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg0 },
  fill: { flex: 1 },
  // Bands, not a stack with a hole in it: whatever height is left over after the gauge, the
  // callout band and the numbers is shared between the gaps, so nothing pools in one place.
  frame: { flex: 1, paddingHorizontal: gutter, paddingTop: space[2], paddingBottom: space[3], gap: space[3] },
  // Room for the docked STOP control, so nothing in the column can ever slide underneath it.
  frameLive: { justifyContent: 'space-between', paddingBottom: STOP_DOCK_H + space[4] },
  frameLiveLandscape: { paddingBottom: space[2] },
  stopDock: { position: 'absolute', left: gutter, right: gutter, bottom: space[3] },
  stopDockLandscape: { left: '52%', right: gutter, bottom: space[2] },
  frameLandscape: { paddingTop: space[2], paddingBottom: space[2] },

  stage: { alignSelf: 'stretch', justifyContent: 'flex-start', gap: space[2] },
  stageRow: { flexDirection: 'row', alignItems: 'flex-start', gap: space[3] },
  // `overflow: 'hidden'` for the same reason the landscape column has it: a callout SLAMS in at
  // 1.8× from its left edge, so a 250 pt chip is 450 pt wide for the first frames of the 320 ms
  // and lands on top of the mini-map — measured, "MANJI +990" and "TRANSITION ×3 +405" drawn
  // across the ember trail with the "+405" illegible. Clipped, the drama stays in its column.
  stageCallouts: { flex: 1, alignItems: 'flex-start', justifyContent: 'flex-start', overflow: 'hidden' },
  scoreBlock: { alignSelf: 'stretch', gap: space[1] },
  bleed: { marginHorizontal: -gutter },

  landscapeRow: { flex: 1, flexDirection: 'row', gap: space[5] },
  leftColumn: { flex: 1.06, gap: space[2] },
  gaugeWrapLandscape: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: space[2] },
  rightColumn: { flex: 1, justifyContent: 'flex-end', gap: space[3], paddingBottom: STOP_DOCK_H - space[2] },
  calloutsLandscape: { flex: 1, flexShrink: 1, overflow: 'hidden', justifyContent: 'flex-start', alignItems: 'flex-end', paddingTop: space[2], paddingRight: space[1] },
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

  overlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', padding: gutter, backgroundColor: 'rgba(7, 9, 13, 0.5)' },
  // Uppercase because every other headline on this screen is (LOOSE MOUNT, GPS LOST, CHAIN
  // LOST, SAVING RUN): a dialog is not the place the HUD suddenly starts speaking in sentences.
  errorTitle: { fontFamily: fontFamilies.display.extraboldItalic, fontSize: 34, lineHeight: 36, color: colors.text, letterSpacing: -0.2, textTransform: 'uppercase' },

  errorCard: { maxWidth: 420, gap: space[3] },
  verdict: { flexDirection: 'row', alignItems: 'center', gap: space[4] },
  verdictGrade: { fontFamily: fontFamilies.display.extraboldItalic, fontSize: 64, lineHeight: 62 },
  verdictFacts: { gap: 2 },
  verdictPoints: { fontFamily: fontFamilies.display.extraboldItalic, fontSize: 34, lineHeight: 34, color: colors.ember },
  errorButtons: { flexDirection: 'row', gap: space[3], marginTop: space[2] },

  saving: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(7, 9, 13, 0.82)' },
  savingText: { fontFamily: fontFamilies.display.extraboldItalic, fontSize: 34, lineHeight: 36, color: colors.ember, letterSpacing: 1 },
});

function alphaRed(a: number): string {
  return `rgba(255, 59, 59, ${a})`;
}
