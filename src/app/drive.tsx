/**
 * The live drive display — two instruments and one control.
 *
 * WHY THERE IS NOTHING ELSE HERE. This screen used to carry a status strip, an integrity banner,
 * a peak/held/flicks strip, a callout stack, a speed and lateral-g row, a score odometer with a
 * multiplier chip and a chain bar, and a live mini-map. All of it was real and most of it was
 * good, and none of it survives the thing it was built for: a driver at 60 km/h has no time to
 * read a screen. Two visuals they can take in at a glance are worth more than nine they cannot.
 *
 * THE ANGLE GAUGE OWNS THE FRAME — it carries the hero numeral and the direction chevron inside
 * its own bowl — and the g-meter sits under it: a friction circle with the acceleration vector
 * as a dot, right for a right-hand push, up for throttle, down for brake. They are the two
 * questions a slide is made of, and they are asked in different shapes so a glance can tell them
 * apart: an arc that sweeps, and a dot that wanders. STOP is docked where a hand finds it
 * without looking.
 *
 * NEITHER OF THEM HAS A WORD ON IT. The gauge's numeral is the one figure that is scored, so it
 * earns its place; the g-meter's magnitude is already the dot's distance from the centre, so a
 * number beside it would be that fact drawn twice — the same reason the gauge's "R" came off
 * from beside a chevron already pointing right.
 *
 * NOTHING WAS TURNED OFF BEHIND IT. `useDriveRun` still pushes ~100 samples a second through the
 * whole engine, the scorer still scores, the integrity monitor still judges, the session is still
 * saved and the verdict screen still publishes a grade. What changed is what this screen SHOWS,
 * which is the only thing a driver spends attention on.
 *
 * The gauge keeps one piece of honesty that is not furniture: it greys when the engine does not
 * believe the reading. That is the same single visual telling the truth, not a tenth element.
 *
 * Sound and haptics stay, and matter more here than they did before: they are the channel that
 * does not need eyes.
 *
 * `useDriveRun` STILL PUBLISHES ITS 10 Hz SNAPSHOT and nothing here reads it. That is deliberate
 * and it is close to free: the gauge is driven by reanimated shared values on the UI thread, so
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
import AngleGaugeView from '@/ui/hud/AngleGaugeView';
import GMeterView from '@/ui/hud/GMeterView';
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

  // The gauge's box is the arc's bounding box — a wide, shallow bowl of h ≈ 0.56 × w. Portrait
  // runs it full-bleed; landscape is capped by the height the arc needs rather than by the width,
  // and by the room the g-meter takes out of the frame beside it.
  const gaugeW = landscape ? Math.min(width - gutter * 2 - GM_LANDSCAPE, (height - STOP_DOCK_H) * 1.5) : width;
  const gauge = { w: gaugeW, h: gaugeW * 0.56 };
  // The g-meter is square and deliberately the smaller of the two: the angle is what is being
  // judged and the g is the texture under it, so a glance that lands in the wrong place should
  // land on the gauge. Half the gauge's width portrait, and the fixed landscape column.
  const gm = landscape ? GM_LANDSCAPE : Math.min(gaugeW * 0.52, height * 0.24);
  // Tucked up into the gauge's own empty bottom. The arc is a shallow bowl in a wide canvas: the
  // pivot sits at 0.92 of the canvas height and the arc's ends are at ±78°, so the lowest thing
  // drawn is at about 0.74 of it and the last quarter is transparent but for the pool glow. Left
  // to stack naturally the two instruments sat a finger's width apart with nothing in between,
  // which is a gap the eye has to cross. Pulled up, they read as one instrument cluster.
  const gmLift = landscape ? 0 : -Math.round(gauge.h * 0.2);

  return (
    <View style={styles.root} testID="screen-drive">
      <EdgeBloom signals={signals} />
      <Animated.View style={[styles.fill, shake]}>
        <SafeAreaView style={styles.fill} edges={['top', 'bottom', 'left', 'right']}>
          {/* Centred as a pair, so the eye returns to one place and finds both. Each box exists
              so a harness check can NAME the instrument: on web the Skia canvas does not forward
              its own testID to the DOM, and a ceiling like "at most N ember pixels inside the
              gauge" has to be measured on the element rather than on the frame. */}
          <View style={[styles.stage, landscape && styles.stageLandscape]}>
            <View testID="hud-gauge-box">
              <AngleGaugeView width={gauge.w} height={gauge.h} signals={signals} testID="hud-gauge" />
            </View>
            <View testID="hud-g-box" style={{ marginTop: gmLift }}>
              <GMeterView width={gm} height={gm} signals={signals} testID="hud-g" />
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
/** The g-meter's side in landscape, where it is a fixed column beside the gauge rather than a
    fraction of it: the landscape gauge is already height-limited, so scaling the g-meter off its
    width would shrink the instrument the frame has the most room for. */
const GM_LANDSCAPE = 186;

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg0 },
  fill: { flex: 1 },
  // Two things on the screen, centred as one block: there is no reading order to establish
  // between them — a glance takes both or takes the gauge — and the centre is where an eye
  // returns to when it comes back from the road. The gauge is a shallow bowl (h = 0.56 w) whose
  // own bottom quarter is transparent, so the g-meter tucks up into that empty strip and the
  // pair reads as one instrument rather than two stacked panels. Portrait stacks them; landscape
  // sets them side by side, because a landscape frame has width to spare and no height at all.
  stage: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  stageLandscape: { flexDirection: 'row', gap: space[3] },
  stopDock: { position: 'absolute', left: gutter, right: gutter, bottom: space[3] },
  // Landscape puts STOP in the right half, clear of the gauge that now spans the frame.
  stopDockLandscape: { left: '52%', right: gutter, bottom: space[2] },

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
