import { Pressable, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';

import { AppText } from './Text';
import { alpha, colors, glow, radii, type TypeVariant } from './theme';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'lg' | 'md' | 'sm';

export interface ButtonProps {
  label: string;
  onPress?: () => void;
  variant?: ButtonVariant;
  size?: ButtonSize;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  accessibilityLabel?: string;
}

/**
 * The app's button. Primary is a hot ember slab with a glow, slanted like a speed decal;
 * the label is counter-skewed so the type itself stays upright-italic.
 */
export function Button({ label, onPress, variant = 'primary', size = 'md', disabled = false, style, testID, accessibilityLabel }: ButtonProps) {
  const v = VARIANTS[variant];
  const s = SIZES[size];
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled }}
      hitSlop={6}
      style={({ pressed }) => [styles.base, s.container, v.container, pressed && styles.pressed, disabled && styles.disabled, style]}>
      <AppText variant={s.text} color={v.text} uppercase style={[styles.label, s.label]} numberOfLines={1}>
        {label}
      </AppText>
    </Pressable>
  );
}

const SKEW = '-8deg';
const UNSKEW = '8deg';

const VARIANTS: Record<ButtonVariant, { container: ViewStyle; text: string }> = {
  primary: { container: { backgroundColor: colors.ember, ...glow(colors.ember, 1) }, text: colors.bg0 },
  secondary: { container: { backgroundColor: colors.bg2, borderWidth: 1, borderColor: colors.line }, text: colors.text },
  ghost: { container: { backgroundColor: 'transparent', borderWidth: 1, borderColor: alpha(colors.muted, 0.35) }, text: colors.muted },
  danger: { container: { backgroundColor: alpha(colors.red, 0.14), borderWidth: 1, borderColor: alpha(colors.red, 0.7) }, text: colors.red },
};

const SIZES: Record<ButtonSize, { container: ViewStyle; label: object; text: TypeVariant }> = {
  lg: { container: { minHeight: 68, paddingHorizontal: 36, borderRadius: radii.md }, label: { fontSize: 30, lineHeight: 34, letterSpacing: 1 }, text: 'subheading' },
  md: { container: { minHeight: 52, paddingHorizontal: 24, borderRadius: radii.md }, label: { fontSize: 20, lineHeight: 24 }, text: 'subheading' },
  sm: { container: { minHeight: 38, paddingHorizontal: 16, borderRadius: radii.sm }, label: { fontSize: 15, lineHeight: 18, letterSpacing: 1 }, text: 'subheading' },
};

const styles = StyleSheet.create({
  base: {
    alignItems: 'center',
    justifyContent: 'center',
    transform: [{ skewX: SKEW }],
  },
  label: {
    transform: [{ skewX: UNSKEW }],
  },
  pressed: { opacity: 0.82, transform: [{ skewX: SKEW }, { scale: 0.985 }] },
  disabled: { opacity: 0.4 },
});
