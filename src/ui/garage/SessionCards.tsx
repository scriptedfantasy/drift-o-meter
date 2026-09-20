/**
 * The two ways the garage shows a run: the big card for the one you just did, and a row for
 * everything before it.
 *
 * Both carry the same six facts — grade, points, best angle, track, date, duration — and both
 * obey the same rule: a run the engine will not vouch for gets no grade and no boast. Its
 * points are labelled for what they are, the monitor's own sentence is printed underneath, and
 * the card offers the recording instead of the result.
 */
import { LinearGradient } from 'expo-linear-gradient';
import { Pressable, StyleSheet, View } from 'react-native';

import type { SessionIndexEntry } from '../../platform';
import { formatDate, formatDuration, formatScore } from '../format';
import { AppText, Micro, Small } from '../Text';
import { alpha, colors, radii, space } from '../theme';
import { GradeBadge, gradeStateColor, gradeStateOf } from './GradeBadge';
import type { LastRunDetail } from './lastRun';

export interface RunProps {
  /** Everything a row shows now lives in the index — no session body is read to draw one. */
  entry: SessionIndexEntry;
  onOpen(): void;
  onDelete(): void;
  testID?: string;
}

export interface LastRunCardProps extends RunProps {
  /** The newest run's body, once it has been read. The rest of the card does not wait for it. */
  detail?: LastRunDetail | null;
  /**
   * False when the garage is already showing the monitor's sentence above this card. The same
   * sentence twice in one viewport costs a third of the screen in the app's most urgent state.
   */
  showReason?: boolean;
}

/**
 * The biggest angle a run can claim — and `--` when it cannot claim one.
 *
 * `SessionIndexEntry.peakAngleDeg` already excludes spun drifts, for the same reason the scorer
 * does: the angle a car reaches while spinning is not one the driver held. On top of that, a run
 * the engine threw out reports no angle at all — the raw peak of a hand-held recording came out
 * at 85°, bigger than any angle any trusted run on the board holds, and printing that under the
 * word "best" in muted grey is still printing it.
 */
function angleText(entry: SessionIndexEntry, untrusted: boolean): string {
  if (untrusted || !(entry.peakAngleDeg > 0)) return '--';
  return `${Math.round(entry.peakAngleDeg)}°`;
}

/** The run a driver most likely came back to look at. Twice the size of everything below it. */
export function LastRunCard({ entry, detail, onOpen, onDelete, showReason = true, testID }: LastRunCardProps) {
  const state = gradeStateOf(entry.grade, entry.trusted);
  const accent = gradeStateColor(state);
  const untrusted = state.kind === 'void';
  const pending = state.kind === 'pending';

  return (
    <Pressable
      onPress={onOpen}
      onLongPress={onDelete}
      delayLongPress={420}
      accessibilityRole="button"
      accessibilityLabel={`${entry.name}, ${untrusted ? 'not scored' : `grade ${entry.grade}`}, ${formatScore(entry.total)} points`}
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
        <GradeBadge state={state} size={96} />
        <View style={styles.cardScore}>
          <Micro>{untrusted ? 'Points logged' : 'Points'}</Micro>
          <AppText variant="display" color={untrusted ? colors.muted : colors.ember} numeric numberOfLines={1} style={styles.points}>
            {pending ? '--' : formatScore(entry.total)}
          </AppText>
          {untrusted ? <Micro color="red">A floor, not a measurement</Micro> : null}
        </View>
      </View>

      <AppText variant="subheading" numberOfLines={1} style={styles.trackName}>
        {entry.track ?? entry.name}
      </AppText>
      {untrusted ? <Micro numberOfLines={1}>{formatDate(entry.startedAt)}</Micro> : null}

      {untrusted && showReason && detail?.message ? (
        <Small color="red" style={styles.voidNote} numberOfLines={3}>
          {detail.message}
        </Small>
      ) : null}

      <View style={styles.cardStats}>
        <CardStat
          label={untrusted ? 'Angle' : 'Best angle'}
          value={angleText(entry, untrusted)}
          color={untrusted || !entry.peakAngleDeg ? colors.muted : colors.ember}
        />
        <CardStat label={entry.drifts === 1 ? 'Slide' : 'Slides'} value={String(entry.drifts)} color={colors.text} />
        <CardStat
          label={untrusted ? 'Mount' : 'Best chain'}
          value={untrusted ? (detail?.mount ?? 'loose').toUpperCase() : formatScore(entry.longestChainPoints)}
          color={untrusted ? colors.red : colors.magenta}
        />
      </View>

      <Micro color={untrusted ? 'red' : 'muted'} style={styles.cta}>
        {untrusted ? 'Open the recording →' : 'Open the full result →'}
      </Micro>
    </Pressable>
  );
}

function CardStat({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <View style={styles.cardStat}>
      <Micro numberOfLines={1}>{label}</Micro>
      <AppText variant="telemetry" color={color} numeric numberOfLines={1} style={styles.cardStatValue}>
        {value}
      </AppText>
    </View>
  );
}

/** Everything older: one line each, same six facts, a tenth of the ink. */
export function RunRow({ entry, onOpen, onDelete, testID }: RunProps) {
  const state = gradeStateOf(entry.grade, entry.trusted);
  const accent = gradeStateColor(state);
  const untrusted = state.kind === 'void';
  const pending = state.kind === 'pending';

  return (
    <Pressable
      onPress={onOpen}
      onLongPress={onDelete}
      delayLongPress={420}
      accessibilityRole="button"
      accessibilityLabel={`${entry.name}, ${untrusted ? 'not scored' : `grade ${entry.grade}`}`}
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
          {pending ? '--' : formatScore(entry.total)}
        </AppText>
        <Micro color={untrusted ? 'red' : 'muted'} numberOfLines={1}>
          {untrusted ? 'logged only' : `${angleText(entry, false)} best`}
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
  trackName: { marginTop: space[1] },
  voidNote: { borderLeftWidth: 2, borderLeftColor: colors.red, paddingLeft: space[3], marginTop: space[1] },
  cardStats: { flexDirection: 'row', justifyContent: 'space-between', gap: space[2], marginTop: space[3], borderTopWidth: 1, borderTopColor: colors.line, paddingTop: space[3] },
  cardStat: { gap: 1, minWidth: 0, flex: 1 },
  cardStatValue: { fontSize: 24, lineHeight: 26 },
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
