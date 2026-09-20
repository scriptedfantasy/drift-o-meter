/** The style callouts the run earned, with what each one paid. */
import { StyleSheet, View } from 'react-native';
import Animated from 'react-native-reanimated';

import { AppText } from '../Text';
import { formatScore } from '../format';
import { alpha, colors, radii, space } from '../theme';
import { useEnter } from './entrance';
import type { CalloutTally } from './model';

/** Callouts belong to magenta in the design language; initiation is bookkeeping, so it greys out. */
function calloutColor(kind: string): string {
  return kind === 'initiation' ? colors.muted : colors.magenta;
}

export function CalloutReel({
  callouts,
  points,
  lostPoints,
  run,
  reduceMotion = false,
  testID,
}: {
  callouts: CalloutTally[];
  points: number;
  lostPoints: number;
  run: boolean;
  reduceMotion?: boolean;
  testID?: string;
}) {
  const enter = useEnter(80, run, reduceMotion);
  if (callouts.length === 0) {
    return (
      <Animated.View style={enter} testID={testID}>
        <AppText variant="small" color="muted">
          No callouts fired. Nothing was held long enough, fast enough or far enough sideways to earn one.
        </AppText>
      </Animated.View>
    );
  }
  return (
    <Animated.View style={[styles.wrap, enter]} testID={testID}>
      <View style={styles.reel}>
        {callouts.map((c) => {
          const color = calloutColor(c.kind);
          return (
            <View key={c.kind} style={[styles.chip, { borderColor: alpha(color, 0.6), backgroundColor: alpha(color, 0.1) }]}>
              <AppText variant="subheading" color={color} style={styles.label} numberOfLines={1}>
                {c.label}
              </AppText>
              <View style={styles.chipFoot}>
                <AppText variant="micro" color="muted" numeric>
                  ×{c.count}
                </AppText>
                <AppText variant="micro" color={color} numeric>
                  +{formatScore(c.points)}
                </AppText>
              </View>
            </View>
          );
        })}
      </View>
      <AppText variant="small" color="muted">
        {formatScore(points)} of the total came from callouts
        {lostPoints > 0 ? `, and ${formatScore(lostPoints)} more went in the bin when the chain broke.` : '.'}
      </AppText>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: space[3] },
  reel: { flexDirection: 'row', flexWrap: 'wrap', gap: space[2] },
  chip: { borderWidth: 1, borderRadius: radii.sm, paddingHorizontal: space[3], paddingVertical: space[2], minWidth: 104, gap: 2 },
  label: { fontSize: 16, lineHeight: 18, letterSpacing: 0.8 },
  chipFoot: { flexDirection: 'row', justifyContent: 'space-between', gap: space[3] },
});
