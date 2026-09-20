import { Link, Stack } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { Body, Button, Screen, space, TopBar } from '@/ui';

export default function NotFoundScreen() {
  return (
    <Screen>
      <Stack.Screen options={{ title: 'Off track' }} />
      <TopBar kicker="404" title="Off track" back={false} />
      <View style={styles.body}>
        <Body color="muted">That route does not exist. Head back to the garage.</Body>
        <Link href="/" asChild>
          <Button label="Back to garage" variant="secondary" />
        </Link>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: { gap: space[6], alignItems: 'flex-start' },
});
