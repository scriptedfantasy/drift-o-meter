import { StyleSheet, Text, type TextProps, type TextStyle } from 'react-native';

import { colors, type ColorToken, typeScale, type TypeVariant } from './theme';

export interface AppTextProps extends TextProps {
  variant?: TypeVariant;
  /** A colour token (`ember`) or any colour string. */
  color?: ColorToken | (string & {});
  align?: TextStyle['textAlign'];
  /** Tabular figures for numbers that update live. */
  numeric?: boolean;
  uppercase?: boolean;
}

function resolveColor(c: string): string {
  return (colors as Record<string, string>)[c] ?? c;
}

export function AppText({ variant = 'body', color = 'text', align, numeric, uppercase, style, ...rest }: AppTextProps) {
  return (
    <Text
      {...rest}
      style={[
        typeScale[variant],
        { color: resolveColor(color) },
        align ? { textAlign: align } : null,
        numeric ? styles.numeric : null,
        uppercase ? styles.uppercase : null,
        style,
      ]}
    />
  );
}

export const Hero = (p: AppTextProps) => <AppText variant="hero" numeric {...p} />;
export const Display = (p: AppTextProps) => <AppText variant="display" {...p} />;
export const Title = (p: AppTextProps) => <AppText variant="title" uppercase {...p} />;
export const Heading = (p: AppTextProps) => <AppText variant="heading" uppercase {...p} />;
export const Subheading = (p: AppTextProps) => <AppText variant="subheading" {...p} />;
export const Telemetry = (p: AppTextProps) => <AppText variant="telemetry" numeric {...p} />;
export const Body = (p: AppTextProps) => <AppText variant="body" {...p} />;
export const Small = (p: AppTextProps) => <AppText variant="small" color="muted" {...p} />;
export const Label = (p: AppTextProps) => <AppText variant="label" color="muted" {...p} />;
export const Micro = (p: AppTextProps) => <AppText variant="micro" color="muted" {...p} />;

const styles = StyleSheet.create({
  numeric: { fontVariant: ['tabular-nums'] },
  uppercase: { textTransform: 'uppercase' },
});
