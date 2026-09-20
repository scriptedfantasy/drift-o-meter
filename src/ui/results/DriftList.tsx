/**
 * Every slide of the session, in order, each with its own |β| sparkline on a shared angle
 * scale so the rows compare honestly. Tapping a row seeks the replay to that moment.
 */
import { Pressable, StyleSheet, View } from 'react-native';
import Animated from 'react-native-reanimated';

import { AppText } from '../Text';
import { formatScore } from '../format';
import { alpha, colors, radii, space } from '../theme';
import { useEnter } from './entrance';
import type { DriftRow } from './model';
import { Sparkline } from './Sparkline';
import { Tag } from './parts';

export interface DriftListProps {
  rows: DriftRow[];
  /** Sparkline width in dp. */
  sparkWidth: number;
  run: boolean;
  reduceMotion?: boolean;
  onSeek(row: DriftRow): void;
  testID?: string;
}

export function DriftList({ rows, sparkWidth, run, reduceMotion = false, onSeek, testID }: DriftListProps) {
  // one y-scale for every row: 15° steps, at least up to the biggest peak (or the spin line)
  const peak = rows.reduce((m, r) => Math.max(m, r.peakDeg), 0);
  const spun = rows.some((r) => r.spun);
  const maxDeg = Math.max(30, Math.ceil((Math.max(peak * 1.08, spun ? 95 : 0)) / 15) * 15);

  return (
    <View style={styles.list} testID={testID}>
      <View style={styles.legend}>
        <AppText variant="micro" color="muted">
          |β| per slide · axis 0–{maxDeg}°
        </AppText>
        <AppText variant="micro" color="muted">
          peak · time · points
        </AppText>
      </View>
      {rows.map((row, i) => (
        <Row key={row.id} row={row} index={i} maxDeg={maxDeg} sparkWidth={sparkWidth} run={run} reduceMotion={reduceMotion} onSeek={onSeek} />
      ))}
    </View>
  );
}

function Row({
  row,
  index,
  maxDeg,
  sparkWidth,
  run,
  reduceMotion,
  onSeek,
}: {
  row: DriftRow;
  index: number;
  maxDeg: number;
  sparkWidth: number;
  run: boolean;
  reduceMotion: boolean;
  onSeek(row: DriftRow): void;
}) {
  const enter = useEnter(60 + Math.min(index, 8) * 50, run, reduceMotion);
  const accent = row.spun ? colors.red : row.lost ? colors.muted : colors.ember;

  return (
    <Animated.View style={enter}>
      <Pressable
        onPress={() => onSeek(row)}
        accessibilityRole="button"
        accessibilityLabel={`Drift ${row.index}, peak ${Math.round(row.peakDeg)} degrees, ${row.points} points. Open in the replay.`}
        testID={`drift-row-${row.index}`}
        style={({ pressed }) => [styles.row, { borderLeftColor: alpha(accent, row.lost ? 0.4 : 0.9) }, pressed && styles.pressed]}>
        <View style={styles.idCol}>
          <AppText variant="subheading" color={row.lost ? 'muted' : 'text'} numeric style={styles.id}>
            {row.index}
          </AppText>
          <AppText variant="micro" color="muted">
            {row.direction === 1 ? 'R' : 'L'}
          </AppText>
        </View>

        <View style={styles.sparkCol}>
          <Sparkline trace={row.trace} width={sparkWidth} height={34} maxDeg={maxDeg} color={row.lost ? colors.muted : colors.ember} spun={row.spun} showGuides={false} />
          <View style={styles.tags}>
            {row.spun ? <Tag label="SPIN" color={colors.red} filled /> : null}
            {row.lost ? <Tag label="CHAIN LOST" color={colors.muted} /> : null}
            {row.transitions > 0 ? <Tag label={`TRANSITION ×${row.transitions}`} color={colors.magenta} /> : null}
            {!row.cleanExit && !row.spun ? <Tag label="SCRAPPY EXIT" color={colors.gold} /> : null}
          </View>
        </View>

        <View style={styles.numbers}>
          <AppText variant="telemetry" color={row.spun ? colors.red : colors.text} numeric style={styles.peak}>
            {Math.round(row.peakDeg)}°
          </AppText>
          <AppText variant="micro" color="muted" numeric>
            {row.durationS.toFixed(1)} s · {Math.round(row.entryKmh)} km/h
          </AppText>
          <AppText variant="bodyStrong" color={row.lost ? colors.muted : colors.ember} numeric style={row.lost ? styles.struck : undefined}>
            {formatScore(row.points)}
          </AppText>
        </View>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  list: { gap: space[2] },
  legend: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: space[1] },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[3],
    backgroundColor: colors.bg1,
    borderWidth: 1,
    borderColor: colors.line,
    borderLeftWidth: 3,
    borderRadius: radii.md,
    paddingVertical: space[3],
    paddingRight: space[3],
    paddingLeft: space[3],
  },
  pressed: { opacity: 0.7 },
  idCol: { width: 22, alignItems: 'center' },
  id: { fontSize: 22, lineHeight: 24 },
  sparkCol: { flex: 1, gap: space[1] },
  tags: { flexDirection: 'row', gap: space[1], flexWrap: 'wrap' },
  numbers: { alignItems: 'flex-end', minWidth: 96, gap: 1 },
  peak: { fontSize: 26, lineHeight: 26 },
  struck: { textDecorationLine: 'line-through' },
});
