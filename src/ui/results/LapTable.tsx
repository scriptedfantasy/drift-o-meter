/**
 * Lap consistency, corner by corner: where the driver repeats and where they don't.
 *
 * Each row is a dot plot of the peak |β| the driver reached at that corner on each lap, on a
 * scale shared by every corner. Dots stacked on top of each other = repeatable. Dots strung
 * out = a corner that came out differently every time. Worst corner first, because that is
 * the one worth practising.
 */
import { StyleSheet, View } from 'react-native';
import Animated from 'react-native-reanimated';
import Svg, { Circle, Line, Rect } from 'react-native-svg';

import type { LapConsistency } from '../../engine/track';
import type { TrackCorner } from '../../engine/types';
import { AppText } from '../Text';
import { alpha, colors, radii, space } from '../theme';
import { cornerShape } from './corners';
import { useEnter } from './entrance';
import { Tag } from './parts';

export interface LapTableProps {
  laps: LapConsistency;
  corners: TrackCorner[];
  /** Width available for the whole table. */
  width: number;
  run: boolean;
  reduceMotion?: boolean;
  testID?: string;
}

// lap 1 ember, lap 2 white: two laps have to be told apart, but not with two new accents
const LAP_COLORS = [colors.ember, colors.text, colors.cyan, colors.magenta, colors.gold];

function verdict(score: number): { label: string; color: string } {
  if (score >= 0.75) return { label: 'LOCKED IN', color: colors.green };
  if (score >= 0.5) return { label: 'CLOSE', color: colors.cyan };
  if (score >= 0.25) return { label: 'WANDERING', color: colors.gold };
  return { label: 'ALL OVER', color: colors.red };
}

export function LapTable({ laps, corners, width, run, reduceMotion = false, testID }: LapTableProps) {
  const enter = useEnter(120, run, reduceMotion);
  const rows = laps.perCorner
    .map((c) => ({ c, corner: corners.find((k) => k.id === c.cornerId) }))
    .filter((r): r is { c: (typeof laps.perCorner)[number]; corner: TrackCorner } => !!r.corner && r.c.laps.some((l) => l !== null))
    .sort((a, b) => a.c.score - b.c.score);

  const peak = rows.reduce((m, r) => Math.max(m, ...r.c.laps.map((l) => (l ? l.peakAngleDeg : 0))), 0);
  const maxDeg = Math.max(30, Math.ceil((peak * 1.08) / 15) * 15);
  const plotW = Math.max(90, Math.round(width * 0.36));

  return (
    <Animated.View style={[styles.wrap, enter]} testID={testID}>
      <View style={styles.legend}>
        <AppText variant="micro" color="muted">
          Peak |β| per lap · 0–{maxDeg}° · worst corner first
        </AppText>
        <View style={styles.legendKeys}>
          {laps.perCorner[0]?.laps.map((_, i) => (
            <View key={i} style={styles.legendKey}>
              <View style={[styles.dot, { backgroundColor: LAP_COLORS[i % LAP_COLORS.length] }]} />
              <AppText variant="micro" color="muted">
                L{i + 1}
              </AppText>
            </View>
          ))}
        </View>
      </View>

      {rows.map(({ c, corner }, i) => {
        const v = verdict(c.score);
        const vals = c.laps.map((l) => (l ? l.peakAngleDeg : NaN));
        const seen = vals.filter((x) => Number.isFinite(x));
        const spread = seen.length >= 2 ? Math.max(...seen) - Math.min(...seen) : 0;
        return (
          <View key={c.cornerId} style={[styles.row, i === 0 && rows.length > 1 && c.score < 0.6 ? styles.worst : null]}>
            <View style={styles.cornerCol}>
              <AppText variant="subheading" numberOfLines={1} style={styles.cornerName}>
                Turn {corner.id + 1}
              </AppText>
              <AppText variant="micro" color="muted" numberOfLines={1}>
                {cornerShape(corner)}
              </AppText>
              <AppText variant="micro" color="muted" numeric numberOfLines={1}>
                {seen.length < vals.length ? `skipped ${vals.length - seen.length}× · ` : ''}entry ±{c.entrySpreadM.toFixed(1)} m
              </AppText>
            </View>

            <View style={styles.plotCol}>
              <Svg width={plotW} height={26}>
                <Line x1={0} y1={13} x2={plotW} y2={13} stroke={colors.line} strokeWidth={1} />
                {seen.length >= 2 ? (
                  <Rect
                    x={(Math.min(...seen) / maxDeg) * plotW}
                    y={11}
                    width={Math.max(1, ((Math.max(...seen) - Math.min(...seen)) / maxDeg) * plotW)}
                    height={4}
                    fill={alpha(v.color, 0.45)}
                  />
                ) : null}
                {vals.map((val, li) =>
                  Number.isFinite(val) ? (
                    <Circle key={li} cx={(val / maxDeg) * plotW} cy={13} r={5} fill={LAP_COLORS[li % LAP_COLORS.length]} />
                  ) : (
                    <Circle key={li} cx={3} cy={13} r={4.5} stroke={colors.red} strokeWidth={1.5} fill="none" />
                  ),
                )}
              </Svg>
              <View style={styles.plotVals}>
                {vals.map((val, li) => (
                  <AppText key={li} variant="micro" color={Number.isFinite(val) ? LAP_COLORS[li % LAP_COLORS.length] : colors.red} numeric>
                    {Number.isFinite(val) ? `${Math.round(val)}°` : '--'}
                  </AppText>
                ))}
              </View>
            </View>

            <View style={styles.verdictCol}>
              <Tag label={v.label} color={v.color} filled={c.score < 0.5} />
              <AppText variant="micro" color="muted" numeric>
                Δ {Math.round(spread)}°
              </AppText>
            </View>
          </View>
        );
      })}

      <AppText variant="small" color="muted" style={styles.footer}>
        Overall repeatability {Math.round(laps.overall * 100)} / 100 across {laps.lapsCompared} laps. Half of your consistency score is this table; the other half is how steadily you held each
        angle.
      </AppText>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: space[2] },
  legend: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  legendKeys: { flexDirection: 'row', gap: space[3] },
  legendKey: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[3],
    paddingVertical: space[2],
    paddingHorizontal: space[3],
    backgroundColor: colors.bg1,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radii.md,
  },
  worst: { borderColor: alpha(colors.red, 0.5) },
  cornerCol: { flex: 1, gap: 0, minWidth: 0 },
  cornerName: { fontSize: 18, lineHeight: 20 },
  plotCol: { gap: 2 },
  plotVals: { flexDirection: 'row', justifyContent: 'space-between' },
  verdictCol: { alignItems: 'flex-end', gap: 3, minWidth: 74 },
  footer: { marginTop: space[1] },
});
