/**
 * WHO IS DRIVING: the roster as a row of chips, and the one control that adds to it.
 *
 * The driver is picked BEFORE the run, here, because that is the only moment it can be picked
 * honestly — asking afterwards is asking someone to remember, and asking at the moment the
 * car is about to move is asking at exactly the wrong time (`platform/drivers.ts`). Tapping a
 * chip is the whole interaction: the drive screen stamps whoever is active onto the session
 * and never blocks on this.
 *
 * NOBODY is a legitimate answer. The roster starts empty, the first run happens before anyone
 * has typed a name, and tapping the active chip again clears the selection rather than
 * trapping a driver into a name they picked by accident. A run recorded that way is listed as
 * unassigned, not hidden.
 *
 * The chips are 44 dp tall and the "+" is 44 × 44, because this is reached for in a car with
 * gloves on, and the "+" carries a label of its own — it is the one control here with no word
 * in it.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';

import { MAX_DRIVERS, MAX_NAME, type AddDriverError, type Driver } from '../../platform/drivers';
import { AppText, Micro } from '../Text';
import { alpha, colors, radii, space } from '../theme';
import { addErrorText, driverHandle } from './driverCopy';

export interface DriverBarProps {
  drivers: readonly Driver[];
  activeId: string | null;
  /** Why the last edit was refused, or null. */
  error: AddDriverError | null;
  onSelect(id: string | null): void;
  /** Long press, or the chip's own accessibility action: open rename / remove. */
  onEdit(driver: Driver): void;
  onAdd(name: string): Promise<Driver | null>;
  testID?: string;
}

export function DriverBar({ drivers, activeId, error, onSelect, onEdit, onAdd, testID }: DriverBarProps) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');
  const input = useRef<TextInput>(null);
  const full = drivers.length >= MAX_DRIVERS;

  useEffect(() => {
    if (adding) input.current?.focus();
  }, [adding]);

  const submit = useCallback(async () => {
    const driver = await onAdd(draft);
    // Only close on success. A refused name stays in the field with the reason under it —
    // clearing it would make the driver retype a name to find out what was wrong with it.
    if (driver) {
      setDraft('');
      setAdding(false);
    }
  }, [draft, onAdd]);

  const message = adding ? addErrorText(error) : null;

  return (
    <View style={styles.bar} testID={testID}>
      <Micro>Who is driving</Micro>
      <View style={styles.chips}>
        {drivers.map((d) => (
          <Chip
            key={d.id}
            driver={d}
            active={d.id === activeId}
            // Tapping the driver who is already at the wheel puts nobody there. The run is
            // then saved unassigned, which is a real answer and reversible from this same row.
            onPress={() => onSelect(d.id === activeId ? null : d.id)}
            onLongPress={() => onEdit(d)}
          />
        ))}
        {adding ? null : (
          <Pressable
            onPress={() => setAdding(true)}
            disabled={full}
            accessibilityRole="button"
            accessibilityLabel="Add a driver"
            testID="driver-add"
            style={({ pressed }) => [styles.chip, styles.addChip, full && styles.chipDisabled, pressed && styles.pressed]}>
            <AppText variant="subheading" color={colors.muted} style={styles.plus}>
              +
            </AppText>
          </Pressable>
        )}
      </View>

      {adding ? (
        <View style={styles.addRow}>
          <TextInput
            ref={input}
            value={draft}
            onChangeText={setDraft}
            onSubmitEditing={() => void submit()}
            placeholder="Name"
            placeholderTextColor={colors.muted}
            maxLength={MAX_NAME}
            autoCapitalize="words"
            autoCorrect={false}
            returnKeyType="done"
            accessibilityLabel="New driver’s name"
            testID="driver-name"
            style={styles.input}
          />
          <Pressable
            onPress={() => void submit()}
            accessibilityRole="button"
            accessibilityLabel="Save this driver"
            testID="driver-save"
            style={({ pressed }) => [styles.action, styles.save, pressed && styles.pressed]}>
            <Micro color={colors.bg0}>Save</Micro>
          </Pressable>
          <Pressable
            onPress={() => {
              setDraft('');
              setAdding(false);
            }}
            accessibilityRole="button"
            accessibilityLabel="Cancel adding a driver"
            testID="driver-cancel"
            style={({ pressed }) => [styles.action, pressed && styles.pressed]}>
            <Micro>Cancel</Micro>
          </Pressable>
        </View>
      ) : null}

      {message ? (
        <Micro color="red" numberOfLines={2} style={styles.message}>
          {message}
        </Micro>
      ) : null}
      {full && !adding ? (
        <Micro numberOfLines={2} style={styles.message}>
          {addErrorText('full')}
        </Micro>
      ) : null}
    </View>
  );
}

function Chip({ driver, active, onPress, onLongPress }: { driver: Driver; active: boolean; onPress(): void; onLongPress(): void }) {
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={420}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      accessibilityLabel={`${driver.name}${active ? ', driving' : ''}`}
      accessibilityHint="Hold to rename or remove"
      testID={`driver-chip-${driverHandle(driver)}`}
      style={({ pressed }) => [styles.chip, active ? styles.chipActive : styles.chipIdle, pressed && styles.pressed]}>
      <AppText variant="subheading" numberOfLines={1} style={styles.chipLabel}>
        {driver.name}
      </AppText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  bar: { gap: space[2] },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space[2] },
  chip: {
    minHeight: 44,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: space[4],
    borderRadius: radii.pill,
    borderWidth: 1,
  },
  chipActive: { borderColor: colors.text, backgroundColor: alpha(colors.text, 0.1) },
  chipIdle: { borderColor: colors.line, backgroundColor: 'transparent' },
  chipDisabled: { opacity: 0.4 },
  chipLabel: { letterSpacing: 1, fontSize: 16, lineHeight: 20 },
  addChip: { width: 44, paddingHorizontal: 0, borderStyle: 'dashed', borderColor: colors.line },
  plus: { fontSize: 22, lineHeight: 24, letterSpacing: 0 },
  addRow: { flexDirection: 'row', alignItems: 'center', gap: space[2] },
  input: {
    flex: 1,
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
  action: { minHeight: 44, justifyContent: 'center', paddingHorizontal: space[3], borderRadius: radii.md, borderWidth: 1, borderColor: colors.line },
  save: { backgroundColor: colors.green, borderColor: colors.green },
  message: { textTransform: 'none', letterSpacing: 0.2 },
  pressed: { opacity: 0.7 },
});
