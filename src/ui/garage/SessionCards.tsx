/**
 * The two ways the garage shows a run: the big card for the one you just did, and a row for
 * everything before it.
 *
 * Both are drawn from `SessionIndexEntry` alone — no session body is read to draw either one —
 * and both lead with the ANGLE. That is the whole of the change the letters left behind: a
 * grade was a summary of four things nobody asked for, and the number a driver came back to
 * the phone to see is how far sideways they got and how long they kept it there.
 *
 * The rule the letters were carrying is still here, in the colour. A run the engine will not
 * vouch for is RED — not dimmed, not dressed down, red, the same as the tail lights and the
 * STOP control — and it publishes no judged figure at all
 * (`SessionIntegrity.scoreTrusted`: a consumer "MUST NOT present the total… Show `message`
 * instead and offer the run as a recording"). A judged run takes the colour of the angle it
 * held, off the one ramp every screen in the app shares.
 *
 * The card also answers the question a career screen exists to answer: what did the run you
 * just did do to your own biggest angle (`lastRunStanding`).
 */
import { LinearGradient } from 'expo-linear-gradient';
import { useCallback, useState } from 'react';
import { Pressable, StyleSheet, View, type LayoutChangeEvent } from 'react-native';

import type { MountVerdict, SessionIndexEntry } from '../../platform';
import { formatDate, formatDuration } from '../format';
import { AppText, Micro, Small } from '../Text';
import { alpha, angleColor, colors, radii, space } from '../theme';
import { monitorSentence } from './advice';
import { angleText, holdText, rowFootnote, runShapeText, slidesText } from './labels';
import { peakHold, sidewaysSeconds } from './runFacts';
import { runStateColor, runStateOf } from './runState';
import SlideTraceView from './SlideTraceView';
import { traceHeight, traceLegend, TRACE_GUTTER_DP } from './trace';

/**
 * The mount verdict's own colour. Red is the danger token, and RIGID is not a danger: a run
 * thrown out for GPS or physics printed MOUNT · RIGID in red, colouring the one fact about it
 * that was fine. The slot follows the verdict, not the run.
 */
function mountColor(mount: MountVerdict): string {
  return mount === 'loose' ? colors.red : mount === 'suspect' ? colors.greenHot : colors.text;
}

export interface RunProps {
  /** Everything a row shows now lives in the index — no session body is read to draw one. */
  entry: SessionIndexEntry;
  /**
   * Whose run this is, when the list is not already one person's.
   *
   * Null when the list is filtered to a driver, because repeating their name down every row of
   * a list headed with it is noise. Non-null when nobody is at the wheel and the list is
   * showing everything — and then it is the only thing on the row that says whose run it was,
   * which is half of what several people sharing a car opened this screen to find out.
   */
  who?: string | null;
  onOpen(): void;
  onDelete(): void;
  testID?: string;
}

export interface LastRunCardProps extends RunProps {
  /**
   * What this run did to its driver's biggest angle — "New biggest angle — 56°", or how far
   * off it landed. Null when there is nothing true to say.
   */
  standing?: string | null;
  /**
   * False when the garage is already showing the monitor's sentence above this card. The same
   * sentence twice in one viewport costs a third of the screen in the app's most urgent state.
   */
  showReason?: boolean;
}

/** The run a driver most likely came back to look at. Twice the size of everything below it. */
export function LastRunCard({ entry, standing, who = null, onOpen, onDelete, showReason = true, testID }: LastRunCardProps) {
  const state = runStateOf(entry.trusted);
  const untrusted = state.kind === 'void';
  const accent = runStateColor(state, entry.heldPeakDeg);
  const angle = angleText(entry, untrusted);
  const slide = untrusted ? 0 : peakHold(entry).slideS;
  const slides = slidesText(entry, untrusted);
  const sideways = sidewaysSeconds(entry);

  return (
    <Pressable
      onPress={onOpen}
      onLongPress={onDelete}
      delayLongPress={420}
      accessibilityRole="button"
      accessibilityLabel={`${entry.name}, ${untrusted ? `not judged, recording ${formatDuration(entry.durationS)}` : `biggest angle ${angle}`}`}
      testID={testID}
      style={({ pressed }) => [styles.card, { borderColor: alpha(accent, 0.55) }, pressed && styles.pressed]}>
      <LinearGradient
        colors={[alpha(accent, untrusted ? 0.2 : 0.26), alpha(accent, 0.05), 'transparent']}
        locations={[0, 0.55, 1]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={styles.wash}
        pointerEvents="none"
      />
      <View style={styles.cardHead}>
        <Micro color={untrusted ? 'red' : 'green'} numberOfLines={1}>
          {untrusted ? 'Not judged' : formatDate(entry.startedAt)}
        </Micro>
        <Micro numberOfLines={1}>{who ? `${who} · ${formatDuration(entry.durationS)}` : formatDuration(entry.durationS)}</Micro>
      </View>

      <View style={styles.cardBody}>
        <View style={styles.cardAngle}>
          <Micro>{untrusted ? 'Angle' : 'Biggest angle'}</Micro>
          <AppText
            variant="display"
            color={untrusted ? colors.muted : accent}
            numeric
            numberOfLines={1}
            style={[styles.angle, angle === '--' && styles.angleDash]}>
            {angle}
          </AppText>
          <Micro color={untrusted ? 'red' : 'muted'} numberOfLines={1}>
            {untrusted ? `Recording · ${formatDuration(entry.durationS)}` : slide > 0 ? `In a ${holdText(slide)} slide` : 'Nothing held'}
          </Micro>
        </View>
      </View>

      <SlideTraceStrip entry={entry} untrusted={untrusted} accent={accent} />

      <AppText variant="subheading" numberOfLines={1} style={styles.trackName}>
        {entry.track ?? entry.name}
      </AppText>
      {untrusted ? <Micro numberOfLines={1}>{formatDate(entry.startedAt)}</Micro> : null}
      {!untrusted && standing ? (
        <Micro color={/^new /i.test(standing) ? 'green' : 'muted'} numberOfLines={2} style={styles.standing}>
          {standing}
        </Micro>
      ) : null}

      {untrusted && showReason && entry.integrityMessage ? (
        <Small color="red" style={styles.voidNote} numberOfLines={3}>
          {monitorSentence(entry.integrityMessage)}
        </Small>
      ) : null}

      <View style={styles.cardStats}>
        <CardStat label={entry.drifts === 1 && entry.spins === 0 ? 'Slide' : 'Slides'} value={slides.value} note={slides.note} color={colors.text} />
        <CardStat
          label={untrusted ? 'Mount' : 'Sideways'}
          value={untrusted ? entry.mount.toUpperCase() : sideways > 0 ? formatDuration(sideways) : '--'}
          color={untrusted ? mountColor(entry.mount) : colors.blue}
        />
        <CardStat label="Run length" value={formatDuration(entry.durationS)} color={colors.blue} />
      </View>

      <Micro color={untrusted ? 'red' : 'muted'} style={styles.cta}>
        {untrusted ? 'Open the recording →' : 'Open the full result →'}
      </Micro>
    </Pressable>
  );
}

/**
 * The run's own shape, drawn in Skia from the slides the index carries.
 *
 * The caption comes from `trace.ts` together with the geometry, because the two have to agree:
 * an axis headed "held angle" may only ever have held angles on it, so a spin and a run the
 * monitor did not believe become footprints under the axis and the caption says which picture
 * this is. It used to head every mark "HELD ANGLE THROUGH THE RUN · 60° TOP" while drawing the
 * spins at their instantaneous peak, clamped — three identical full-height walls over a card
 * that said HELD ANGLE 18°.
 */
function SlideTraceStrip({ entry, untrusted, accent }: { entry: SessionIndexEntry; untrusted: boolean; accent: string }) {
  const [width, setWidth] = useState(0);
  const onLayout = useCallback((e: LayoutChangeEvent) => setWidth(Math.round(e.nativeEvent.layout.width)), []);
  const has = entry.slides.length > 0;
  const believed = !untrusted;
  const legend = traceLegend(entry.slides, { believed });
  // A run with nothing on the axis gets a strip rather than a plot, and the placeholder that
  // stands in before layout has to be the same height or the card jumps when it arrives.
  const height = traceHeight(entry.slides, { believed });
  return (
    <View style={styles.trace} onLayout={onLayout}>
      <View style={styles.traceLegend}>
        <Micro numberOfLines={1}>{legend.left}</Micro>
        <Micro numberOfLines={1} color={legend.alarm ? 'red' : 'muted'}>
          {legend.right}
        </Micro>
      </View>
      {/* Two named boxes over the same plot, so a harness check can be about the PLOT, and about
          the AXIS, rather than about the card. A maximum is the only shape of check that can
          prove an absence (docs/CRITIC.md rule 15), and the absence this screen has to prove is
          that no spin — and nothing at all from a run the monitor did not believe — is drawn on
          the held-angle axis. `last-run-axis` is everything above the gutter, so "0 red pixels
          inside it" is exactly that claim, and it FAILED while the defect was on screen: the
          spins were drawn in red, full height, up to the ceiling.

          The boxes are needed because Skia's `<Canvas>` does not carry its testID onto the DOM
          node on web, and because a testID names a whole element — there is no way to ask about
          the top of one. The overlay draws nothing and takes no touches. */}
      <View testID="last-run-plot">
        {has && width > 0 ? (
          <SlideTraceView slides={entry.slides} width={width} height={height} believed={believed} color={accent} testID="last-run-trace" />
        ) : (
          <View style={[styles.traceEmpty, { height }]} />
        )}
        <View testID="last-run-axis" pointerEvents="none" style={[styles.traceAxis, { bottom: TRACE_GUTTER_DP }]} />
      </View>
    </View>
  );
}

function CardStat({ label, value, note, color }: { label: string; value: string; note?: string | null; color: string }) {
  return (
    <View style={styles.cardStat}>
      <Micro numberOfLines={1}>{label}</Micro>
      <AppText variant="telemetry" color={color} numeric numberOfLines={1} style={styles.cardStatValue}>
        {value}
      </AppText>
      {note ? (
        <Micro numberOfLines={1} color="red" style={styles.cardStatNote}>
          {note}
        </Micro>
      ) : null}
    </View>
  );
}

/** Everything older: one line each, same facts, a tenth of the ink. */
export function RunRow({ entry, who = null, onOpen, onDelete, testID }: RunProps) {
  const state = runStateOf(entry.trusted);
  const untrusted = state.kind === 'void';
  const angle = angleText(entry, untrusted);
  const slide = untrusted ? 0 : peakHold(entry).slideS;

  return (
    <Pressable
      onPress={onOpen}
      onLongPress={onDelete}
      delayLongPress={420}
      accessibilityRole="button"
      accessibilityLabel={`${who ? `${who}, ` : ''}${entry.name}, ${untrusted ? 'not judged, recording only' : `biggest angle ${angle}`}`}
      testID={testID}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}>
      <View style={styles.rowText}>
        <AppText variant="bodyStrong" numberOfLines={1}>
          {formatDate(entry.startedAt)}
        </AppText>
        <Micro numberOfLines={1} color={untrusted ? 'red' : 'muted'} style={styles.rowShape}>
          {who ? (
            <AppText variant="micro" color="text">
              {who} ·{' '}
            </AppText>
          ) : null}
          {runShapeText(entry, state.kind)}
        </Micro>
      </View>
      <View style={styles.rowRight}>
        <AppText
          variant="telemetry"
          color={untrusted || !(entry.heldPeakDeg > 0) ? colors.muted : angleColor(entry.heldPeakDeg)}
          numeric
          numberOfLines={1}
          style={styles.rowAngle}>
          {angle}
        </AppText>
        <Micro color={untrusted ? 'red' : 'muted'} numberOfLines={1}>
          {state.kind === 'judged' && slide > 0 ? `${holdText(slide)} slide` : rowFootnote(entry, state.kind)}
        </Micro>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: 1,
    borderRadius: radii.lg,
    backgroundColor: colors.bg1,
    padding: space[4],
    gap: space[2],
    overflow: 'hidden',
  },
  wash: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  cardHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  cardBody: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: space[3] },
  cardAngle: { flex: 1, gap: 0 },
  angle: { fontSize: 64, lineHeight: 62, letterSpacing: -2 },
  // Two dashes set at 64 px leave most of a line box empty and read as a rendering fault rather
  // than as a refusal. The refusal is already carried by the red; this just stops it gaping.
  angleDash: { fontSize: 40, lineHeight: 48 },
  trace: { marginTop: space[1], gap: 2 },
  traceLegend: { flexDirection: 'row', justifyContent: 'space-between', gap: space[2] },
  traceEmpty: { borderBottomWidth: 1, borderBottomColor: alpha(colors.text, 0.14) },
  // Measured, not drawn: the band of the plot that is the angle axis (see SlideTraceStrip).
  traceAxis: { position: 'absolute', left: 0, right: 0, top: 0 },
  trackName: { marginTop: space[1] },
  standing: { textTransform: 'none', letterSpacing: 0.2 },
  // No stripe down the side: severity is the colour of the words, and these words are red.
  voidNote: { marginTop: space[1] },
  cardStats: { flexDirection: 'row', justifyContent: 'space-between', gap: space[2], marginTop: space[3], borderTopWidth: 1, borderTopColor: colors.line, paddingTop: space[3] },
  cardStat: { gap: 1, minWidth: 0, flex: 1 },
  cardStatValue: { fontSize: 24, lineHeight: 26 },
  cardStatNote: { textTransform: 'none', letterSpacing: 0.2, opacity: 0.9 },
  cta: { marginTop: space[2] },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[3],
    backgroundColor: colors.bg1,
    borderRadius: radii.md,
    minHeight: 56,
    paddingVertical: space[2],
    paddingHorizontal: space[3],
  },
  rowText: { flex: 1, gap: 1, minWidth: 0 },
  rowShape: { textTransform: 'none', letterSpacing: 0.3 },
  rowRight: { alignItems: 'flex-end', gap: 1 },
  rowAngle: { fontSize: 26, lineHeight: 28 },
  pressed: { opacity: 0.72 },
});
