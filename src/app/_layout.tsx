import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect } from 'react';
import { StatusBar } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ActionSheetHost } from '@/components/action-sheet';
import { stackOptions } from '@/components/stack-options';
import { ToastHost } from '@/components/toast';
import { brand, useTheme } from '@/theme';
import { loadAppearance } from '@/theme/appearance';

SplashScreen.preventAutoHideAsync().catch(() => {});
loadAppearance();

export default function RootLayout() {
  const t = useTheme();
  useEffect(() => {
    SplashScreen.hideAsync().catch(() => {});
  }, []);

  const base = t.scheme === 'dark' ? DarkTheme : DefaultTheme;
  const navTheme = {
    ...base,
    colors: {
      ...base.colors,
      primary: brand.purple,
      background: t.background,
      card: t.background,
      text: t.text,
      border: t.hairline,
    },
  };

  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: t.background }}>
      {/* Explicit provider: the toast and sheet hosts live outside the navigator. */}
      <SafeAreaProvider>
        <ThemeProvider value={navTheme}>
          <StatusBar barStyle={t.scheme === 'dark' ? 'light-content' : 'dark-content'} />
          <Stack screenOptions={stackOptions(t)}>
            <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
            <Stack.Screen name="folder/[...path]" options={{ headerLargeTitle: true, title: '' }} />
            <Stack.Screen name="file/[...path]" options={{ title: '' }} />
            <Stack.Screen name="change/[id]" options={{ title: '' }} />
            <Stack.Screen name="agent/[id]" options={{ title: '' }} />
            <Stack.Screen name="edit/[...path]" options={{ presentation: 'modal', title: '' }} />
            <Stack.Screen name="new-file" options={{ presentation: 'modal', title: 'Nuovo file' }} />
            <Stack.Screen name="new-project" options={{ presentation: 'modal', title: 'Nuovo progetto' }} />
            <Stack.Screen name="rename" options={{ presentation: 'modal', title: 'Rinomina' }} />
            <Stack.Screen name="move" options={{ presentation: 'modal', title: 'Sposta in…' }} />
            <Stack.Screen name="connect-agent" options={{ presentation: 'modal', title: 'Collega un agente' }} />
          </Stack>
          <ActionSheetHost />
          <ToastHost />
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
