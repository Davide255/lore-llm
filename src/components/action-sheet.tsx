import { ActionSheetIOS, Modal, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Icon, type IconName } from './icon';
import { createSignal } from '@/data/store';
import { useTheme } from '@/theme';

export interface SheetOption {
  label: string;
  icon?: IconName;
  destructive?: boolean;
  /** Rendered as the prominent first button (Android/web sheet only). */
  primary?: boolean;
  onPress: () => void;
}

export interface SheetRequest {
  title?: string;
  message?: string;
  options: SheetOption[];
  cancelLabel?: string;
  onCancel?: () => void;
}

const current = createSignal<SheetRequest | null>(null);

/**
 * System action sheet on iOS (UIAlertController); a matching bottom sheet
 * on Android and web, where no multi-option native equivalent exists.
 */
export function showActionSheet(req: SheetRequest) {
  if (Platform.OS === 'ios') {
    const labels = [...req.options.map((o) => o.label), req.cancelLabel ?? 'Annulla'];
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title: req.title,
        message: req.message,
        options: labels,
        cancelButtonIndex: labels.length - 1,
        destructiveButtonIndex: req.options.flatMap((o, i) => (o.destructive ? [i] : [])),
      },
      (i) => {
        if (i === labels.length - 1) req.onCancel?.();
        else req.options[i]?.onPress();
      },
    );
    return;
  }
  current.set(req);
}

/** Mounted once at the root; renders the non-iOS sheet. */
export function ActionSheetHost() {
  const req = current.useValue();
  const t = useTheme();
  const insets = useSafeAreaInsets();
  if (Platform.OS === 'ios') return null;

  const close = (then?: () => void) => {
    current.set(null);
    then?.();
  };
  const primary = req?.options.filter((o) => o.primary) ?? [];
  const rows = req?.options.filter((o) => !o.primary) ?? [];

  return (
    <Modal visible={!!req} transparent animationType="fade" onRequestClose={() => close(req?.onCancel)}>
      <Pressable style={styles.scrim} onPress={() => close(req?.onCancel)}>
        <Pressable
          style={[styles.sheet, { backgroundColor: t.sheet, marginBottom: insets.bottom + 8 }]}
          onPress={(e) => e.stopPropagation()}>
          {(req?.title || req?.message) && (
            <View style={{ alignItems: 'center', paddingHorizontal: 14, paddingTop: 4, paddingBottom: 14 }}>
              {req?.title ? (
                <Text style={{ color: req.message ? t.text : t.textMuted, fontSize: req.message ? 17 : 12.5, fontWeight: req.message ? '600' : '400', textAlign: 'center' }}>
                  {req.title}
                </Text>
              ) : null}
              {req?.message ? (
                <Text style={{ color: t.textSecondary, fontSize: 13, marginTop: 6, textAlign: 'center' }}>{req.message}</Text>
              ) : null}
            </View>
          )}
          {primary.map((o) => (
            <Pressable key={o.label} onPress={() => close(o.onPress)} style={[styles.bigButton, { backgroundColor: t.accent, marginBottom: 8 }]}>
              <Text style={{ color: '#fff', fontSize: 16, fontWeight: '600' }}>{o.label}</Text>
            </Pressable>
          ))}
          {rows.length > 0 && (
            <View style={{ backgroundColor: t.fillSubtle, borderRadius: 14, overflow: 'hidden' }}>
              {rows.map((o, i) => (
                <Pressable
                  key={o.label}
                  onPress={() => close(o.onPress)}
                  style={({ pressed }) => [
                    styles.row,
                    i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: t.hairline },
                    pressed && { backgroundColor: t.fill },
                  ]}>
                  {o.icon && <Icon name={o.icon} size={21} color={o.destructive ? t.error : t.textSecondary} />}
                  <Text style={{ fontSize: 16, color: o.destructive ? t.error : t.text }}>{o.label}</Text>
                </Pressable>
              ))}
            </View>
          )}
          <Pressable onPress={() => close(req?.onCancel)} style={[styles.bigButton, { backgroundColor: t.fill, marginTop: 8 }]}>
            <Text style={{ color: t.text, fontSize: 16, fontWeight: '600' }}>{req?.cancelLabel ?? 'Annulla'}</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end', padding: 8 },
  sheet: { borderRadius: 22, paddingHorizontal: 12, paddingTop: 14, paddingBottom: 12 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 13, paddingHorizontal: 12, paddingVertical: 13 },
  bigButton: { height: 50, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
});
