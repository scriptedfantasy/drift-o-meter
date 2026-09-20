/**
 * The reasoning behind a refusal, folded away until it is asked for.
 *
 * On a run the engine will not score, the driver needs two things immediately: the one line
 * naming what to change, and the recording — which still plays, because it is real even when
 * the score is not. The long-form honesty (the fraction that was not believed, the calibration
 * that never resolved, the GPS gaps) is not hidden and not softened: it is one tap away, under a
 * control that says exactly what is behind it, and it opens in place.
 */
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { AppText } from '../Text';
import { alpha, colors, radii, space } from '../theme';
import { IntegrityPanel } from './IntegrityPanel';
import type { IntegrityNote } from './model';

export interface WhyUnscoredProps {
  /** Every integrity note the model produced — shown verbatim, nothing summarised away. */
  notes: IntegrityNote[];
  /** The scorer's own reason, when its message carried one ahead of the remedy. */
  reason?: string | null;
  run: boolean;
  reduceMotion?: boolean;
  /** Open on first render (the harness shoots the open state). */
  initiallyOpen?: boolean;
  testID?: string;
}

export function WhyUnscored({ notes, reason, run, reduceMotion = false, initiallyOpen = false, testID }: WhyUnscoredProps) {
  const [open, setOpen] = useState(initiallyOpen);
  const count = notes.length;
  return (
    <View style={styles.wrap} testID={testID}>
      <Pressable
        onPress={() => setOpen((v) => !v)}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={open ? 'Hide why this run was not scored' : 'Why this run was not scored'}
        testID="why-unscored"
        style={({ pressed }) => [styles.toggle, open && styles.toggleOpen, pressed && styles.pressed]}>
        <AppText variant="micro" color={colors.red}>
          {open ? '−' : '+'}
        </AppText>
        <AppText variant="micro" color={colors.red} numberOfLines={1} style={styles.label}>
          Why it was not scored
        </AppText>
        <AppText variant="micro" color="muted" numeric>
          {count} {count === 1 ? 'note' : 'notes'}
        </AppText>
      </Pressable>

      {open ? (
        <View style={styles.body}>
          {reason ? (
            <AppText variant="small" color="muted">
              {reason}
            </AppText>
          ) : null}
          <IntegrityPanel notes={notes} run={run} reduceMotion={reduceMotion} testID="integrity" />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: space[3] },
  toggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[2],
    borderWidth: 1,
    borderColor: alpha(colors.red, 0.45),
    borderRadius: radii.sm,
    backgroundColor: alpha(colors.red, 0.07),
    paddingHorizontal: space[3],
    paddingVertical: space[2],
  },
  toggleOpen: { borderColor: alpha(colors.red, 0.7) },
  pressed: { opacity: 0.7 },
  label: { flex: 1 },
  body: { gap: space[3] },
});
