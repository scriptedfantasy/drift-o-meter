/**
 * The garage before anything has been driven.
 *
 * Not an apology and not a shrug. It used to draw four empty record tiles — best grade, most
 * points, biggest angle, longest chain — three of which no longer exist, and the one that
 * survived is the one worth aiming at. So there is one slot, the size of the number it is
 * waiting for, and a driver should read this and want to go outside.
 */
import { StyleSheet, View } from 'react-native';

import { AppText, Body, Micro } from '../Text';
import { alpha, colors, radii, space } from '../theme';

export function EmptyGarage({ testID }: { testID?: string }) {
  return (
    <View style={styles.panel} testID={testID}>
      <Micro color="green">First run</Micro>
      <AppText variant="display" style={styles.headline}>
        NOTHING{'\n'}TO BEAT{'\n'}YET
      </AppText>
      <Body color="muted" style={styles.body}>
        Clip the phone to something rigid and go. It works out which way the car points on the way to the first corner by
        itself, so there is nothing to set up. Whatever angle you hold tonight becomes the one to beat, and every run
        after it lands on this page with its own shape and a replay.
      </Body>
      <View style={styles.slot}>
        <Micro numberOfLines={1}>Biggest angle</Micro>
        <AppText variant="display" color="muted" numeric style={styles.dash}>
          --
        </AppText>
        <Micro numberOfLines={1} style={styles.hint}>
          Held and driven out of — a spin does not count
        </Micro>
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
    padding: space[5],
    gap: space[3],
  },
  headline: { fontSize: 46, lineHeight: 44, letterSpacing: -1.5 },
  body: { maxWidth: 420 },
  slot: {
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radii.md,
    backgroundColor: alpha(colors.bg2, 0.6),
    paddingHorizontal: space[3],
    paddingVertical: space[2],
    gap: 1,
    marginTop: space[1],
  },
  dash: { fontSize: 40, lineHeight: 42, opacity: 0.5 },
  hint: { textTransform: 'none', letterSpacing: 0.2, opacity: 0.8 },
});
