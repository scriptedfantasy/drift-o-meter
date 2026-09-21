/**
 * What the figures on this page are worth: if the mount was loose, the GPS was poor or the
 * motion was not something a car can do, it is said here in plain language.
 *
 * This is NOT a judgement of the driving and never was — it is a judgement of the DATA, which is
 * why it survived the scoring going away. A phone waved about in a parked car produces large
 * slip angles and a perfectly well-formed run; the monitor is the only thing in the app that
 * knows, and this is where it says so.
 */
import { StyleSheet, View } from 'react-native';
import Animated from 'react-native-reanimated';

import { AppText } from '../Text';
import { alpha, colors, radii, space } from '../theme';
import { useEnter } from './entrance';
import type { IntegrityNote, NoteLevel } from './model';

// Three levels, three colours off the car: the data is sound, the data is qualified, the data is
// not believed. `greenHot` is the caution step on the dial's own ramp, so a warning here is the
// same colour a warning is on the gauge.
const LEVEL_COLOR: Record<NoteLevel, string> = { ok: colors.green, warn: colors.greenHot, bad: colors.red };
const LEVEL_WORD: Record<NoteLevel, string> = { ok: 'CLEAN', warn: 'CHECK', bad: 'WARNING' };

export function IntegrityPanel({ notes, run, reduceMotion = false, testID }: { notes: IntegrityNote[]; run: boolean; reduceMotion?: boolean; testID?: string }) {
  const enter = useEnter(100, run, reduceMotion);
  return (
    <Animated.View style={[styles.wrap, enter]} testID={testID}>
      {notes.map((n, i) => (
        // NO ACCENT STRIPE down the side. Severity is the colour of the words that state it —
        // CLEAN, CHECK, WARNING — and a note whose meaning lives in a 3 dp bar is a note whose
        // meaning is invisible to anyone reading it aloud.
        <View key={i} style={[styles.note, { backgroundColor: alpha(LEVEL_COLOR[n.level], n.level === 'ok' ? 0.05 : 0.09) }]}>
          <View style={styles.head}>
            <AppText variant="micro" color={LEVEL_COLOR[n.level]}>
              {LEVEL_WORD[n.level]}
            </AppText>
            <AppText variant="subheading" color={n.level === 'ok' ? 'text' : LEVEL_COLOR[n.level]} style={styles.title}>
              {n.title}
            </AppText>
          </View>
          <AppText variant="small" color="muted">
            {n.body}
          </AppText>
        </View>
      ))}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: space[2] },
  note: {
    borderRadius: radii.md,
    paddingVertical: space[3],
    paddingHorizontal: space[4],
    gap: space[1],
  },
  head: { gap: 1 },
  title: { fontSize: 19, lineHeight: 22 },
});
