/**
 * What the garage says when storage itself is the problem.
 *
 * The state this exists for: one perfectly readable recording on disk and an index that will
 * not parse. The screen used to draw "THE GARAGE · EMPTY · FIRST RUN · NOTHING TO BEAT YET"
 * over it, and the next save wrote a fresh one-entry index and orphaned every stored body
 * permanently. So the fault is named, the recordings are counted, and the repair is offered as
 * a choice rather than taken on the driver's behalf.
 */
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';

import { AppText, Micro, Small } from '../Text';
import { alpha, colors, radii, space } from '../theme';
import type { GarageFault } from './useGarage';

export interface FaultNoticeProps {
  fault: GarageFault;
  busy?: boolean;
  onAct?(): void;
  testID?: string;
}

export function FaultNotice({ fault, busy = false, onAct, testID }: FaultNoticeProps) {
  const color = fault.level === 'bad' ? colors.red : colors.gold;
  return (
    <View style={[styles.notice, { borderColor: alpha(color, 0.75), backgroundColor: alpha(color, 0.12) }]} testID={testID ?? `fault-${fault.kind}`}>
      <View style={[styles.bar, { backgroundColor: color }]} />
      <View style={styles.text}>
        <AppText variant="subheading" color={color} numberOfLines={2} style={styles.title}>
          {fault.title}
        </AppText>
        <Small color={colors.text} numberOfLines={5}>
          {fault.body}
        </Small>
        {fault.action && onAct ? (
          <Pressable
            onPress={onAct}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel={fault.action}
            hitSlop={10}
            testID="cta-rebuild-index"
            style={({ pressed }) => [styles.action, { borderColor: color }, pressed && styles.pressed, busy && styles.busy]}>
            {busy ? <ActivityIndicator size="small" color={color} /> : <Micro color={color}>{fault.action} →</Micro>}
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  notice: { flexDirection: 'row', gap: space[3], borderWidth: 1, borderRadius: radii.md, padding: space[3] },
  bar: { width: 4, alignSelf: 'stretch', borderRadius: 2 },
  text: { flex: 1, gap: space[2] },
  title: { fontSize: 18, lineHeight: 21 },
  action: { alignSelf: 'flex-start', borderWidth: 1, borderRadius: radii.sm, paddingHorizontal: space[4], minHeight: 44, justifyContent: 'center', marginTop: space[1] },
  busy: { opacity: 0.6 },
  pressed: { opacity: 0.7 },
});
