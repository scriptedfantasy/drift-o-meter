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

import { DEFAULT_SCORE_OPTIONS } from '../../engine/score';
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

/**
 * The verdict ramp is green → text → ember → red. Cyan belonged to telemetry and gold to the S
 * grade; spending them here left both meaning several things at once.
 *
 * `exact` is the tell-tale of a replayed trajectory rather than a repeatable driver: identical
 * peaks AND an entry spread of exactly zero. No human puts the car within 0.0 m of the same
 * point twice, so that is reported as unmeasured, never as perfection.
 */
/**
 * The chip carries the corner's OWN repeatability number, not a band: nine corners whose spread
 * varies 27-fold used to show nine identical "LOCKED IN" chips, which told the driver nothing on
 * the very run the table exists to explain. Words are kept only where a number would mislead —
 * a spin, a skipped lap, a single trajectory.
 */
function verdict(score: number, skipped: number, exact: boolean, spun: boolean): { label: string; color: string } {
  // A corner the car span at is not "locked in", however alike the two laps look: the cross-lap
  // score is a coefficient of variation, and two 118° spins have a very small one.
  if (spun) return { label: 'SPUN', color: colors.red };
  if (exact) return { label: 'UNMEASURED', color: colors.muted };
  // a corner the driver only drifted on some laps is not "close", it is missing
  if (skipped > 0) return { label: `SKIPPED · ${Math.round(score * 100)}`, color: colors.muted };
  const n = Math.round(score * 100);
  if (score >= 0.8) return { label: `${n} / 100`, color: colors.green };
  if (score >= 0.6) return { label: `${n} / 100`, color: colors.text };
  if (score >= 0.35) return { label: `${n} / 100`, color: colors.ember };
  return { label: `${n} / 100`, color: colors.red };
}

export function LapTable({ laps, corners, width, run, reduceMotion = false, testID }: LapTableProps) {
  const enter = useEnter(120, run, reduceMotion);
  const rows = laps.perCorner
    .map((c) => ({ c, corner: corners.find((k) => k.id === c.cornerId) }))
    .filter((r): r is { c: (typeof laps.perCorner)[number]; corner: TrackCorner } => !!r.corner && r.c.laps.some((l) => l !== null))
    .sort((a, b) => a.c.score - b.c.score);

  // The axis follows the 90th percentile, not the maximum: one 118° spin would otherwise push
  // every ordinary corner into the left third of the plot. Anything above it clips, and the
  // degrees are printed underneath either way.
  const peaks = rows
    .flatMap((r) => r.c.laps.map((l) => (l ? l.peakAngleDeg : NaN)))
    .filter((v) => Number.isFinite(v))
    .sort((a, b) => a - b);
  const p90 = peaks.length ? peaks[Math.min(peaks.length - 1, Math.floor(peaks.length * 0.9))] : 0;
  const maxDeg = Math.max(30, Math.min(90, Math.ceil((p90 * 1.08) / 15) * 15));
  const plotW = Math.max(90, Math.round(width * 0.36));

  return (
    <Animated.View style={[styles.wrap, enter]} testID={testID}>
      <View style={styles.legend}>
        <AppText variant="micro" color="muted" style={styles.noCaps}>
          Peak |β| per lap · 0–{maxDeg}° · worst corner first · repeatability out of 100
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
        const vals = c.laps.map((l) => (l ? l.peakAngleDeg : NaN));
        const seen = vals.filter((x) => Number.isFinite(x));
        const spreadDeg = seen.length >= 2 ? Math.max(...seen) - Math.min(...seen) : 0;
        const exact = seen.length >= 2 && spreadDeg < 0.05 && c.entrySpreadM < 0.05;
        const spun = seen.some((v) => v >= DEFAULT_SCORE_OPTIONS.spinAngleDeg);
        const v = verdict(c.score, vals.length - seen.length, exact, spun);
        return (
          <View key={c.cornerId} style={[styles.row, i === 0 && rows.length > 1 && c.score < 0.6 ? styles.worst : null]}>
            <View style={styles.cornerCol}>
              <AppText variant="subheading" numberOfLines={1} style={styles.cornerName}>
                Turn {corner.id + 1}
              </AppText>
              <AppText variant="micro" color="muted" numberOfLines={1}>
                {cornerShape(corner)}
              </AppText>
              <AppText variant="micro" color="muted" numeric numberOfLines={2}>
                {spun
                  ? 'spun here'
                  : exact
                    ? 'no spread'
                    : seen.length < vals.length
                      ? `skipped ${vals.length - seen.length} lap`
                      : c.entrySpreadM < 0.05
                        ? 'entry unknown'
                        : `entry ±${c.entrySpreadM.toFixed(1)} m`}
              </AppText>
            </View>

            <View style={styles.plotCol}>
              <Svg width={plotW} height={26}>
                <Line x1={0} y1={13} x2={plotW} y2={13} stroke={colors.line} strokeWidth={1} />
                {seen.length >= 2 ? (
                  <Rect
                    x={Math.min(plotW - 3, (Math.min(...seen) / maxDeg) * plotW)}
                    y={11}
                    width={Math.max(1, Math.min(plotW, ((Math.max(...seen) - Math.min(...seen)) / maxDeg) * plotW))}
                    height={4}
                    fill={alpha(v.color === colors.muted ? colors.line : v.color, 0.45)}
                  />
                ) : null}
                {vals.map((val, li) =>
                  Number.isFinite(val) ? (
                    <Circle key={li} cx={Math.min(plotW - 3, (val / maxDeg) * plotW)} cy={13} r={5} fill={LAP_COLORS[li % LAP_COLORS.length]} />
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
                Δ {Math.round(spreadDeg)}°
              </AppText>
            </View>
          </View>
        );
      })}

      <AppText variant="small" color="muted" style={styles.footer}>
        This table's own measure: {Math.round(laps.overall * 100)} / 100 across {laps.lapsCompared} laps, every drifted corner weighted equally and docked for the laps you skipped. The scorer's
        cross-lap term weights corners by angle instead, so it reads differently, and it is {Math.round(DEFAULT_SCORE_OPTIONS.crossLapWeight * 100)}% of your consistency score — the rest is how
        steadily you held each angle.
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
  verdictCol: { alignItems: 'flex-end', gap: 3, minWidth: 82 },
  footer: { marginTop: space[1] },
  // `micro` uppercases, and uppercase β is Β — a Latin-looking B. The app's own symbol must survive.
  noCaps: { textTransform: 'none' },
});
