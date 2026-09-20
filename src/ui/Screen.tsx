import { useRouter } from 'expo-router';
import type { ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Svg, { Path } from 'react-native-svg';

import { AppText, Label, Title } from './Text';
import { colors, gutter, space } from './theme';

export interface ScreenProps {
  children?: ReactNode;
  /** Wrap content in a ScrollView. */
  scroll?: boolean;
  /** Apply the standard horizontal gutter. */
  padded?: boolean;
  style?: StyleProp<ViewStyle>;
  contentStyle?: StyleProp<ViewStyle>;
  testID?: string;
}

/** Full-bleed asphalt-black screen with safe-area insets. */
export function Screen({ children, scroll = false, padded = true, style, contentStyle, testID }: ScreenProps) {
  const inner = [padded && styles.padded, contentStyle];
  return (
    <View style={[styles.root, style]} testID={testID}>
      <SafeAreaView style={styles.safe} edges={['top', 'bottom', 'left', 'right']}>
        {scroll ? (
          <ScrollView style={styles.flex} contentContainerStyle={[styles.scrollContent, inner]} showsVerticalScrollIndicator={false}>
            {children}
          </ScrollView>
        ) : (
          <View style={[styles.flex, inner]}>{children}</View>
        )}
      </SafeAreaView>
    </View>
  );
}

export interface TopBarProps {
  /** Big italic screen title. */
  title?: string;
  /** Small uppercase line above the title. */
  kicker?: string;
  back?: boolean;
  right?: ReactNode;
  testID?: string;
}

/** Back affordance on the left, optional slot on the right, then the screen title. */
export function TopBar({ title, kicker, back = true, right, testID }: TopBarProps) {
  const router = useRouter();
  const goBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/');
  };
  return (
    <View style={styles.topBar} testID={testID}>
      <View style={styles.topRow}>
        {back ? (
          <Pressable onPress={goBack} hitSlop={12} accessibilityRole="button" accessibilityLabel="Back" style={({ pressed }) => [styles.back, pressed && styles.pressed]}>
            <Chevron />
            <Label color="muted">Back</Label>
          </Pressable>
        ) : (
          <View />
        )}
        {right ?? <View />}
      </View>
      {kicker ? <Label color="ember">{kicker}</Label> : null}
      {title ? <Title style={styles.title}>{title}</Title> : null}
    </View>
  );
}

function Chevron() {
  return (
    <Svg width={14} height={14} viewBox="0 0 24 24" fill="none">
      <Path d="M15 5 8 12l7 7" stroke={colors.muted} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

/** Section header inside a screen. */
export function SectionHeader({ title, right }: { title: string; right?: ReactNode }) {
  return (
    <View style={styles.section}>
      <AppText variant="heading" uppercase>
        {title}
      </AppText>
      {right}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg0 },
  safe: { flex: 1 },
  flex: { flex: 1 },
  padded: { paddingHorizontal: gutter },
  scrollContent: { flexGrow: 1, paddingBottom: space[8] },
  topBar: { paddingTop: space[2], paddingBottom: space[4], gap: space[1] },
  topRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 36, marginBottom: space[2] },
  back: { flexDirection: 'row', alignItems: 'center', gap: space[1] },
  pressed: { opacity: 0.6 },
  title: { marginTop: 2 },
  section: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    marginTop: space[6],
    marginBottom: space[3],
  },
});
