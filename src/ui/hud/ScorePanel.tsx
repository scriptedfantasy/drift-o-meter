/**
 * Score block: the odometer, the multiplier chip (which pops on every bump) and the chain bar —
 * the un-banked points, at risk until the drift exits cleanly.
 *
 * The odometer and the bar read shared values directly; only the multiplier's TEXT and the
 * at-risk figure come from the 10 Hz snapshot, because both change in steps, not continuously.
 */
import { memo } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { useAnimatedReaction, useAnimatedStyle, useSharedValue, withSequence, withTiming } from 'react-native-reanimated';

import { AppText, Micro } from '../Text';
import { easings } from '../motion';
import { alpha, colors, fontFamilies, radii, space } from '../theme';
import { readIntegrity } from './HudChrome';
import Odometer from './Odometer';
import type { HudSignals } from './signals';
import type { HudSnapshot } from './useDriveRun';

export interface ScorePanelProps {
  signals: HudSignals;
  snapshot: HudSnapshot;
  /** Odometer digit size. */
  size?: number;
  align?: 'left' | 'right';
  testID?: string;
}

function ScorePanelImpl({ signals, snapshot, size = 54, align = 'left', testID }: ScorePanelProps) {
  const right = align === 'right';
  // When the engine does not stand behind the reading, the digits lose their colour and the
  // line underneath says exactly what is wrong with them — rather than a confident ember number
  // the results screen may never agree with.
  const integrity = readIntegrity(snapshot);
  const note = integrity.scoreNote;
  // Red is for a fault that has stopped the scoring. A degraded-but-still-counting note (a
  // dead-reckoned dropout) is information, not an alarm.
  const noteTone = integrity.tier === 'severe' && !snapshot.counting ? colors.red : integrity.tier === 'severe' ? colors.gold : colors.muted;
  const trusted = snapshot.trust > 0;
  return (
    <View style={[styles.wrap, right && styles.wrapRight]} testID={testID}>
      <View style={[styles.head, right && styles.headRight]}>
        <Micro>Score</Micro>
        {trusted ? <MultiplierChip signals={signals} value={snapshot.multiplier} /> : null}
      </View>
      <Odometer value={signals.totalDisplay} size={size} columns={6} color={trusted ? colors.ember : colors.muted} testID="hud-odometer" />
      <ChainBar signals={signals} snapshot={snapshot} right={right} note={note} noteTone={noteTone} />
    </View>
  );
}

function MultiplierChip({ signals, value }: { signals: HudSignals; value: number }) {
  const pop = useSharedValue(0);
  useAnimatedReaction(
    () => signals.multiplier.value,
    (cur, prev) => {
      if (prev !== null && cur > prev + 1e-6) {
        pop.value = withSequence(withTiming(1, { duration: 90, easing: easings.out }), withTiming(0, { duration: 260, easing: easings.overshoot }));
      }
    },
    [],
  );
  const style = useAnimatedStyle(() => ({
    transform: [{ scale: 1 + 0.35 * pop.value }],
    borderColor: alpha(colors.ember, 0.4 + 0.6 * pop.value),
    backgroundColor: alpha(colors.ember, 0.1 + 0.35 * pop.value),
  }));
  const hot = value >= 2;
  return (
    <Animated.View style={[styles.chip, style]} testID="hud-multiplier">
      <AppText numeric style={[styles.chipText, { color: hot ? colors.gold : colors.ember }]}>
        ×{value.toFixed(2).replace(/0$/, '')}
      </AppText>
    </Animated.View>
  );
}

function ChainBar({ signals, snapshot, right, note, noteTone }: { signals: HudSignals; snapshot: HudSnapshot; right: boolean; note: string | null; noteTone: string }) {
  const fill = useAnimatedStyle(() => ({ width: `${Math.max(0, Math.min(1, signals.chainRatio.value)) * 100}%` }));
  const glow = useAnimatedStyle(() => ({ opacity: 0.25 + 0.75 * Math.min(1, signals.chainRatio.value) }));
  const atRisk = snapshot.chainPoints > 0;
  if (note) {
    return (
      <View style={[styles.chainWrap, right && styles.wrapRight]}>
        <View style={styles.chainTrack} />
        <View style={[styles.chainHead, right && styles.headRight]}>
          <Micro color={noteTone}>{note}</Micro>
        </View>
      </View>
    );
  }
  return (
    <View style={[styles.chainWrap, right && styles.wrapRight]}>
      <View style={styles.chainTrack}>
        <Animated.View style={[styles.chainFill, fill, glow]} />
      </View>
      <View style={[styles.chainHead, right && styles.headRight]}>
        <Micro color={atRisk ? colors.ember : colors.muted}>{atRisk ? 'At risk' : 'Banked'}</Micro>
        <AppText numeric style={styles.chainValue} color={atRisk ? colors.ember : colors.muted}>
          {atRisk ? Math.round(snapshot.chainPoints).toLocaleString('en-US') : Math.round(snapshot.totalPoints).toLocaleString('en-US')}
        </AppText>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: space[1], alignItems: 'flex-start' },
  wrapRight: { alignItems: 'flex-end' },
  head: { flexDirection: 'row', alignItems: 'center', gap: space[3] },
  headRight: { flexDirection: 'row-reverse' },
  chip: { borderWidth: 1, borderRadius: radii.sm, paddingHorizontal: space[2], paddingVertical: 1 },
  chipText: { fontFamily: fontFamilies.display.extraboldItalic, fontSize: 19, lineHeight: 22, letterSpacing: 0.2 },
  chainWrap: { alignSelf: 'stretch', gap: 3, marginTop: 2 },
  chainTrack: { height: 5, borderRadius: 3, backgroundColor: colors.bg2, overflow: 'hidden' },
  chainFill: { height: 5, borderRadius: 3, backgroundColor: colors.ember },
  chainHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space[2] },
  chainValue: { fontFamily: fontFamilies.display.boldItalic, fontSize: 15, lineHeight: 17 },
});

export const ScorePanel = memo(ScorePanelImpl);
export default ScorePanel;
