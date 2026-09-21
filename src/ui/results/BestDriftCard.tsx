/**
 * BEST DRIFT: the one slide the review leads with, and the three figures that describe it.
 *
 * "Best" is the biggest peak angle, with the longest held breaking a tie (`bestByAngle` in
 * `model.ts`). It is NOT the scorer's old pick, which ranked by points and so could name a
 * smaller slide taken faster inside a longer chain — a driver who asks which their best drift
 * was is asking about the angle, and the answer used to have a multiplier in it.
 *
 * The three figures are peak, held and entry speed, in that order, because that is the order a
 * driver retells a slide in: how far it went, how long they kept it there, how fast they went in.
 */
import { StyleSheet, View } from 'react-native';
import Animated from 'react-native-reanimated';

import { AppText } from '../Text';
import { formatSpeed, speedUnitLabel, type SpeedUnits } from '../format';
import { angleColor, colors, radii, space } from '../theme';
import { useEnter } from './entrance';
import type { DriftRow } from './model';

export interface BestDriftCardProps {
  drift: DriftRow;
  /** `AppSettings.units`. The model carries km/h; the conversion happens here. */
  units: SpeedUnits;
  run: boolean;
  reduceMotion?: boolean;
  /**
   * The integrity monitor refused this run. The figures are still the recording's, so they are
   * still shown — in grey, under a caption that says so, because a run the engine will not
   * vouch for must not be presented as an achievement.
   */
  unscored?: boolean;
  testID?: string;
}

/** `2:07` — where in the run the slide started. */
function atTime(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function BestDriftCard({ drift, units, run, reduceMotion = false, unscored = false, testID }: BestDriftCardProps) {
  const enter = useEnter(140, run, reduceMotion);
  // The angle takes the dial's own ramp, so a 56° here is the colour a 56° was on the gauge
  // while it was happening. The other two are achievement figures and take the mark's green.
  const peakColor = unscored ? colors.muted : angleColor(drift.peakDeg);
  const figureColor = unscored ? colors.muted : colors.green;

  return (
    <Animated.View style={enter} testID={testID}>
      <View style={styles.card}>
        <View style={styles.head}>
          <AppText variant="subheading" color="text" style={styles.title}>
            Best drift
          </AppText>
          <AppText variant="micro" color="muted" numeric>
            {unscored ? 'AS RECORDED · ' : ''}SLIDE {drift.index} · {atTime(drift.startT)}
          </AppText>
        </View>

        <View style={styles.figures}>
          <View>
            <AppText variant="display" color={peakColor} numeric style={styles.peak}>
              {Math.round(drift.peakDeg)}°
            </AppText>
            <AppText variant="micro" color="muted">
              Peak
            </AppText>
          </View>
          <View>
            <AppText variant="telemetry" color={figureColor} numeric style={styles.figure}>
              {drift.heldS.toFixed(1)}s
            </AppText>
            <AppText variant="micro" color="muted">
              Held
            </AppText>
          </View>
          <View>
            <AppText variant="telemetry" color={figureColor} numeric style={styles.figure}>
              {formatSpeed(drift.entryKmh / 3.6, units)}
            </AppText>
            <AppText variant="micro" color="muted">
              Entry {speedUnitLabel(units)}
            </AppText>
          </View>
        </View>

        {/* The biggest angle of a run is very often the one that got away, and the selection rule
            does not pretend otherwise: it says so instead of quietly promoting the runner-up and
            calling that the biggest. Severity is the word's colour, never a stripe down the card. */}
        {drift.spun && !unscored ? (
          <AppText variant="micro" color={colors.red}>
            This one ended in a spin
          </AppText>
        ) : null}
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: colors.bg1, borderWidth: 1, borderColor: colors.line, borderRadius: radii.sm, padding: space[4], gap: space[3] },
  head: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: space[2] },
  title: { fontSize: 20, lineHeight: 22 },
  figures: { flexDirection: 'row', alignItems: 'flex-end', gap: space[5], flexWrap: 'wrap' },
  peak: { fontSize: 40, lineHeight: 40 },
  figure: { fontSize: 30, lineHeight: 40 },
});
