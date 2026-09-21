/**
 * The live drive display — one dial and one control.
 *
 * WHY THERE IS NOTHING ELSE HERE. This screen used to carry a status strip, an integrity banner,
 * a peak/held/flicks strip, a callout stack, a speed and lateral-g row, a score odometer with a
 * multiplier chip and a chain bar, and a live mini-map. All of it was real and most of it was
 * good, and none of it survives the thing it was built for: a driver at 60 km/h has no time to
 * read a screen. One visual they can take in at a glance is worth more than nine they cannot.
 *
 * AND THEN TWO BECAME ONE. The first cut left an angle gauge with a g-meter beneath it, which is
 * still two places to look; the dial is both, concentric — the rim is the slip angle, the middle
 * is the g radar, and the eye lands in one circle and reads outward instead of choosing. STOP is
 * docked where a hand finds it without looking. See `Dial.tsx`.
 *
 * NOTHING WAS TURNED OFF BEHIND IT. `useDriveRun` still pushes ~100 samples a second through the
 * whole engine, the scorer still scores, the integrity monitor still judges, the session is still
 * saved and the verdict screen still publishes a grade. What changed is what this screen SHOWS,
 * which is the only thing a driver spends attention on.
 *
 * The dial keeps one piece of honesty that is not furniture: it greys, needle and radar together,
 * when the engine does not believe the reading. That is the same single visual telling the truth,
 * not a tenth element.
 *
 * Sound and haptics stay, and matter more here than they did before: they are the channel that
 * does not need eyes.
 *
 * `useDriveRun` STILL PUBLISHES ITS 10 Hz SNAPSHOT and nothing here reads it. That is deliberate
 * and it is close to free: the dial is driven by reanimated shared values on the UI thread, so
 * the ten React renders a second find every child's dependencies unchanged and bail out, and the
 * cost is one allocation and one memoised call per 100 ms against an engine already doing 100.
 * Cutting the publish would mean unpicking the hook that every shelved component reads, which is
 * the opposite of leaving them ready to come back.
 */
import { StyleSheet, Pressable, useWindowDimensions, View } from 'react-native';
import Animated, { useAnimatedStyle } from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppText, Body, Button, colors, fontFamilies, formatDuration, gradeColors, gutter, Micro, Panel, radii, space } from '@/ui';
import { useDriftFeel } from '@/ui/audio';
import { DIAL_ASPECT } from '@/ui/hud/Dial';
import DialView from '@/ui/hud/DialView';
import { EdgeBloom } from '@/ui/hud/HudChrome';
import { useHudSignals } from '@/ui/hud/signals';
import { useDriveRun, type RunError, type RunVerdict } from '@/ui/hud/useDriveRun';

export default function DriveScreen() {
  const signals = useHudSignals();
  const run = useDriveRun(signals);
  // Sound and haptics for the run. It builds the bank the first time any screen asks and does
  // NOT release it when this screen goes: the STOP clip is fired by `useDriveRun.stop()` a few
  // milliseconds before `router.replace` unmounts this tree, and a port released here used to
  // close the AudioContext 215 ms into that 520 ms clip.
  useDriftFeel();
  const { width, height } = useWindowDimensions();
  const landscape = width > height;

  const shake = useAnimatedStyle(() => ({ transform: [{ translateX: signals.shake.value * 2 }, { translateY: signals.shake.value * -1.2 }] }));

  // The display is live from the moment the screen opens: there is no pre-run state to render.
  const live = run.status !== 'error';

  // `dial` is the CIRCLE's diameter; the canvas under it is `DIAL_ASPECT` times as tall, because
  // the numeral sits in a band below the circle. So the height available is divided by the aspect
  // and the width is not.
  //
  // Landscape keeps the dial in the LEFT half rather than centring it, which is worth a note: the
  // numeral band costs height, height is the one thing a landscape phone has none of, and a
  // centred dial would also have to clear the STOP dock's full width at the bottom. Off to the
  // left, the dial owns its own column and STOP owns the other, and the circle comes out larger
  // than a centred one could be.
  const dial = landscape
    ? Math.min(width * STOP_DOCK_LEFT - gutter * 2, (height - space[3] * 2) / DIAL_ASPECT)
    : Math.min(width, (height - STOP_DOCK_H - space[4]) / DIAL_ASPECT);

  return (
    <View style={styles.root} testID="screen-drive">
      <EdgeBloom signals={signals} />
      <Animated.View style={[styles.fill, shake]}>
        <SafeAreaView style={styles.fill} edges={['top', 'bottom', 'left', 'right']}>
          {/* Centred, because with one thing on the screen the middle is where an eye returns
              to. The box exists so a harness check can name the dial: on web the Skia canvas
              does not forward its own testID to the DOM, and a ceiling like "at most N ember
              pixels inside the dial" has to be measured on the element rather than on the
              frame, where the edge bloom would clear any floor by itself. */}
          <View style={[styles.stage, landscape && { paddingRight: width * (1 - STOP_DOCK_LEFT) }]}>
            <View testID="hud-dial-box">
              <DialView size={dial} signals={signals} testID="hud-dial" />
            </View>
          </View>

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
        {/* A finished run is not lost because the write failed: show what it scored — but only
            if the engine will vouch for it. `RunVerdict.trusted` is `SessionScore.trusted`, and
            `src/engine/types.ts` forbids presenting the total or the grade as an achievement
            when it is false. So there are two overlays here, not one with a colour swapped: a
            trusted run gets its letter and its points, and an untrusted one gets the refusal and
            the recording — no grade letter, no total, no peak angle. */}
        {verdict ? (verdict.trusted ? <VerdictScored verdict={verdict} /> : <VerdictRefused verdict={verdict} />) : null}
        <Body color="muted">{error.body}</Body>
        <View style={styles.errorButtons}>
          {error.retryable ? <Button label={error.retryLabel} size="md" onPress={onRetry} testID="cta-retry" /> : null}
          <Button label="Garage" variant="secondary" size="md" onPress={onLeave} testID="cta-garage" />
        </View>
      </Panel>
    </View>
  );
}

/** A run the engine stands behind: the letter, the points, and what they were made of. */
function VerdictScored({ verdict }: { verdict: RunVerdict }) {
  return (
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
  );
}

/**
 * A run the engine refused. NOT SCORED in the muted grey the rest of the HUD uses for a reading
 * it will not stand behind, the monitor's own sentence for why, and the one thing the driver
 * still has: a recording of that many slides over that long. Deliberately no letter, no total
 * and no peak angle — every one of those is the achievement `scoreTrusted` forbids, and the peak
 * is the worst of the three, because a loose mount is exactly what inflates it.
 */
function VerdictRefused({ verdict }: { verdict: RunVerdict }) {
  return (
    <View style={styles.verdictRefused} testID="hud-verdict">
      <AppText style={styles.verdictNotScored}>NOT SCORED</AppText>
      {verdict.message ? (
        <Body color="muted" numberOfLines={3}>
          {verdict.message}
        </Body>
      ) : null}
      <Micro>
        RECORDING KEPT · {verdict.drifts === 1 ? '1 slide' : `${verdict.drifts} slides`} · {formatDuration(verdict.durationS)}
      </Micro>
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
/**
 * Where the landscape STOP dock starts, as a fraction of the width — and therefore where the
 * dial's column ENDS. One constant for both, because they are one decision: the dial is centred
 * in what STOP does not take. Two numbers here meant the dial was sized against 52 % and then
 * drawn hard against the left edge, with the whole difference showing up as a void on the right.
 */
const STOP_DOCK_LEFT = 0.54;

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg0 },
  fill: { flex: 1 },
  // One thing on the screen, so it sits in the middle: with nothing else competing there is no
  // reading order to establish, and the centre of a round instrument is where an eye returns to
  // when it comes back from the road.
  stage: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  stopDock: { position: 'absolute', left: gutter, right: gutter, bottom: space[3] },
  // Landscape puts STOP in the right half, clear of the gauge that now spans the frame.
  stopDockLandscape: { left: `${STOP_DOCK_LEFT * 100}%`, right: gutter, bottom: space[2] },

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
  verdictRefused: { gap: space[2], borderLeftWidth: 3, borderLeftColor: colors.muted, paddingLeft: space[3] },
  // The same weight the grade letter would have had, in the colour that means "not an
  // achievement": the refusal is the headline of this card, not a footnote under one.
  verdictNotScored: { fontFamily: fontFamilies.display.extraboldItalic, fontSize: 40, lineHeight: 42, color: colors.muted, letterSpacing: 0.5 },
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
