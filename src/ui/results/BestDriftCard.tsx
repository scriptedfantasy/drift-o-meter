/**
 * The hero stat: the single best slide of the session, with the |β| trace it was scored from
 * and a button that drops straight into the replay at that moment.
 */
import { StyleSheet, View } from 'react-native';
import Animated from 'react-native-reanimated';

import { AppText } from '../Text';
import { Button } from '../Button';
import { formatScore } from '../format';
import { alpha, colors, radii, space } from '../theme';
import { useEnter } from './entrance';
import type { DriftRow } from './model';
import { Sparkline } from './Sparkline';
import { Stat, Tag } from './parts';

export interface BestDriftCardProps {
  drift: DriftRow;
  width: number;
  run: boolean;
  reduceMotion?: boolean;
  onWatch(): void;
  testID?: string;
}

export function BestDriftCard({ drift, width, run, reduceMotion = false, onWatch, testID }: BestDriftCardProps) {
  const enter = useEnter(140, run, reduceMotion);
  const inner = width - space[4] * 2 - 2;
  const dir = drift.direction === 1 ? 'RIGHT-HAND' : 'LEFT-HAND';
  const accent = drift.spun ? colors.red : colors.ember;

  return (
    <Animated.View style={enter} testID={testID}>
      <View style={[styles.card, { borderColor: alpha(accent, 0.45) }]}>
        <View style={styles.top}>
          <View style={styles.topLeft}>
            <AppText variant="micro" color="muted">
              Peak angle · drift #{drift.index}
            </AppText>
            <View style={styles.peakRow}>
              <AppText variant="display" color={accent} numeric style={styles.peak}>
                {Math.round(drift.peakDeg)}°
              </AppText>
              <View style={styles.peakSide}>
                <Tag label={dir} color={accent} />
                <AppText variant="micro" color="muted">
                  held {Math.round(drift.heldPeakDeg)}° for 1.5 s
                </AppText>
              </View>
            </View>
          </View>
          <View style={styles.points}>
            <AppText variant="micro" color="muted">
              Points
            </AppText>
            <AppText variant="telemetry" color="ember" numeric style={styles.pointsValue}>
              {formatScore(drift.points)}
            </AppText>
            <AppText variant="micro" color="magenta" numeric>
              ×{drift.multiplier.toFixed(2)} multiplier
            </AppText>
          </View>
        </View>

        <Sparkline
          trace={drift.trace}
          width={inner}
          height={86}
          color={accent}
          spun={drift.spun}
          maxDeg={Math.max(45, Math.ceil((drift.peakDeg * 1.35) / 15) * 15)}
          style={styles.spark}
        />
        <View style={styles.sparkAxis}>
          <AppText variant="micro" color="muted">
            {drift.cornerLabel ? drift.cornerLabel.replace(/^the /, '').toUpperCase() : 'ENTRY'}
          </AppText>
          <AppText variant="micro" color="muted" numeric>
            |β| over {drift.durationS.toFixed(1)} s
          </AppText>
        </View>

        <View style={styles.grid}>
          <Stat label="Duration" value={drift.durationS.toFixed(1)} unit="s" size={26} />
          <Stat label="Entry speed" value={String(Math.round(drift.entryKmh))} unit="km/h" color={colors.cyan} size={26} />
          <Stat label="Transitions" value={String(drift.transitions)} color={drift.transitions > 0 ? colors.magenta : colors.muted} size={26} />
          <Stat label="Exit" value={drift.spun ? 'SPUN' : drift.cleanExit ? 'CLEAN' : 'SNATCHED'} color={drift.spun ? colors.red : drift.cleanExit ? colors.green : colors.gold} size={20} />
        </View>

        <Button label="Replay this drift" variant="secondary" size="md" onPress={onWatch} style={styles.cta} testID="cta-watch-best" />
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: colors.bg1, borderWidth: 1, borderRadius: radii.lg, padding: space[4], gap: space[3] },
  top: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: space[3] },
  topLeft: { gap: 2, flexShrink: 1 },
  peakRow: { flexDirection: 'row', alignItems: 'flex-end', gap: space[3] },
  peak: { fontSize: 76, lineHeight: 72 },
  peakSide: { gap: space[1], paddingBottom: space[2] },
  points: { alignItems: 'flex-end', gap: 2 },
  pointsValue: { fontSize: 30, lineHeight: 32 },
  spark: { marginTop: space[1] },
  sparkAxis: { flexDirection: 'row', justifyContent: 'space-between', marginTop: -space[2] },
  grid: { flexDirection: 'row', justifyContent: 'space-between', gap: space[3], flexWrap: 'wrap' },
  cta: { alignSelf: 'stretch', marginTop: space[1] },
});
