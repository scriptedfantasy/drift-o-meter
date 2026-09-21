/**
 * Where this run landed on the grade scale, with the thresholds visible — a review score, not
 * a mystery letter. The bands are the scorer's own: D below 45, C 45, B 60, A 75, S 90.
 */
import { StyleSheet, View } from 'react-native';
import Animated from 'react-native-reanimated';

import type { Grade } from '../../engine/types';
import { AppText } from '../Text';
import { alpha, colors, gradeColors, space } from '../theme';
import { useFill } from './entrance';
import { GRADE_SCALE } from './palette';

export function GradeScale({
  rating,
  grade,
  color,
  run,
  reduceMotion = false,
  testID,
}: {
  rating: number;
  grade: Grade;
  color: string;
  run: boolean;
  reduceMotion?: boolean;
  testID?: string;
}) {
  const shown = Number.isFinite(rating) ? Math.max(0, Math.min(100, rating)) : 0;
  const fill = useFill(shown / 100, 260, run, reduceMotion);
  return (
    <View style={styles.wrap} testID={testID}>
      <View style={styles.track}>
        <Animated.View style={[styles.fill, { backgroundColor: alpha(color, 0.85) }, fill]} />
        {GRADE_SCALE.slice(1).map((b) => (
          <View key={b.grade} style={[styles.divider, { left: `${b.min}%` }]} />
        ))}
        <View style={[styles.marker, { left: `${shown}%`, backgroundColor: colors.text }]} />
      </View>
      {/* Each band carries its own letter on the left and the NEXT band's threshold on the
          right, which is the number printed where that next grade begins — so the pair a driver
          reads ("75+ A") is the one that is true. It also leaves the 10 %-wide S band nothing but
          its letter, which is the only way the row fits the landscape rail. */}
      <View style={styles.labels}>
        {GRADE_SCALE.map((b, i) => {
          const next = GRADE_SCALE[i + 1];
          const width = (next ? next.min : 100) - b.min;
          const active = b.grade === grade;
          return (
            <View key={b.grade} style={[styles.band, { width: `${width}%` }]}>
              <AppText variant="micro" color={active ? gradeColors[b.grade] : colors.muted} style={active ? styles.active : undefined}>
                {b.grade}
              </AppText>
              <AppText variant="micro" color="muted" numeric>
                {next ? `${next.min}+` : ''}
              </AppText>
            </View>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 4 },
  track: { height: 8, backgroundColor: colors.bg2, borderWidth: 1, borderColor: colors.line, overflow: 'visible' },
  fill: { position: 'absolute', left: 0, top: 0, bottom: 0 },
  divider: { position: 'absolute', top: -2, bottom: -2, width: 1, backgroundColor: colors.bg0 },
  marker: { position: 'absolute', top: -5, bottom: -5, width: 2, marginLeft: -1 },
  labels: { flexDirection: 'row' },
  band: { paddingLeft: 3, flexDirection: 'row', justifyContent: 'space-between', paddingRight: 2 },
  active: { fontSize: 13 },
});
