/**
 * The integrity monitor's reasoning, folded away until it is asked for.
 *
 * On a run the engine will not vouch for, the driver needs two things immediately: the one line
 * naming what to change, and the recording — which still plays, because it is real even when the
 * verdict on it is not. The long-form honesty (the fraction that was not believed, the
 * calibration that never resolved, the GPS gaps) is not hidden and not softened: it is one tap
 * away, under a control that says exactly what is behind it, and it opens in place.
 *
 * The same control carries the qualifying notes on a run the monitor DID believe, in grey rather
 * than red. Those notes used to sit open at the foot of the review under a section head of their
 * own, which put four paragraphs about GPS accuracy below every clean run; a driver who wants
 * them still gets every word, and one who does not gets a single line.
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
  /**
   * The monitor's own reason, when its message carried one ahead of the remedy. It is spoken as
   * part of the control's label — a screen reader hears WHY before deciding to open it — and it
   * is not printed a second time above the notes, which quote it word for word.
   */
  reason?: string | null;
  /**
   * The run was refused. The control goes red and says so; without it the control is the grey
   * disclosure over a believed run's qualifying notes.
   */
  refused?: boolean;
  run: boolean;
  reduceMotion?: boolean;
  /** Open on first render (the harness shoots the open state). */
  initiallyOpen?: boolean;
  testID?: string;
}

export function WhyUnscored({ notes, reason, refused = true, run, reduceMotion = false, initiallyOpen = false, testID }: WhyUnscoredProps) {
  const [open, setOpen] = useState(initiallyOpen);
  const count = notes.length;
  const tint = refused ? colors.red : colors.muted;
  const label = refused ? 'Why it was not judged' : 'What qualifies these numbers';
  return (
    <View style={styles.wrap} testID={testID}>
      <Pressable
        onPress={() => setOpen((v) => !v)}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${open ? `Hide: ${label.toLowerCase()}` : label}${reason ? `. ${reason}` : ''}`}
        testID="why-unscored"
        style={({ pressed }) => [styles.toggle, { borderColor: alpha(tint, open ? 0.7 : 0.45), backgroundColor: alpha(tint, 0.07) }, pressed && styles.pressed]}>
        <AppText variant="micro" color={tint}>
          {open ? '−' : '+'}
        </AppText>
        <AppText variant="micro" color={tint} numberOfLines={1} style={styles.label}>
          {label}
        </AppText>
        <AppText variant="micro" color="muted" numeric>
          {count} {count === 1 ? 'note' : 'notes'}
        </AppText>
      </Pressable>

      {open ? (
        <View style={styles.body}>
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
    // 44 dp, not the 32 the padding alone gave it: this is the only way to the monitor's
    // reasoning, and a driver who has just been told their run does not count is the last
    // person who should have to aim.
    minHeight: 44,
    borderWidth: 1,
    borderRadius: radii.sm,
    paddingHorizontal: space[3],
    paddingVertical: space[2],
  },
  pressed: { opacity: 0.7 },
  label: { flex: 1 },
  body: { gap: space[3] },
});
