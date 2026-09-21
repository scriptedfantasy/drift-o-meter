/**
 * Small pieces shared by every screen: section headers, stat cells, chips.
 *
 * These lived under `ui/results/` and the garage imported them across, which made one
 * screen's kit the other's dependency. They are nobody's kit now.
 */
import type { ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { AppText } from './Text';
import { alpha, colors, radii, space } from './theme';

/**
 * A section header: uppercase title, hairline to the edge, optional right-hand count.
 *
 * It used to open with a 5 px skewed slab in whatever colour the caller thought the
 * section meant — the same idea as Panel's accent stripe, and banned for the same reason.
 * `accent` survives as a prop only so the callers still passing one keep compiling.
 */
export function SectionHead({ title, right, style }: { title: string; right?: string | ReactNode; accent?: string; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[styles.head, style]}>
      <AppText variant="heading" uppercase style={styles.headTitle} numberOfLines={1}>
        {title}
      </AppText>
      <View style={styles.rule} />
      {typeof right === 'string' ? (
        <AppText variant="micro" color="muted" numeric>
          {right}
        </AppText>
      ) : (
        right
      )}
    </View>
  );
}

/** Label over a big number, the way the HUD does it. */
export function Stat({
  label,
  value,
  unit,
  color = colors.text,
  size = 30,
  style,
}: {
  label: string;
  value: string;
  unit?: string;
  color?: string;
  size?: number;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={[styles.stat, style]}>
      <AppText variant="micro" color="muted" numberOfLines={1}>
        {label}
      </AppText>
      <View style={styles.statValue}>
        <AppText variant="telemetry" color={color} numeric style={{ fontSize: size, lineHeight: size * 1.04 }}>
          {value}
        </AppText>
        {unit ? (
          <AppText variant="micro" color="muted" style={styles.unit}>
            {unit}
          </AppText>
        ) : null}
      </View>
    </View>
  );
}

/** A hard-edged tag: uppercase, hairline border, optional fill. */
export function Tag({ label, color = colors.muted, filled = false, style }: { label: string; color?: string; filled?: boolean; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[styles.tag, { borderColor: alpha(color, 0.65), backgroundColor: filled ? alpha(color, 0.16) : 'transparent' }, style]}>
      <AppText variant="micro" color={color} numberOfLines={1}>
        {label}
      </AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'baseline', gap: space[2], marginTop: space[6], marginBottom: space[3] },
  headTitle: { fontSize: 24, lineHeight: 26 },
  rule: { flex: 1, height: 1, backgroundColor: colors.line, marginHorizontal: space[2] },
  stat: { gap: 2, minWidth: 0 },
  statValue: { flexDirection: 'row', alignItems: 'baseline', gap: 4 },
  unit: { marginBottom: 2 },
  tag: { borderWidth: 1, borderRadius: radii.sm, paddingHorizontal: space[2], paddingVertical: 3, alignSelf: 'flex-start' },
});
