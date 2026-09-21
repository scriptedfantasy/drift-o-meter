/**
 * DRIVE. The reason the app exists, and the only thing on the garage screen that shouts.
 *
 * A flat slab of the logo's own green across the full width, pinned to the bottom of the
 * screen where a thumb already is, with the word set as large as it will go. Everything else
 * on this screen is grey by comparison on purpose.
 *
 * It was a skewed ember slab with a three-stop orange gradient and a bloom around it. The
 * green is not a restyle: green in this app means a run is happening and nothing else is
 * allowed to use it (`src/ui/theme.ts`), so the one control that starts a run is the one
 * control that wears it.
 *
 * The caption sits UNDER the slab rather than inside it. Inside, it competed with the word at
 * a third of its size, and in landscape the stacked version left ~55 % of the slab empty
 * colour, which reads as an unfinished button rather than as a slab.
 */
import { Pressable, StyleSheet, View } from 'react-native';

import { AppText, Micro } from '../Text';
import { colors, radii, space } from '../theme';

export interface DriveSlabProps {
  onPress(): void;
  /** One line under the slab: what the next screen is about to do. */
  caption: string;
  /** Landscape or a tablet: the caption sits beside the word instead of under the slab. */
  inline?: boolean;
  label?: string;
  testID?: string;
}

export function DriveSlab({ onPress, caption, inline = false, label = 'Drive', testID }: DriveSlabProps) {
  return (
    <View style={styles.wrap}>
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={`${label}. ${caption}`}
        testID={testID}
        style={({ pressed }) => [styles.slab, pressed && styles.pressed]}>
        <AppText variant="title" color={colors.bg0} numberOfLines={1} style={styles.word}>
          {label.toUpperCase()}
        </AppText>
        {inline ? (
          <AppText variant="micro" color={colors.bg0} numberOfLines={2} style={styles.captionInline}>
            {caption}
          </AppText>
        ) : null}
      </Pressable>
      {inline ? null : (
        <Micro numberOfLines={1} style={styles.caption}>
          {caption}
        </Micro>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: space[2] },
  slab: {
    alignSelf: 'stretch',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space[3],
    minHeight: 62,
    paddingHorizontal: space[5],
    borderRadius: radii.lg,
    backgroundColor: colors.green,
  },
  word: { fontSize: 28, lineHeight: 34, letterSpacing: 1.4 },
  captionInline: { flexShrink: 1, textAlign: 'right', opacity: 0.78 },
  caption: { textAlign: 'center' },
  pressed: { opacity: 0.86 },
});
