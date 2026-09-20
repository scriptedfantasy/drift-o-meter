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
  /** The run was not trusted: show what was recorded, never the points it would have paid. */
  unscored?: boolean;
  onSeek(row: DriftRow): void;
  testID?: string;
}

export function DriftList({ rows, sparkWidth, run, reduceMotion = false, unscored = false, onSeek, testID }: DriftListProps) {
  // One y-scale for every row so they compare. It follows the 90th-percentile peak, not the
  // maximum: one 118° spin would otherwise flatten every honest 40° slide into a hairline. A row
  // above the scale clips, and its number column still prints the true peak.
  const sorted = rows.map((r) => r.peakDeg).sort((a, b) => a - b);
  const p90 = sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))] : 0;
  const maxDeg = Math.max(45, Math.min(75, Math.ceil((p90 * 1.06) / 15) * 15));

  return (
    <View style={styles.list} testID={testID}>
      <View style={styles.legend}>
        <AppText variant="micro" color="muted" style={styles.noCaps}>
          |β| per slide · axis 0–{maxDeg}°{rows.some((r) => r.peakDeg > maxDeg) ? ' (clipped)' : ''}
        </AppText>
        <AppText variant="micro" color="muted">
          peak · time{unscored ? '' : ' · points'}
        </AppText>
      </View>
      {rows.map((row, i) => (
        <Row key={row.id} row={row} index={i} maxDeg={maxDeg} sparkWidth={sparkWidth} run={run} reduceMotion={reduceMotion} unscored={unscored} onSeek={onSeek} />
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
  unscored,
  onSeek,
}: {
  row: DriftRow;
  index: number;
  maxDeg: number;
  sparkWidth: number;
  run: boolean;
  reduceMotion: boolean;
  unscored: boolean;
  onSeek(row: DriftRow): void;
}) {
  const enter = useEnter(60 + Math.min(index, 8) * 50, run, reduceMotion);
  const accent = row.spun ? colors.red : row.lost ? colors.muted : colors.ember;

  return (
    <Animated.View style={enter}>
      <Pressable
        onPress={() => onSeek(row)}
        accessibilityRole="button"
        accessibilityLabel={`Drift ${row.index}, peak ${Math.round(row.peakDeg)} degrees${unscored ? '' : `, ${row.points} points`}. Open in the replay.`}
        testID={`drift-row-${row.index}`}
        style={({ pressed }) => [styles.row, { borderLeftColor: alpha(unscored ? colors.muted : accent, row.lost && !unscored ? 0.4 : 0.9) }, pressed && styles.pressed]}>
        <View style={styles.idCol}>
          <AppText variant="subheading" color={row.lost ? 'muted' : 'text'} numeric style={styles.id}>
            {row.index}
          </AppText>
          <AppText variant="micro" color="muted">
            {row.direction === 1 ? 'R' : 'L'}
          </AppText>
        </View>

        <View style={styles.sparkCol}>
          <Sparkline
            trace={row.trace}
            width={sparkWidth}
            height={42}
            maxDeg={row.spun ? Math.max(maxDeg, row.peakDeg * 1.06) : maxDeg}
            color={row.lost && !unscored ? colors.muted : colors.ember}
            spun={row.spun && !unscored}
            showGuides={false}
          />
          {/* On an unpublished run a spin is a judgement drawn from angles the monitor refused to
              believe, so only the shape of the recording is shown. */}
          <View style={styles.tags}>
            {unscored ? null : row.spun ? <Tag label="SPIN" color={colors.red} filled /> : null}
            {unscored ? null : row.lost ? <Tag label="CHAIN LOST" color={colors.muted} /> : null}
            {row.transitions > 0 && !unscored ? <Tag label={`TRANSITION ×${row.transitions}`} color={colors.magenta} /> : null}
            {!row.cleanExit && !row.spun && !unscored ? <Tag label="SCRAPPY EXIT" color={colors.ember} /> : null}
          </View>
        </View>

        <View style={styles.numbers}>
          <AppText variant="telemetry" color={row.spun && !unscored ? colors.red : colors.text} numeric style={styles.peak}>
            {Math.round(row.peakDeg)}°
          </AppText>
          <AppText variant="micro" color="muted" numeric>
            {row.durationS.toFixed(1)} s · {Math.round(row.entryKmh)} km/h
          </AppText>
          {unscored ? null : (
            <AppText variant="bodyStrong" color={row.lost ? colors.muted : colors.ember} numeric style={row.lost ? styles.struck : undefined}>
              {formatScore(row.points)}
            </AppText>
          )}
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
    paddingVertical: space[2],
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
  // uppercase β is Β, which reads as a Latin B: this label must not be transformed
  noCaps: { textTransform: 'none' },
});
