import { DarkTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import * as SystemUI from 'expo-system-ui';
import { useEffect } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { colors, useAppFonts } from '@/ui';
import { useSkiaReady } from '@/ui/skia/useSkiaReady';

// Keep the native splash up until fonts (and, on web, CanvasKit) are ready.
SplashScreen.preventAutoHideAsync().catch(() => {});
SplashScreen.setOptions({ duration: 260, fade: true });

export const unstable_settings = {
  anchor: 'index',
};

const navTheme = {
  ...DarkTheme,
  dark: true,
  colors: {
    ...DarkTheme.colors,
    primary: colors.ember,
    background: colors.bg0,
    card: colors.bg1,
    text: colors.text,
    border: colors.line,
    notification: colors.magenta,
  },
};

export default function RootLayout() {
  const fonts = useAppFonts();
  const skia = useSkiaReady();
  const ready = (fonts.loaded || fonts.error !== null) && skia !== 'loading';

  useEffect(() => {
    if (Platform.OS !== 'web') SystemUI.setBackgroundColorAsync(colors.bg0).catch(() => {});
  }, []);

  useEffect(() => {
    if (fonts.error) console.warn('[fonts] failed to load, falling back to system fonts', fonts.error);
  }, [fonts.error]);

  useEffect(() => {
    if (ready) SplashScreen.hideAsync().catch(() => {});
  }, [ready]);

  if (!ready) return <View style={styles.boot} testID="boot" />;

  return (
    <GestureHandlerRootView style={styles.root}>
      <ThemeProvider value={navTheme}>
        <StatusBar style="light" />
        <Stack screenOptions={{ headerShown: false, contentStyle: styles.content, animation: 'fade' }}>
          <Stack.Screen name="index" />
          <Stack.Screen name="calibrate" />
          <Stack.Screen name="drive" options={{ gestureEnabled: false }} />
          <Stack.Screen name="results/[id]" />
          <Stack.Screen name="replay/[id]" />
          <Stack.Screen name="settings" />
          <Stack.Screen name="sound" />
          <Stack.Screen name="+not-found" />
        </Stack>
      </ThemeProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg0 },
  boot: { flex: 1, backgroundColor: colors.bg0 },
  content: { backgroundColor: colors.bg0 },
});
