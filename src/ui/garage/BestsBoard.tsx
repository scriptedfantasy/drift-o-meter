/**
 * Personal bests, one panel per track: best grade, most points, biggest angle, longest chain.
 *
 * Every tile is a link to the run that holds the record, because a record with no run behind it
 * is a claim rather than a fact. Tracks with nothing scored yet say so instead of printing
 * zeros — and a run the engine would not vouch for never appears here at all.
 */
import { Pressable, StyleSheet, View } from 'react-native';

import { formatDate } from '../format';
import { AppText, Micro } from '../Text';
import { alpha, colors, gradeColors, radii, space } from '../theme';
import type { BestRecord, TrackBests } from './bests';
import { bestGradeOf } from './bests';

export interface BestsBoardProps {
  bests: readonly TrackBests[];
  onOpen(record: BestRecord): void;
}

export function BestsBoard({ bests, onOpen }: BestsBoardProps) {
  return (
    <View style={styles.board}>
      {bests.map((t) => (
        <TrackPanel key={t.track} bests={t} onOpen={onOpen} />
      ))}
      <Micro numberOfLines={2} style={styles.footnote}>
        Only runs the engine vouched for can hold a record — and the biggest angle is one you held and
        drove out of, not one you spun into
      </Micro>
    </View>
  );
}

function TrackPanel({ bests, onOpen }: { bests: TrackBests; onOpen(record: BestRecord): void }) {
  const grade = bestGradeOf(bests);
  const accent = grade ? (gradeColors[grade] ?? colors.ember) : colors.line;
  return (
    <View style={[styles.panel, { borderLeftColor: accent }]} testID={`bests-${bests.track.replace(/\s+/g, '-').toLowerCase()}`}>
      <View style={styles.head}>
        <AppText variant="subheading" numberOfLines={1} style={styles.track}>
          {bests.track}
        </AppText>
        <Micro numberOfLines={1}>
          {bests.runs === 1 ? '1 run' : `${bests.runs} runs`}
          {bests.scored < bests.runs ? ` · ${bests.runs - bests.scored} not scored` : ''}
        </Micro>
      </View>
      {bests.scored === 0 ? (
        <Micro color="red" style={styles.none}>
          Nothing here counts yet — the engine would not vouch for {bests.runs === 1 ? 'that run' : 'any of these runs'}
        </Micro>
      ) : bests.framing ? (
        <Micro style={styles.framing} numberOfLines={2}>
          {bests.framing}
        </Micro>
      ) : null}
      <View style={styles.grid}>
        {bests.records.map((r) => (
          <RecordTile key={r.key} record={r} accent={r.key === 'grade' ? accent : tileColor(r.key)} onOpen={onOpen} />
        ))}
      </View>
      <Micro numberOfLines={1} style={styles.last}>
        Last driven {formatDate(bests.lastAt)}
      </Micro>
    </View>
  );
}

function tileColor(key: BestRecord['key']): string {
  switch (key) {
    case 'points':
      return colors.ember;
    case 'angle':
      return colors.gold;
    default:
      return colors.magenta;
  }
}

function RecordTile({ record, accent, onOpen }: { record: BestRecord; accent: string; onOpen(record: BestRecord): void }) {
  const dim = record.empty;
  return (
    <Pressable
      disabled={dim}
      onPress={() => onOpen(record)}
      accessibilityRole="button"
      accessibilityLabel={`${record.label} ${record.value}`}
      style={({ pressed }) => [styles.tile, { borderColor: alpha(dim ? colors.line : accent, 0.5) }, pressed && styles.pressed]}>
      <Micro numberOfLines={1}>{record.label}</Micro>
      <AppText variant="telemetry" color={dim ? colors.muted : accent} numeric numberOfLines={1} style={styles.value}>
        {record.value}
      </AppText>
      {record.note ? (
        <Micro numberOfLines={1} style={styles.note}>
          {record.note}
        </Micro>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  board: { gap: space[3] },
  panel: {
    backgroundColor: colors.bg1,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.line,
    borderLeftWidth: 3,
    padding: space[4],
    gap: space[3],
  },
  head: { gap: 1 },
  track: { letterSpacing: 0.8 },
  none: { maxWidth: 320 },
  framing: { maxWidth: 330, textTransform: 'none', letterSpacing: 0.2, opacity: 0.85 },
  note: { textTransform: 'none', letterSpacing: 0.2, opacity: 0.8 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: space[2] },
  tile: {
    flexGrow: 1,
    flexBasis: '46%',
    minWidth: 130,
    borderWidth: 1,
    borderRadius: radii.md,
    backgroundColor: colors.bg2,
    paddingHorizontal: space[3],
    paddingVertical: space[2],
    gap: 1,
  },
  value: { fontSize: 30, lineHeight: 32 },
  last: {},
  footnote: { textTransform: 'none', letterSpacing: 0.2, opacity: 0.75, maxWidth: 420 },
  pressed: { opacity: 0.7 },
});
