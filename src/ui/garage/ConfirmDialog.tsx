/**
 * The app's own confirmation. `Alert.alert` is a no-op on web, and deleting a night's driving
 * is exactly the thing that must not silently happen because the platform swallowed the
 * question — so the garage asks in its own voice, on every platform, and says what will be
 * lost before it offers the red button.
 */
import { Pressable, StyleSheet, View } from 'react-native';

import { Button } from '../Button';
import { AppText, Body, Small } from '../Text';
import { alpha, colors, gutter, radii, space } from '../theme';

export interface ConfirmDialogProps {
  title: string;
  body: string;
  /** One line of what is about to go, e.g. the run's grade and date. */
  detail?: string;
  confirmLabel: string;
  cancelLabel?: string;
  busy?: boolean;
  onConfirm(): void;
  onCancel(): void;
  testID?: string;
}

export function ConfirmDialog({ title, body, detail, confirmLabel, cancelLabel = 'Keep it', busy = false, onConfirm, onCancel, testID }: ConfirmDialogProps) {
  return (
    <View style={styles.root} testID={testID}>
      <Pressable style={styles.scrim} onPress={onCancel} accessibilityRole="button" accessibilityLabel="Cancel" />
      <View style={styles.sheet} accessibilityViewIsModal accessibilityRole="alert">
        <View style={styles.bar} />
        <AppText variant="heading" color="red" uppercase style={styles.title}>
          {title}
        </AppText>
        <Body color="muted" style={styles.body}>
          {body}
        </Body>
        {detail ? (
          <Small color="text" style={styles.detail}>
            {detail}
          </Small>
        ) : null}
        <View style={styles.actions}>
          <Button label={cancelLabel} variant="secondary" onPress={onCancel} style={styles.action} testID="confirm-cancel" />
          <Button label={busy ? 'Deleting' : confirmLabel} variant="danger" disabled={busy} onPress={onConfirm} style={styles.action} testID="confirm-delete" />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, justifyContent: 'flex-end', zIndex: 20 },
  scrim: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: alpha(colors.bg0, 0.88) },
  sheet: {
    margin: gutter,
    padding: space[5],
    gap: space[3],
    backgroundColor: colors.bg1,
    borderWidth: 1,
    borderColor: alpha(colors.red, 0.55),
    borderRadius: radii.lg,
  },
  bar: { height: 3, width: 48, backgroundColor: colors.red, transform: [{ skewX: '-8deg' }] },
  title: { fontSize: 26, lineHeight: 28 },
  body: { maxWidth: 420 },
  detail: { borderLeftWidth: 2, borderLeftColor: colors.line, paddingLeft: space[3] },
  actions: { flexDirection: 'row', gap: space[3], marginTop: space[2] },
  action: { flex: 1 },
});
