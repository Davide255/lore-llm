import { GlassView, isLiquidGlassAvailable } from 'expo-glass-effect';
import { useEffect } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeInDown, FadeOutDown } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Icon, type IconName } from './icon';
import { createSignal } from '@/data/store';
import { fonts, useTheme } from '@/theme';

interface ToastRequest {
  id: number;
  icon: IconName;
  /** Rendered in monospace, followed by `message`. */
  subject?: string;
  message: string;
  actionLabel?: string;
  onAction?: () => void;
  duration: number;
}

const current = createSignal<ToastRequest | null>(null);
let seq = 0;

export function showToast(req: Omit<ToastRequest, 'id' | 'duration'> & { duration?: number }) {
  current.set({ duration: 4000, ...req, id: ++seq });
}

/** Mounted once at the root, floats above tab bars and toolbars. */
export function ToastHost() {
  const toast = current.useValue();
  const t = useTheme();
  const insets = useSafeAreaInsets();

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => {
      if (current.get()?.id === toast.id) current.set(null);
    }, toast.duration);
    return () => clearTimeout(timer);
  }, [toast]);

  if (!toast) return null;
  const glass = isLiquidGlassAvailable();
  const content = (
    <View style={styles.inner}>
      <Icon name={toast.icon} size={20} color={t.textSecondary} />
      <Text style={{ flex: 1, color: t.text, fontSize: 14, lineHeight: 19 }} numberOfLines={2}>
        {toast.subject ? <Text style={{ fontFamily: fonts.mono }}>{toast.subject} </Text> : null}
        {toast.message}
      </Text>
      {toast.actionLabel && (
        <Pressable
          hitSlop={10}
          onPress={() => {
            current.set(null);
            toast.onAction?.();
          }}>
          <Text style={{ color: t.accentText, fontSize: 14, fontWeight: '600' }}>{toast.actionLabel}</Text>
        </Pressable>
      )}
    </View>
  );

  return (
    <Animated.View
      key={toast.id}
      entering={FadeInDown.springify().damping(18)}
      exiting={FadeOutDown}
      pointerEvents="box-none"
      style={[styles.wrap, { bottom: insets.bottom + 64 }]}>
      {glass ? (
        <GlassView glassEffectStyle="regular" isInteractive style={styles.card}>
          {content}
        </GlassView>
      ) : (
        <View style={[styles.card, { backgroundColor: t.scheme === 'dark' ? 'rgba(58,57,64,0.97)' : 'rgba(255,255,255,0.98)', boxShadow: '0 12px 32px rgba(0,0,0,0.35)' }]}>
          {content}
        </View>
      )}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: 14, right: 14 },
  card: { borderRadius: 18, overflow: 'hidden' },
  inner: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 15, paddingVertical: 13 },
});
