/**
 * EVERY SLIDE: one row per slide, in the order they happened.
 *
 * Five columns, and the order is the order a driver reads them in — which slide, what it looked
 * like, how far it went, how long they held it, how fast they went in. Tapping a row seeks the
 * replay to that moment.
 *
 * The sparklines share ONE y axis so the rows compare honestly, and that axis is the dial's own
 * full scale (`MAX_ANGLE_DEG`). It used to follow the 90th-percentile peak of whatever was in
 * this particular run, which made every run's tallest slide look the same height: a night of 25°
 * slides drew exactly like a night of 55° ones. A fixed scale means a small run looks small,
 * which is the truth about it, and a slide past the top clips while its own number still prints
 * the real peak beside it.
 */
import { Pressable, StyleSheet, View } from 'react-native';
import Animated from 'react-native-reanimated';

import { AppText } from '../Text';
import { formatSpeed, type SpeedUnits } from '../format';
import { angleColor, colors, MAX_ANGLE_DEG, radii, space } from '../theme';
import { useEnter } from './entrance';
import type { DriftRow } from './model';
import { Sparkline } from './Sparkline';

export interface DriftListProps {
  rows: DriftRow[];
  /** Sparkline width in dp. */
  sparkWidth: number;
  /** `AppSettings.units`. The model carries km/h; the conversion happens here. */
  units: SpeedUnits;
  run: boolean;
  reduceMotion?: boolean;
  /** The integrity monitor refused the run: every figure is grey, and none of it is achievement. */
  unscored?: boolean;
  onSeek(row: DriftRow): void;
  testID?: string;
}

export function DriftList({ rows, sparkWidth, units, run, reduceMotion = false, unscored = false, onSeek, testID }: DriftListProps) {
  return (
    <View style={styles.list} testID={testID}>
      {rows.map((row, i) => (
        <Row key={row.id} row={row} index={i} sparkWidth={sparkWidth} units={units} run={run} reduceMotion={reduceMotion} unscored={unscored} onSeek={onSeek} />
      ))}
    </View>
  );
}

function Row({
  row,
  index,
  sparkWidth,
  units,
  run,
  reduceMotion,
  unscored,
  onSeek,
}: {
  row: DriftRow;
  index: number;
  sparkWidth: number;
  units: SpeedUnits;
  run: boolean;
  reduceMotion: boolean;
  unscored: boolean;
  onSeek(row: DriftRow): void;
}) {
  // The rows enter in a short stagger, and the stagger stops after the eighth: a list of twenty
  // would otherwise still be arriving a second after the page settled.
  const enter = useEnter(60 + Math.min(index, 8) * 50, run, reduceMotion);
  const peakColor = unscored ? colors.muted : row.spun ? colors.red : angleColor(row.peakDeg);

  return (
    <Animated.View style={enter}>
      <Pressable
        onPress={() => onSeek(row)}
        accessibilityRole="button"
        accessibilityLabel={`Slide ${row.index}, peak ${Math.round(row.peakDeg)} degrees, held ${row.heldS.toFixed(1)} seconds, entry ${formatSpeed(row.entryKmh / 3.6, units)}${
          row.spun && !unscored ? ', ended in a spin' : ''
        }. Open in the replay.`}
        testID={`drift-row-${row.index}`}
        style={({ pressed }) => [styles.row, pressed && styles.pressed]}>
        <AppText variant="micro" color="muted" numeric style={styles.idCol}>
          {row.index}
        </AppText>

        {/* No fill and no peak dot at 22 dp: five of these down a column read as solid blocks
            once they are filled, and the shapes stop being distinguishable from one another. */}
        <Sparkline
          trace={row.trace}
          width={sparkWidth}
          height={22}
          maxDeg={MAX_ANGLE_DEG}
          color={colors.muted}
          spun={row.spun && !unscored}
          showPeak={false}
          showGuides={false}
          showFill={false}
        />

        <AppText variant="telemetry" color={peakColor} numeric style={styles.peak}>
          {Math.round(row.peakDeg)}°
        </AppText>
        <AppText variant="small" color={unscored ? 'muted' : 'text'} numeric style={styles.held}>
          {row.heldS.toFixed(1)}s
        </AppText>
        <AppText variant="small" color={unscored ? colors.muted : colors.blue} numeric style={styles.entry}>
          {formatSpeed(row.entryKmh / 3.6, units)}
        </AppText>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  list: { gap: space[2] },
  // 44 dp of height, not the mockup's 40: a row is the only way into the replay at a moment, and
  // a target under 44 is one a thumb in a cold pit lane misses.
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[3],
    minHeight: 44,
    backgroundColor: colors.bg1,
    borderRadius: radii.md,
    paddingVertical: space[2],
    paddingHorizontal: space[3],
  },
  pressed: { opacity: 0.7 },
  idCol: { width: 20 },
  peak: { flex: 1, fontSize: 24, lineHeight: 26 },
  held: { width: 48, textAlign: 'right' },
  entry: { width: 54, textAlign: 'right' },
});
