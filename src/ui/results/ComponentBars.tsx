/**
 * The five scored components, as bars that fill on entry with the scorer's own number beside
 * them and one specific line of explanation underneath — the review-score breakdown.
 */
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Animated from 'react-native-reanimated';

import { AppText } from '../Text';
import { alpha, colors, glow, space } from '../theme';
import { useEnter, useFill } from './entrance';
import type { ComponentRow } from './model';

export interface ComponentBarsProps {
  rows: ComponentRow[];
  /** Start the fill. */
  run: boolean;
  reduceMotion?: boolean;
  /**
   * The engine refused to publish this run's score: the bars stay empty and the numbers read
   * "--". The descriptions stay, because they describe the recording, not the judgement.
   */
  unmeasured?: boolean;
  testID?: string;
}

export function ComponentBars({ rows, run, reduceMotion = false, unmeasured = false, testID }: ComponentBarsProps) {
  return (
    <View style={styles.list} testID={testID}>
      {unmeasured ? (
        <AppText variant="small" color="red">
          Not published. The engine could not believe enough of this run to score it, so these five components have no number — only what the recording contains. Spins are not counted here either:
          they are read from the same angles the monitor would not believe.
        </AppText>
      ) : null}
      {rows.map((row, i) => (
        <Bar key={row.key} row={row} index={i} run={run} reduceMotion={reduceMotion} unmeasured={unmeasured} />
      ))}
    </View>
  );
}

function Bar({ row, index, run, reduceMotion, unmeasured }: { row: ComponentRow; index: number; run: boolean; reduceMotion: boolean; unmeasured: boolean }) {
  const enter = useEnter(120 + index * 70, run, reduceMotion);
  const fill = useFill(unmeasured ? 0 : row.score / 100, 220 + index * 90, run, reduceMotion);
  const known = Number.isFinite(row.score) && !unmeasured;
  const score = known ? Math.round(row.score) : null;
  const [open, setOpen] = useState(false);

  return (
    <Animated.View style={[styles.row, enter]} testID={`component-${row.key}`}>
      <View style={styles.headRow}>
        <AppText variant="subheading" color={unmeasured ? 'muted' : 'text'} style={styles.label} numberOfLines={1}>
          {row.label}
        </AppText>
        <AppText variant="micro" color="muted" numeric style={styles.weight}>
          ×{row.weight.toFixed(2)}
        </AppText>
        <View style={styles.spacer} />
        <AppText variant="telemetry" color={score === 0 || score === null ? colors.muted : row.color} numeric style={styles.score}>
          {score ?? '--'}
        </AppText>
        <AppText variant="micro" color="muted" style={styles.outOf}>
          /100
        </AppText>
      </View>

      <View style={styles.track}>
        {[0.25, 0.5, 0.75].map((t) => (
          <View key={t} style={[styles.tick, { left: `${t * 100}%` }]} />
        ))}
        <Animated.View style={[styles.fill, { backgroundColor: row.color, ...glow(row.color, 0.45) }, fill]}>
          <View style={[styles.cap, { backgroundColor: colors.text }]} />
        </Animated.View>
      </View>

      <AppText variant="small" color="muted" style={styles.explain}>
        {row.explain}
      </AppText>
      {row.scale ? (
        <Pressable onPress={() => setOpen((v) => !v)} hitSlop={8} accessibilityRole="button" accessibilityLabel={`How ${row.label} is scored`} testID={`scale-${row.key}`}>
          <AppText variant="micro" color="muted">
            {open ? '− How it is scored' : '+ How it is scored'}
          </AppText>
        </Pressable>
      ) : null}
      {row.scale && open ? (
        <AppText variant="small" color="muted" style={styles.scale}>
          {row.scale}
        </AppText>
      ) : null}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  list: { gap: space[5] },
  row: { gap: space[2] },
  headRow: { flexDirection: 'row', alignItems: 'baseline', gap: space[2] },
  label: { fontSize: 22, lineHeight: 24, letterSpacing: 1.4 },
  weight: { marginBottom: 1 },
  spacer: { flex: 1 },
  score: { fontSize: 32, lineHeight: 32 },
  outOf: { marginBottom: 2 },
  track: {
    height: 12,
    backgroundColor: colors.bg2,
    borderWidth: 1,
    borderColor: colors.line,
    overflow: 'hidden',
    justifyContent: 'center',
  },
  tick: { position: 'absolute', top: 0, bottom: 0, width: 1, backgroundColor: alpha(colors.bg0, 0.85) },
  fill: { height: '100%', flexDirection: 'row', justifyContent: 'flex-end' },
  cap: { width: 2, height: '100%', opacity: 0.85 },
  explain: { marginTop: 2 },
  scale: { fontStyle: 'italic' },
});
