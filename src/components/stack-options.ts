import type { NativeStackNavigationOptions } from 'expo-router';
import { Platform } from 'react-native';

import type { Theme } from '@/theme';

const ios = Platform.OS === 'ios';

/** Native header defaults: transparent (glass) on iOS, flat on Android. */
export function stackOptions(t: Theme): NativeStackNavigationOptions {
  return {
    headerTintColor: t.accentText,
    headerTitleStyle: { color: t.text },
    headerLargeTitleStyle: { color: t.text },
    headerShadowVisible: false,
    headerLargeTitleShadowVisible: false,
    headerBackButtonDisplayMode: 'minimal',
    headerTransparent: ios,
    headerStyle: ios ? undefined : { backgroundColor: t.background },
    contentStyle: { backgroundColor: t.background },
  };
}

export function largeTitle(title: string): NativeStackNavigationOptions {
  return { title, headerLargeTitle: true };
}
