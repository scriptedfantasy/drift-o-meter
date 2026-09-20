/**
 * DRIVE. The reason the app exists, and the only thing on the garage screen that shouts.
 *
 * A skewed ember slab the width of the screen with the word set as large as it will go, the
 * label counter-skewed so the type stays upright-italic (the same trick `Button` uses), a hot
 * core gradient and an ember bloom around it. Everything else on this screen is grey by
 * comparison on purpose.
 */
import { LinearGradient } from 'expo-linear-gradient';
import { Pressable, StyleSheet, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';

import { AppText } from '../Text';
import { alpha, colors, glow, radii, space } from '../theme';

export interface DriveSlabProps {
  onPress(): void;
  /** One dark line inside the slab: what the next screen is about to do. */
  caption: string;
  label?: string;
  testID?: string;
}

export function DriveSlab({ onPress, caption, label = 'Drive', testID }: DriveSlabProps) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${label}. ${caption}`}
      testID={testID}
      style={({ pressed }) => [styles.slab, pressed && styles.pressed]}>
      <LinearGradient colors={[colors.ember, '#FF7A33', '#E8410B']} locations={[0, 0.45, 1]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.fill} pointerEvents="none" />
      <View style={styles.inner}>
        <View style={styles.wordRow}>
          <AppText variant="hero" color={colors.bg0} numberOfLines={1} style={styles.word}>
            {label.toUpperCase()}
          </AppText>
          <Chevrons />
        </View>
        <AppText variant="micro" color={alpha(colors.bg0, 0.78)} numberOfLines={1} style={styles.caption}>
          {caption}
        </AppText>
      </View>
    </Pressable>
  );
}

function Chevrons() {
  return (
    <Svg width={40} height={44} viewBox="0 0 40 44" fill="none" style={styles.chevrons}>
      <Path d="M6 8 22 22 6 36" stroke={colors.bg0} strokeWidth={5} strokeLinecap="square" strokeLinejoin="miter" opacity={0.9} />
      <Path d="M22 8 38 22 22 36" stroke={colors.bg0} strokeWidth={5} strokeLinecap="square" strokeLinejoin="miter" opacity={0.45} />
    </Svg>
  );
}

const SKEW = '-8deg';

const styles = StyleSheet.create({
  slab: {
    alignSelf: 'stretch',
    minHeight: 118,
    borderRadius: radii.md,
    overflow: 'hidden',
    justifyContent: 'center',
    transform: [{ skewX: SKEW }],
    ...glow(colors.ember, 1.3),
  },
  fill: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  inner: { paddingHorizontal: space[6], paddingVertical: space[4], transform: [{ skewX: '8deg' }], gap: 0 },
  wordRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space[3] },
  word: { fontSize: 68, lineHeight: 70, letterSpacing: -2 },
  chevrons: { marginRight: -space[1] },
  caption: { marginTop: -space[1], letterSpacing: 1.6 },
  pressed: { opacity: 0.88, transform: [{ skewX: SKEW }, { scale: 0.99 }] },
});
