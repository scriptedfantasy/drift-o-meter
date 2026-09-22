/**
 * The live drive display — the mark, one dial and one control.
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
 * AND THE MARK, which is the one thing that came BACK. It is not an element to read — nobody
 * reads a logo, it is recognised in the periphery or not at all — and it costs the dial nothing:
 * the scale is a circle in a square and the band above the square was empty. See
 * `hud/DriveWordmark.tsx` for where it goes in landscape.
 *
 * NO SCORE ON THIS SCREEN, ON ANY BRANCH. The display never had one after the strip; the
 * save-failed overlay still did, and handed back a grade letter and a points block for a run the
 * driver could not see the score of a second earlier. The overlay now reports what was RECORDED
 * — how many slides, how long, and the peak angle when the engine will vouch for it — and the
 * total is published in one place, the results screen, off the saved `Session`.
 *
 * `useDriveRun` STILL PUBLISHES ITS 10 Hz SNAPSHOT and nothing here reads it. That is deliberate
 * and it is close to free: the dial is driven by reanimated shared values on the UI thread, so
 * the ten React renders a second find every child's dependencies unchanged and bail out, and the
 * cost is one allocation and one memoised call per 100 ms against an engine already doing 100.
 * Cutting the publish would mean unpicking the hook that the shelved chrome reads, which is the
 * opposite of leaving it ready to come back.
 */
import { StyleSheet, Pressable, useWindowDimensions, View } from 'react-native';
import Animated, { useAnimatedStyle } from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';

import { alpha, angleColor, AppText, Body, Button, colors, fontFamilies, formatDuration, gutter, Micro, Panel, radii, space } from '@/ui';
import { useDriftFeel } from '@/ui/audio';
import { DIAL_ASPECT } from '@/ui/hud/Dial';
import DialView from '@/ui/hud/DialView';
import { DriveWordmark, wordmarkSize } from '@/ui/hud/DriveWordmark';
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

  // The mark's band, in portrait. It is laid out in the FLOW rather than floated over the dial:
  // the mockup can afford an absolute one because it is drawn at exactly 390 × 844, and on a
  // shorter phone a dial centred in the whole height rises under it (measured on a 375 × 667
  // frame: the canvas top lands 29 pt above the mark's baseline). In the flow the dial is sized
  // against what is left and the two can never meet.
  const markBand = landscape ? 0 : wordmarkSize(width).height + space[6];

  // `dial` is the CIRCLE's diameter; the canvas under it is `DIAL_ASPECT` times as tall, because
  // the numeral sits in a band below the circle. So the height available is divided by the aspect
  // and the width is not.
  //
  // Landscape keeps the dial in the LEFT half rather than centring it, which is worth a note: the
  // numeral band costs height, height is the one thing a landscape phone has none of, and a
  // centred dial would also have to clear the STOP dock's full width at the bottom. Off to the
  // left, the dial owns its own column and STOP owns the other, and the circle comes out larger
  // than a centred one could be. The mark goes in that same right-hand column, at the top of it,
  // where the only thing it takes space from is the gap above STOP.
  const dial = landscape
    ? Math.min(width * STOP_DOCK_LEFT - gutter * 2, (height - space[3] * 2) / DIAL_ASPECT)
    : Math.min(width, (height - STOP_DOCK_H - space[4] - markBand) / DIAL_ASPECT);

  return (
    <View style={styles.root} testID="screen-drive">
      <EdgeBloom signals={signals} />
      <Animated.View style={[styles.fill, shake]}>
        <SafeAreaView style={styles.fill} edges={['top', 'bottom', 'left', 'right']}>
          {landscape ? null : (
            <View style={styles.markBand}>
              <DriveWordmark available={width} testID="hud-wordmark" />
            </View>
          )}

          {/* Centred, because with one thing on the screen the middle is where an eye returns
              to. The box exists so a harness check can name the dial: on web the Skia canvas
              does not forward its own testID to the DOM, and a ceiling like "at most N green
              pixels inside the dial" has to be measured on the element rather than on the
              frame, where the edge bloom would clear any floor by itself. */}
          <View style={[styles.stage, landscape && styles.stageLandscape, landscape && { paddingRight: width * (1 - STOP_DOCK_LEFT) }]}>
            <View testID="hud-dial-box">
              <DialView size={dial} signals={signals} testID="hud-dial" />
            </View>
          </View>

          {landscape ? (
            <View style={styles.markDock}>
              <DriveWordmark available={width * (1 - STOP_DOCK_LEFT) - gutter} testID="hud-wordmark" />
            </View>
          ) : null}

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

/**
 * The one control. A red outline, the transport square every recorder has had for fifty years,
 * and the word.
 *
 * NO CAPTION UNDER IT. It read "SAVE & SCORE", which was two promises in four words and one of
 * them is not this button's to make: a run the integrity monitor refuses is saved and NOT scored,
 * and the caption said otherwise on the exact runs where it mattered. What STOP does is stop; the
 * accessibility label carries the rest for the one reader who cannot see the square.
 */
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
    </Pressable>
  );
}

function ErrorOverlay({ error, onRetry, onLeave }: { error: RunError; onRetry: () => void; onLeave: () => void }) {
  const verdict = error.verdict;
  return (
    <View style={styles.overlay} testID="hud-error">
      <Panel accent={colors.red} style={styles.errorCard}>
        <AppText style={[styles.errorTitle, { color: colors.red }]}>{error.title}</AppText>
        {/* A finished run is not lost because the write failed: say what was RECORDED. Not what
            it scored — there is no score on this screen, on either branch, and a total that
            appeared for the first time in a failure dialog would be the only place a driver ever
            saw one. `RunVerdict.trusted` still decides between two sentences, because a run the
            engine refused has to say so before it says anything else, and its peak angle is the
            one figure a loose mount inflates. */}
        {verdict ? (verdict.trusted ? <VerdictRecorded verdict={verdict} /> : <VerdictRefused verdict={verdict} />) : null}
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
 * A run the engine stands behind: what it RECORDED, in the peak angle's own colour.
 *
 * The peak leads because it is the one number this screen has been showing all along — it is the
 * numeral under the dial, in `angleColor` off the same `ANGLE_STOPS` the needle used to reach it
 * — so the dialog continues the sentence the instrument was already saying instead of opening a
 * new one with a letter grade nobody has seen yet.
 */
function VerdictRecorded({ verdict }: { verdict: RunVerdict }) {
  return (
    <View style={styles.verdict} testID="hud-verdict">
      <AppText style={[styles.verdictPeak, { color: angleColor(verdict.peakDeg) }]}>{Math.round(verdict.peakDeg)}°</AppText>
      <View style={styles.verdictFacts}>
        <AppText style={styles.verdictRecorded}>RECORDING KEPT</AppText>
        <Micro>
          {verdict.drifts === 1 ? '1 slide' : `${verdict.drifts} slides`} · {formatDuration(verdict.durationS)}
        </Micro>
      </View>
    </View>
  );
}

/**
 * A run the engine refused. NOT SCORED in the muted grey the rest of the HUD uses for a reading
 * it will not stand behind, the monitor's own sentence for why, and the one thing the driver
 * still has: a recording of that many slides over that long. Deliberately no peak angle — it is
 * the achievement `scoreTrusted` forbids, and a loose mount is exactly what inflates it.
 *
 * NO STRIPE DOWN THE LEFT EDGE. This carried a 3 pt grey bar, and an earmark is banned app-wide
 * for a reason that is at its clearest right here: the bar was the same grey as the headline, so
 * it repeated the one thing the reader had already been told in words, in a place the eye lands
 * first and can take nothing from. SEVERITY IS THE TEXT COLOUR. The headline is 40 pt of muted
 * grey and it is the loudest thing on the card.
 */
function VerdictRefused({ verdict }: { verdict: RunVerdict }) {
  return (
    <View style={styles.verdictRefused} testID="hud-verdict">
      <AppText style={styles.verdictNotScored}>NOT JUDGED</AppText>
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
  // PORTRAIT PUTS THE DIAL AT THE TOP OF WHAT IS LEFT, not in the middle of it.
  //
  // The dial is width-constrained on every phone in portrait (393 pt wide against 536 pt of
  // height available at `DIAL_ASPECT`), so ~170 pt of the band is slack, and where that slack
  // goes is a decision. Centred, it splits: the mark floats 100 pt clear of the instrument and
  // the instrument floats 70 pt clear of STOP, and nothing on the screen belongs to anything.
  // Against the top, the mark and the dial read as one block — which is how the approved mockup
  // is laid out, to within 10 pt of the circle's centre — and the whole of the slack falls in
  // the one place a gap costs nothing, between the numeral and the control.
  stage: { flex: 1, alignItems: 'center', justifyContent: 'flex-start', paddingTop: space[4] },
  // Landscape is the other way round: there the dial is HEIGHT-constrained, the column has no
  // slack to distribute, and centring is the only thing that keeps it off both edges.
  stageLandscape: { justifyContent: 'center', paddingTop: 0 },
  // The mark's band in portrait: in the flow, above the dial, so the dial is sized against the
  // height that is left rather than sharing it.
  markBand: { paddingTop: space[6], alignItems: 'center' },
  // Landscape: the top of the column STOP already owns. Absolute, because that column has no
  // other content to lay out with and the dial must keep the full height of the left one.
  markDock: { position: 'absolute', left: `${STOP_DOCK_LEFT * 100}%`, right: gutter, top: space[3], alignItems: 'center' },
  stopDock: { position: 'absolute', left: gutter, right: gutter, bottom: space[3] },
  // Landscape puts STOP in the right half, clear of the gauge that now spans the frame.
  stopDockLandscape: { left: `${STOP_DOCK_LEFT * 100}%`, right: gutter, bottom: space[2] },

  stop: {
    alignSelf: 'stretch',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space[3],
    // 62 pt, well past the 44 pt minimum: this is the control a driver reaches for without
    // looking, at the moment they have just stopped the car, and it is the only one on screen —
    // there is nothing next to it to hit by mistake, so the target may as well be enormous.
    minHeight: 62,
    borderWidth: 1,
    borderColor: colors.red,
    backgroundColor: 'transparent',
    borderRadius: radii.md,
    paddingVertical: space[2],
    paddingHorizontal: space[5],
  },
  // Landscape has ~390 pt of height and the dial wants all of it. 46 pt still clears the 44 pt
  // minimum; below that this stops being a touch target and starts being a hazard.
  stopCompact: { minHeight: 46, paddingVertical: space[1] },
  stopSquare: { width: 17, height: 17, borderRadius: 3, backgroundColor: colors.red },
  stopLabel: { fontFamily: fontFamilies.display.extraboldItalic, fontSize: 27, lineHeight: 30, color: colors.red, letterSpacing: 1 },
  pressed: { opacity: 0.7 },

  overlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', padding: gutter, backgroundColor: alpha(colors.bg0, 0.62) },
  // Uppercase because every other headline on this screen is (NOT SCORED, RECORDING KEPT,
  // SAVING RUN): a dialog is not the place the HUD suddenly starts speaking in sentences.
  errorTitle: { fontFamily: fontFamilies.display.extraboldItalic, fontSize: 34, lineHeight: 36, color: colors.text, letterSpacing: -0.2, textTransform: 'uppercase' },

  errorCard: { maxWidth: 420, gap: space[3] },
  verdict: { flexDirection: 'row', alignItems: 'center', gap: space[4] },
  verdictRefused: { gap: space[2] },
  // The weight the peak angle has on the other branch, in the colour that means "not an
  // achievement": the refusal is the headline of this card, not a footnote under one.
  verdictNotScored: { fontFamily: fontFamilies.display.extraboldItalic, fontSize: 40, lineHeight: 42, color: colors.muted, letterSpacing: 0.5 },
  verdictPeak: { fontFamily: fontFamilies.display.extraboldItalic, fontSize: 64, lineHeight: 62, letterSpacing: -1 },
  verdictFacts: { gap: 2 },
  verdictRecorded: { fontFamily: fontFamilies.display.bold, fontSize: 22, lineHeight: 24, color: colors.text, letterSpacing: 0.6 },
  errorButtons: { flexDirection: 'row', gap: space[3], marginTop: space[2] },

  saving: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', backgroundColor: alpha(colors.bg0, 0.88) },
  savingText: { fontFamily: fontFamilies.display.extraboldItalic, fontSize: 34, lineHeight: 36, color: colors.green, letterSpacing: 1 },
});
