import { GlassContainer, GlassView, isLiquidGlassAvailable } from 'expo-glass-effect';
import type { ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Animated, { useAnimatedKeyboard, useAnimatedStyle } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Icon, type IconName } from './icon';
import { fonts, useTheme } from '@/theme';

export type ToolbarTool =
  | { key: string; icon: IconName; label: string; onPress: () => void; active?: boolean }
  | { key: string; glyph: string; label: string; onPress: () => void; active?: boolean };

/**
 * Floating editor toolbar: a liquid-glass capsule that rides just above the
 * keyboard (or the home indicator when it is hidden). Replaces the docked
 * accessory bar of the wireframes (B1/B2).
 */
export function FloatingToolbar({ tools, trailing }: { tools: ToolbarTool[]; trailing?: ToolbarTool }) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const keyboard = useAnimatedKeyboard();
  const glass = isLiquidGlassAvailable();

  const position = useAnimatedStyle(() => ({
    bottom: Math.max(keyboard.height.value, insets.bottom) + 10,
  }));

  const button = (tool: ToolbarTool) => (
    <Pressable
      key={tool.key}
      onPress={tool.onPress}
      accessibilityLabel={tool.label}
      hitSlop={4}
      style={({ pressed }) => [styles.button, (pressed || tool.active) && { backgroundColor: t.fill }]}>
      {'icon' in tool ? (
        <Icon name={tool.icon} size={19} color={tool.active ? t.accentText : t.text} />
      ) : (
        <Text style={{ fontFamily: fonts.mono, fontSize: 14, fontWeight: '700', color: tool.active ? t.accentText : t.text }}>
          {tool.glyph}
        </Text>
      )}
    </Pressable>
  );

  // Plain function (not a component) so the ScrollView isn't remounted on every render.
  const capsule = (children: ReactNode, flex?: boolean) =>
    glass ? (
      <GlassView glassEffectStyle="regular" isInteractive style={[styles.capsule, flex && { flexShrink: 1 }]}>
        {children}
      </GlassView>
    ) : (
      <View
        style={[
          styles.capsule,
          flex && { flexShrink: 1 },
          {
            backgroundColor: t.scheme === 'dark' ? 'rgba(38,37,43,0.96)' : 'rgba(255,255,255,0.96)',
            borderColor: t.hairline,
            borderWidth: StyleSheet.hairlineWidth,
            boxShadow: '0 8px 28px rgba(0,0,0,0.28)',
          },
        ]}>
        {children}
      </View>
    );

  return (
    <Animated.View style={[styles.wrap, position]} pointerEvents="box-none">
      {wrapRow(
        glass,
        capsule(
          <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="always" contentContainerStyle={styles.tools}>
            {tools.map(button)}
          </ScrollView>,
          true,
        ),
        trailing && capsule(<View style={styles.tools}>{button(trailing)}</View>),
      )}
    </Animated.View>
  );
}

/** GlassContainer lets neighbouring glass capsules blend like system toolbars. */
function wrapRow(glass: boolean, main: ReactNode, trailing: ReactNode) {
  return glass ? (
    <GlassContainer spacing={10} style={styles.row}>
      {main}
      {trailing}
    </GlassContainer>
  ) : (
    <View style={styles.row}>
      {main}
      {trailing}
    </View>
  );
}

export const FLOATING_TOOLBAR_HEIGHT = 64;

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: 12, right: 12 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  capsule: { borderRadius: 26, overflow: 'hidden' },
  tools: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 6, paddingVertical: 6, gap: 2 },
  button: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
});
