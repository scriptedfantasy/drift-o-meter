/**
 * The two ways the garage shows a run: the big card for the one you just did, and a row for
 * everything before it.
 *
 * Both are drawn from `SessionIndexEntry` alone — no session body is read to draw either one —
 * and both obey the same rule: a run the engine will not vouch for gets no grade, no record,
 * and **no total**. `SessionIntegrity.scoreTrusted`'s contract says a consumer "MUST NOT present
 * the total… Show `message` instead and offer the run as a recording", so the points slot is a
 * dash and the slot says how long the recording is. It used to print "POINTS LOGGED 155 — A
 * FLOOR, NOT A MEASUREMENT" at 52 px, which is exactly the claim the engine refuses to make.
 *
 * The card also answers the question a career screen exists to answer: what did the run you
 * just did do to your own numbers (`lastRunStanding`).
 */
import { LinearGradient } from 'expo-linear-gradient';
import { useCallback, useState } from 'react';
import { Pressable, StyleSheet, View, type LayoutChangeEvent } from 'react-native';

import type { MountVerdict, SessionIndexEntry } from '../../platform';
import { formatDate, formatDuration, formatScore } from '../format';
import { AppText, Micro, Small } from '../Text';
import { alpha, colors, radii, space } from '../theme';
import { monitorSentence } from './advice';
import { GradeBadge } from './GradeBadge';
import { gradeStateColor, gradeStateOf } from './grade';
import { angleText, pointsText, rowFootnote, slidesText } from './labels';
import SlideTraceView from './SlideTraceView';
import { traceLegend } from './trace';

/**
 * The mount verdict's own colour. Red is the danger token, and RIGID is not a danger: a run
 * thrown out for GPS or physics printed MOUNT · RIGID in `#FF3B3B`, colouring the one fact about
 * it that was fine. The slot follows the verdict, not the run.
 */
function mountColor(mount: MountVerdict): string {
  return mount === 'loose' ? colors.red : mount === 'suspect' ? colors.gold : colors.text;
}

export interface RunProps {
  /** Everything a row shows now lives in the index — no session body is read to draw one. */
  entry: SessionIndexEntry;
  onOpen(): void;
  onDelete(): void;
  testID?: string;
}

export interface LastRunCardProps extends RunProps {
  /**
   * What this run did to the records on its track — "New record — biggest angle", or how far
   * off the best it landed. Null when there is nothing true to say.
   */
  standing?: string | null;
  /**
   * False when the garage is already showing the monitor's sentence above this card. The same
   * sentence twice in one viewport costs a third of the screen in the app's most urgent state.
   */
  showReason?: boolean;
}

/** The run a driver most likely came back to look at. Twice the size of everything below it. */
export function LastRunCard({ entry, standing, onOpen, onDelete, showReason = true, testID }: LastRunCardProps) {
  const state = gradeStateOf(entry.grade, entry.trusted);
  const accent = gradeStateColor(state);
  const untrusted = state.kind === 'void';
  const points = pointsText(entry, state.kind);
  const slides = slidesText(entry, untrusted);

  return (
    <Pressable
      onPress={onOpen}
      onLongPress={onDelete}
      delayLongPress={420}
      accessibilityRole="button"
      accessibilityLabel={`${entry.name}, ${untrusted ? `not scored, recording ${formatDuration(entry.durationS)}` : `grade ${entry.grade}, ${formatScore(entry.total)} points`}`}
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
        <Micro color={untrusted ? 'red' : 'ember'} numberOfLines={1}>
          {untrusted ? 'Not judged' : formatDate(entry.startedAt)}
        </Micro>
        <Micro numberOfLines={1}>{formatDuration(entry.durationS)}</Micro>
      </View>

      <View style={styles.cardBody}>
        <GradeBadge state={state} size={96} animate />
        <View style={styles.cardScore}>
          <Micro>Points</Micro>
          <AppText variant="display" color={untrusted ? colors.muted : colors.ember} numeric numberOfLines={1} style={styles.points}>
            {points.value}
          </AppText>
          {points.note ? <Micro color={untrusted ? 'red' : 'muted'}>{points.note}</Micro> : null}
        </View>
      </View>

      <SlideTraceStrip entry={entry} untrusted={untrusted} />

      <AppText variant="subheading" numberOfLines={1} style={styles.trackName}>
        {entry.track ?? entry.name}
      </AppText>
      {untrusted ? <Micro numberOfLines={1}>{formatDate(entry.startedAt)}</Micro> : null}
      {!untrusted && standing ? (
        <Micro color={/^new record/i.test(standing) ? 'gold' : 'muted'} numberOfLines={2} style={styles.standing}>
          {standing}
        </Micro>
      ) : null}

      {untrusted && showReason && entry.integrityMessage ? (
        <Small color="red" style={styles.voidNote} numberOfLines={3}>
          {monitorSentence(entry.integrityMessage)}
        </Small>
      ) : null}

      <View style={styles.cardStats}>
        <CardStat
          label={untrusted ? 'Angle' : 'Held angle'}
          value={angleText(entry, untrusted)}
          color={untrusted || !entry.heldPeakDeg ? colors.muted : colors.ember}
        />
        <CardStat label={entry.drifts === 1 && entry.spins === 0 ? 'Slide' : 'Slides'} value={slides.value} note={slides.note} color={colors.text} />
        <CardStat
          label={untrusted ? 'Mount' : 'Best chain'}
          value={untrusted ? entry.mount.toUpperCase() : formatScore(entry.longestChainPoints)}
          color={untrusted ? mountColor(entry.mount) : colors.magenta}
        />
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
function SlideTraceStrip({ entry, untrusted }: { entry: SessionIndexEntry; untrusted: boolean }) {
  const [width, setWidth] = useState(0);
  const onLayout = useCallback((e: LayoutChangeEvent) => setWidth(Math.round(e.nativeEvent.layout.width)), []);
  const has = entry.slides.length > 0;
  const legend = traceLegend(entry.slides, { believed: !untrusted });
  return (
    <View style={styles.trace} onLayout={onLayout}>
      <View style={styles.traceLegend}>
        <Micro numberOfLines={1}>{legend.left}</Micro>
        <Micro numberOfLines={1} color={legend.alarm ? 'red' : 'muted'}>
          {legend.right}
        </Micro>
      </View>
      {has && width > 0 ? (
        <SlideTraceView slides={entry.slides} width={width} believed={!untrusted} testID="last-run-trace" />
      ) : (
        <View style={styles.traceEmpty} />
      )}
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
export function RunRow({ entry, onOpen, onDelete, testID }: RunProps) {
  const state = gradeStateOf(entry.grade, entry.trusted);
  const accent = gradeStateColor(state);
  const untrusted = state.kind === 'void';
  const points = pointsText(entry, state.kind);

  return (
    <Pressable
      onPress={onOpen}
      onLongPress={onDelete}
      delayLongPress={420}
      accessibilityRole="button"
      accessibilityLabel={`${entry.name}, ${untrusted ? 'not scored, recording only' : `grade ${entry.grade}`}`}
      testID={testID}
      style={({ pressed }) => [styles.row, { borderLeftColor: accent }, pressed && styles.pressed]}>
      <GradeBadge state={state} size={untrusted ? 46 : 44} style={styles.rowBadge} />
      <View style={styles.rowText}>
        <AppText variant="bodyStrong" numberOfLines={1}>
          {entry.track ?? entry.name}
        </AppText>
        <Micro numberOfLines={1}>
          {formatDate(entry.startedAt)} · {formatDuration(entry.durationS)}
        </Micro>
      </View>
      <View style={styles.rowRight}>
        <AppText variant="telemetry" color={untrusted ? colors.muted : colors.ember} numeric numberOfLines={1} style={styles.rowPoints}>
          {points.value}
        </AppText>
        <Micro color={untrusted ? 'red' : 'muted'} numberOfLines={1}>
          {rowFootnote(entry, state.kind)}
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
  cardScore: { flex: 1, alignItems: 'flex-end', gap: 0 },
  points: { fontSize: 52, lineHeight: 52, letterSpacing: -2 },
  trace: { marginTop: space[1], gap: 2 },
  traceLegend: { flexDirection: 'row', justifyContent: 'space-between', gap: space[2] },
  traceEmpty: { height: 58, borderBottomWidth: 1, borderBottomColor: alpha(colors.text, 0.14) },
  trackName: { marginTop: space[1] },
  standing: { textTransform: 'none', letterSpacing: 0.2 },
  voidNote: { borderLeftWidth: 2, borderLeftColor: colors.red, paddingLeft: space[3], marginTop: space[1] },
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
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.line,
    borderLeftWidth: 3,
    paddingVertical: space[3],
    paddingHorizontal: space[3],
  },
  rowBadge: { marginRight: space[1] },
  rowText: { flex: 1, gap: 1, minWidth: 0 },
  rowRight: { alignItems: 'flex-end', gap: 1 },
  rowPoints: { fontSize: 26, lineHeight: 28 },
  pressed: { opacity: 0.72 },
});
