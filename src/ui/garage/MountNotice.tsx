/**
 * The only thing on the garage screen that is allowed to talk about calibration — and it only
 * appears when the last run left evidence that something was wrong.
 *
 * Calibration is not a step (docs/DESIGN.md, "the whole app is four steps"), so this is a
 * report on what happened, not an errand: it names the problem in the monitor's own words and
 * offers the one screen that can fix it.
 */
import { Pressable, StyleSheet, View } from 'react-native';

import { AppText, Micro, Small } from '../Text';
import { alpha, colors, radii, space } from '../theme';
import type { MountAdvice } from './advice';

export function MountNotice({ advice, onPress, testID }: { advice: MountAdvice; onPress(): void; testID?: string }) {
  const color = advice.level === 'bad' ? colors.red : colors.gold;
  return (
    <View style={[styles.notice, { borderColor: alpha(color, 0.75), backgroundColor: alpha(color, 0.12) }]} testID={testID}>
      <View style={[styles.bar, { backgroundColor: color }]} />
      <View style={styles.text}>
        <AppText variant="subheading" color={color} numberOfLines={2} style={styles.title}>
          {advice.title}
        </AppText>
        {advice.quote ? (
          <Small color={colors.text} numberOfLines={3} style={styles.quote}>
            {advice.quote}
          </Small>
        ) : null}
        <Small color={colors.text} numberOfLines={4}>
          {advice.body}
        </Small>
        <Pressable onPress={onPress} accessibilityRole="button" testID="cta-calibrate" style={({ pressed }) => [styles.action, { borderColor: color }, pressed && styles.pressed]}>
          <Micro color={color}>{advice.action} →</Micro>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  notice: { flexDirection: 'row', gap: space[3], borderWidth: 1, borderRadius: radii.md, padding: space[3] },
  bar: { width: 4, alignSelf: 'stretch', borderRadius: 2 },
  text: { flex: 1, gap: space[2] },
  title: { fontSize: 18, lineHeight: 21 },
  // The monitor's own sentence, set apart rather than glued into a template sentence.
  quote: { borderLeftWidth: 2, borderLeftColor: alpha(colors.text, 0.35), paddingLeft: space[3] },
  action: { alignSelf: 'flex-start', borderWidth: 1, borderRadius: radii.sm, paddingHorizontal: space[3], paddingVertical: 5, marginTop: space[1] },
  pressed: { opacity: 0.7 },
});
