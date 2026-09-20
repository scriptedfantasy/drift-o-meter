import { StyleSheet, View } from 'react-native';

import { AppText, Micro } from './Text';
import { space } from './theme';

/** The app wordmark: DRIFT-O-METER with the hyphens burning ember. */
export function Wordmark({ tagline = 'Night session judge' }: { tagline?: string | null }) {
  return (
    <View style={styles.wrap}>
      <AppText variant="title" style={styles.mark} accessibilityRole="header">
        DRIFT
        <AppText variant="title" color="ember">
          -O-
        </AppText>
        METER
      </AppText>
      {tagline ? <Micro style={styles.tagline}>{tagline}</Micro> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: space[1] },
  mark: { letterSpacing: -0.5 },
  tagline: { letterSpacing: 2.2 },
});
