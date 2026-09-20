/**
 * The garage before anything has been driven.
 *
 * Not an apology and not a shrug: the four records that do not exist yet are drawn as the empty
 * tiles they will become, so the first run has something to aim at. A driver should read this
 * and want to go outside.
 */
import { StyleSheet, View } from 'react-native';

import { AppText, Body, Micro } from '../Text';
import { alpha, colors, radii, space } from '../theme';

const SLOTS = [
  { label: 'Best grade', hint: 'S is the ceiling' },
  { label: 'Most points', hint: 'Angle × speed × chain' },
  { label: 'Biggest angle', hint: 'Held, not caught' },
  { label: 'Longest chain', hint: 'Bank it before you exit' },
];

export function EmptyGarage({ testID }: { testID?: string }) {
  return (
    <View style={styles.panel} testID={testID}>
      <Micro color="ember">First run</Micro>
      <AppText variant="display" style={styles.headline}>
        NOTHING{'\n'}TO BEAT{'\n'}YET
      </AppText>
      <Body color="muted" style={styles.body}>
        Clip the phone to something rigid, calibrate on the way to the first corner, and go. Whatever you manage tonight
        becomes the number to beat — and every run after it lands on this page with a grade and a replay.
      </Body>
      <View style={styles.grid}>
        {SLOTS.map((s) => (
          <View key={s.label} style={styles.slot}>
            <Micro numberOfLines={1}>{s.label}</Micro>
            <AppText variant="telemetry" color="muted" numeric style={styles.dash}>
              --
            </AppText>
            <Micro numberOfLines={1} style={styles.hint}>
              {s.hint}
            </Micro>
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    backgroundColor: colors.bg1,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.line,
    borderLeftWidth: 3,
    borderLeftColor: colors.ember,
    padding: space[5],
    gap: space[3],
  },
  headline: { fontSize: 46, lineHeight: 44, letterSpacing: -1.5 },
  body: { maxWidth: 420 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: space[2], marginTop: space[2] },
  slot: {
    flexGrow: 1,
    flexBasis: '46%',
    minWidth: 130,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radii.md,
    backgroundColor: alpha(colors.bg2, 0.6),
    paddingHorizontal: space[3],
    paddingVertical: space[2],
    gap: 1,
  },
  dash: { fontSize: 28, lineHeight: 30, opacity: 0.5 },
  hint: { textTransform: 'none', letterSpacing: 0.2, opacity: 0.8 },
});
