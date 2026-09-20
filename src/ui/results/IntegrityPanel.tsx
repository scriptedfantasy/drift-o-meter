/**
 * What the score is worth: if the mount was loose or the GPS was poor, it is said here in
 * plain language, next to the number it qualifies.
 */
import { StyleSheet, View } from 'react-native';
import Animated from 'react-native-reanimated';

import { AppText } from '../Text';
import { alpha, colors, radii, space } from '../theme';
import { useEnter } from './entrance';
import type { IntegrityNote, NoteLevel } from './model';

// gold is the S grade's colour and nothing else: a warning is ember, a failure is red
const LEVEL_COLOR: Record<NoteLevel, string> = { ok: colors.green, warn: colors.ember, bad: colors.red };
const LEVEL_WORD: Record<NoteLevel, string> = { ok: 'CLEAN', warn: 'CHECK', bad: 'WARNING' };

export function IntegrityPanel({ notes, run, reduceMotion = false, testID }: { notes: IntegrityNote[]; run: boolean; reduceMotion?: boolean; testID?: string }) {
  const enter = useEnter(100, run, reduceMotion);
  return (
    <Animated.View style={[styles.wrap, enter]} testID={testID}>
      {notes.map((n, i) => (
        <View key={i} style={[styles.note, { borderLeftColor: LEVEL_COLOR[n.level], backgroundColor: alpha(LEVEL_COLOR[n.level], n.level === 'ok' ? 0.05 : 0.09) }]}>
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
    borderLeftWidth: 3,
    borderRadius: radii.md,
    paddingVertical: space[3],
    paddingHorizontal: space[4],
    gap: space[1],
  },
  head: { gap: 1 },
  title: { fontSize: 19, lineHeight: 22 },
});
