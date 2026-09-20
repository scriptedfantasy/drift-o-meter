import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { AppText } from './Text';
import { alpha, colors, radii, space } from './theme';

export interface SegmentOption<T extends string | number> {
  value: T;
  label: string;
  disabled?: boolean;
}

export interface SegmentedProps<T extends string | number> {
  options: readonly SegmentOption<T>[];
  value: T;
  onChange(value: T): void;
  color?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/** A row of exclusive choices. The active segment burns in the accent colour. */
export function Segmented<T extends string | number>({ options, value, onChange, color = colors.ember, style, testID }: SegmentedProps<T>) {
  return (
    <View style={[styles.row, style]} testID={testID} accessibilityRole="radiogroup">
      {options.map((o) => {
        const active = o.value === value;
        return (
          <Pressable
            key={String(o.value)}
            disabled={o.disabled}
            onPress={() => onChange(o.value)}
            accessibilityRole="radio"
            accessibilityState={{ selected: active, disabled: !!o.disabled }}
            style={({ pressed }) => [
              styles.segment,
              active && { backgroundColor: alpha(color, 0.18), borderColor: color },
              o.disabled && styles.disabled,
              pressed && styles.pressed,
            ]}>
            <AppText variant="subheading" color={active ? color : 'muted'} style={styles.label} numberOfLines={1}>
              {o.label}
            </AppText>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: space[2], flexWrap: 'wrap' },
  segment: {
    minHeight: 40,
    paddingHorizontal: space[4],
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.bg2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: { fontSize: 15, lineHeight: 18 },
  disabled: { opacity: 0.35 },
  pressed: { opacity: 0.7 },
});
