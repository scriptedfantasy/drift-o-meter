/**
 * Rename a driver, or forget one. Reached by holding their chip.
 *
 * It is a sheet rather than a row of small icons next to every name because the chip row is
 * the thing a driver taps at arm's length before pulling away, and two extra targets inside a
 * 44 dp chip is how somebody deletes a season by accident. Holding is deliberate; the sheet
 * then has room for a real field and for the sentence that says what forgetting costs.
 *
 * `Alert.alert` is a no-op on web, and this app is reviewed and photographed in a browser, so
 * the question is the app's own on every platform — the same reason `ConfirmDialog` exists.
 * This sheet does NOT ask it: it hands the removal up, and the screen puts the confirmation
 * in front of it (`driverCopy.removeDriverCopy`).
 */
import { useRef, useState } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';

import { MAX_NAME, type AddDriverError, type Driver } from '../../platform/drivers';
import { Button } from '../Button';
import { AppText, Body, Micro } from '../Text';
import { alpha, colors, gutter, radii, space } from '../theme';
import { addErrorText } from './driverCopy';

export interface DriverSheetProps {
  driver: Driver;
  /** How many stored runs are filed under them, for the line above the buttons. */
  runs: number;
  /** Why the last rename was refused, or null. */
  error: AddDriverError | null;
  busy?: boolean;
  onRename(name: string): void;
  onRemove(): void;
  onClose(): void;
  testID?: string;
}

/**
 * The caller must give this a `key` of the driver's id. The field is seeded from the name once,
 * at mount, and re-seeding it from a prop in an effect is a cascading render — so switching
 * from one driver to another is a REMOUNT, which is also the only reading under which a
 * half-typed name belongs to the driver it was typed for.
 */
export function DriverSheet({ driver, runs, error, busy = false, onRename, onRemove, onClose, testID }: DriverSheetProps) {
  const [draft, setDraft] = useState(driver.name);
  const input = useRef<TextInput>(null);

  const message = addErrorText(error);
  const changed = draft.trim() !== driver.name;

  return (
    <View style={styles.root} testID={testID}>
      <Pressable style={styles.scrim} onPress={onClose} accessibilityRole="button" accessibilityLabel="Close" />
      <View style={styles.sheet} accessibilityViewIsModal accessibilityRole="alert">
        <AppText variant="heading" uppercase style={styles.title} numberOfLines={1}>
          {driver.name}
        </AppText>
        <Body color="muted" style={styles.body}>
          {runs === 0 ? 'No runs are filed under this name yet.' : runs === 1 ? '1 run is filed under this name.' : `${runs} runs are filed under this name.`}
        </Body>

        <View style={styles.field}>
          <Micro>Name</Micro>
          <TextInput
            ref={input}
            value={draft}
            onChangeText={setDraft}
            onSubmitEditing={() => onRename(draft)}
            maxLength={MAX_NAME}
            autoCapitalize="words"
            autoCorrect={false}
            returnKeyType="done"
            accessibilityLabel="Driver’s name"
            testID="driver-rename"
            style={styles.input}
          />
          {message ? (
            <Micro color="red" numberOfLines={2} style={styles.message}>
              {message}
            </Micro>
          ) : null}
        </View>

        <View style={styles.actions}>
          <Button label="Done" variant="secondary" onPress={onClose} style={styles.action} testID="driver-done" />
          <Button label="Save" variant="primary" disabled={!changed || busy} onPress={() => onRename(draft)} style={styles.action} testID="driver-rename-save" />
        </View>
        <Button label="Forget this driver" variant="danger" disabled={busy} onPress={onRemove} testID="driver-remove" />
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
    borderColor: colors.line,
    borderRadius: radii.lg,
  },
  title: { fontSize: 26, lineHeight: 28 },
  body: { maxWidth: 420 },
  field: { gap: space[2] },
  input: {
    minHeight: 44,
    paddingHorizontal: space[3],
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.bg2,
    color: colors.text,
    fontFamily: 'Barlow_500Medium',
    fontSize: 16,
  },
  message: { textTransform: 'none', letterSpacing: 0.2 },
  actions: { flexDirection: 'row', gap: space[3] },
  action: { flex: 1 },
});
