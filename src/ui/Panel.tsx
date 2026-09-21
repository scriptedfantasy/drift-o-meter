import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { AppText, Label, Small } from './Text';
import { alpha, colors, radii, space } from './theme';

export interface PanelProps {
  children?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  /**
   * @deprecated Ignored, and being deleted.
   *
   * This used to paint a 3 px stripe down the left edge in whatever colour the caller
   * thought the card meant. There were 23 of them across the app and they are banned:
   * severity is the text colour, not a bar down the side. The prop still exists only so
   * that the callers still carrying one keep compiling; it draws nothing.
   */
  accent?: string;
  padded?: boolean;
  testID?: string;
}

/** A raised card on the asphalt. */
export function Panel({ children, style, padded = true, testID }: PanelProps) {
  return (
    <View testID={testID} style={[styles.panel, padded && styles.padded, style]}>
      {children}
    </View>
  );
}

export interface RowProps {
  label: string;
  value: string;
  valueColor?: string;
  hint?: string;
  last?: boolean;
}

/** Label on the left, value on the right. */
export function Row({ label, value, valueColor = colors.text, hint, last }: RowProps) {
  return (
    <View style={[styles.row, !last && styles.rowBorder]}>
      <View style={styles.rowText}>
        <Label>{label}</Label>
        {hint ? <Small>{hint}</Small> : null}
      </View>
      <AppText variant="telemetry" color={valueColor} numeric style={styles.rowValue}>
        {value}
      </AppText>
    </View>
  );
}

export interface MeterProps {
  label: string;
  /** 0..1 */
  value: number;
  display?: string;
  color?: string;
}

/** A labelled horizontal bar. */
export function Meter({ label, value, display, color = colors.blue }: MeterProps) {
  const pct = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
  return (
    <View style={styles.meter}>
      <View style={styles.meterHead}>
        <Label>{label}</Label>
        <AppText variant="bodyStrong" color={color} numeric>
          {display ?? `${Math.round(pct * 100)}%`}
        </AppText>
      </View>
      <View style={styles.meterTrack}>
        <View style={[styles.meterFill, { width: `${pct * 100}%`, backgroundColor: color }]} />
      </View>
    </View>
  );
}

export interface ChipProps {
  label: string;
  color?: string;
  filled?: boolean;
  style?: StyleProp<ViewStyle>;
}

/** Small uppercase pill. */
export function Chip({ label, color = colors.muted, filled = false, style }: ChipProps) {
  return (
    <View style={[styles.chip, { borderColor: alpha(color, 0.6), backgroundColor: filled ? alpha(color, 0.16) : 'transparent' }, style]}>
      <AppText variant="micro" color={color}>
        {label}
      </AppText>
    </View>
  );
}

export function Divider({ style }: { style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.divider, style]} />;
}

export interface EmptyStateProps {
  title: string;
  body?: string;
  children?: React.ReactNode;
}

export function EmptyState({ title, body, children }: EmptyStateProps) {
  return (
    <Panel style={styles.empty}>
      <AppText variant="heading" uppercase color="muted">
        {title}
      </AppText>
      {body ? <Small style={styles.emptyBody}>{body}</Small> : null}
      {children}
    </Panel>
  );
}

const styles = StyleSheet.create({
  panel: {
    backgroundColor: colors.bg1,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.line,
  },
  padded: { padding: space[4] },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: space[3],
    gap: space[4],
  },
  rowBorder: { borderBottomWidth: 1, borderBottomColor: colors.line },
  rowText: { flex: 1, gap: 2 },
  rowValue: { textAlign: 'right' },
  meter: { gap: space[2] },
  meterHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end' },
  meterTrack: { height: 6, borderRadius: 3, backgroundColor: colors.bg2, overflow: 'hidden' },
  meterFill: { height: '100%', borderRadius: 3 },
  chip: {
    alignSelf: 'flex-start',
    borderWidth: 1,
    borderRadius: radii.pill,
    paddingHorizontal: space[3],
    paddingVertical: 4,
  },
  divider: { height: 1, backgroundColor: colors.line, alignSelf: 'stretch' },
  empty: { alignItems: 'flex-start', gap: space[2] },
  emptyBody: { maxWidth: 320 },
});
