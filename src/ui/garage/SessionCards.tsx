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
import type { SessionFacts } from './facts';
import { GradeBadge, gradeStateColor, gradeStateOf } from './GradeBadge';

export interface RunProps {
  entry: SessionIndexEntry;
  /** Undefined until the run's verdict has been read off disk. */
  facts: SessionFacts | undefined;
  onOpen(): void;
  onDelete(): void;
  testID?: string;
}

function angleText(facts: SessionFacts | undefined): string {
  if (!facts) return '--';
  const deg = facts.peakAngleDeg > 0 ? facts.peakAngleDeg : facts.rawPeakAngleDeg;
  return deg > 0 ? `${Math.round(deg)}°` : '--';
}

/** The run a driver most likely came back to look at. Twice the size of everything below it. */
export function LastRunCard({ entry, facts, onOpen, onDelete, testID }: RunProps) {
  const state = gradeStateOf(entry.grade, facts?.trusted);
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

      {untrusted && facts?.message ? (
        <Small color="red" style={styles.voidNote} numberOfLines={3}>
          {facts.message}
        </Small>
      ) : null}

      <View style={styles.cardStats}>
        <CardStat label="Best angle" value={angleText(facts)} color={untrusted || !facts?.peakAngleDeg ? colors.muted : colors.ember} />
        <CardStat label={entry.drifts === 1 ? 'Slide' : 'Slides'} value={String(entry.drifts)} color={colors.text} />
        <CardStat
          label={untrusted ? 'Mount' : 'Best chain'}
          value={untrusted ? (facts?.mount ?? 'loose').toUpperCase() : facts ? formatScore(facts.longestChainPoints) : '--'}
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
export function RunRow({ entry, facts, onOpen, onDelete, testID }: RunProps) {
  const state = gradeStateOf(entry.grade, facts?.trusted);
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
          {untrusted ? 'logged only' : `${angleText(facts)} best`}
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
