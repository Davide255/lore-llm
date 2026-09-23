import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, TextInput, View } from 'react-native';

import type { ProjectIcon } from '@/api';
import { showActionSheet } from '@/components/action-sheet';
import { HeaderItems } from '@/components/header-items';
import { Icon, projectIcons } from '@/components/icon';
import { Cell, Section, SectionHeader } from '@/components/ui';
import { actions, attempt } from '@/data/hooks';
import { routes } from '@/lib/routes';
import { brand, useTheme } from '@/theme';

const iconLabels: Record<ProjectIcon, string> = {
  folder: 'Cartella',
  fitness: 'Fitness',
  web: 'Web',
  server: 'Server',
  campaign: 'Comunicazione',
  science: 'Ricerca',
  book: 'Documentazione',
  code: 'Codice',
  design: 'Design',
  rocket: 'Lancio',
};

/** C3 — New project. index.md is mandatory, checklist.md optional. */
export default function NewProjectScreen() {
  const t = useTheme();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [icon, setIcon] = useState<ProjectIcon>('folder');
  const [withChecklist, setWithChecklist] = useState(true);
  const [busy, setBusy] = useState(false);
  const valid = name.trim().length > 0 && !name.includes('/');

  const create = async () => {
    setBusy(true);
    const project = await attempt(
      () => actions.createProject({ name, description, icon, withChecklist }),
      'Impossibile creare il progetto',
    );
    setBusy(false);
    if (project) {
      router.back();
      router.push(routes.folder(project.name));
    }
  };

  const pickIcon = () =>
    showActionSheet({
      title: 'Icona del progetto',
      options: (Object.keys(iconLabels) as ProjectIcon[]).map((k) => ({
        label: iconLabels[k],
        icon: projectIcons[k],
        onPress: () => setIcon(k),
      })),
    });

  return (
    <>
      <HeaderItems
        left={[{ kind: 'button', label: 'Annulla', onPress: () => router.back() }]}
        right={[{ kind: 'button', label: 'Crea', variant: 'prominent', disabled: !valid || busy, onPress: create }]}
      />
      <ScrollView
        style={{ flex: 1, backgroundColor: t.background }}
        contentContainerStyle={{ padding: 16, paddingTop: 12 }}
        keyboardShouldPersistTaps="handled"
        contentInsetAdjustmentBehavior="automatic">
        <View style={{ alignItems: 'center', paddingTop: 14, paddingBottom: 18 }}>
          <Pressable onPress={pickIcon} accessibilityLabel="Cambia icona" style={[styles.avatar, { backgroundColor: t.accentSoft }]}>
            <Icon name={projectIcons[icon]} size={34} color={t.accentText} />
            <View style={[styles.badge, { backgroundColor: t.cellRaised, borderColor: t.background }]}>
              <Icon name="edit" size={13} color={t.textSecondary} />
            </View>
          </Pressable>
        </View>

        <SectionHeader style={{ marginTop: 0 }}>Nome progetto</SectionHeader>
        <TextInput
          value={name}
          onChangeText={setName}
          placeholder="es. Ricerca LLM"
          placeholderTextColor={t.textMuted}
          autoFocus
          selectionColor={t.accentText}
          style={[styles.field, { backgroundColor: t.cell, color: t.text }]}
        />

        <SectionHeader>Descrizione</SectionHeader>
        <TextInput
          value={description}
          onChangeText={setDescription}
          placeholder="Una riga su cosa contiene. Gli agenti la usano come contesto."
          placeholderTextColor={t.textMuted}
          multiline
          selectionColor={t.accentText}
          style={[styles.field, { backgroundColor: t.cell, color: t.text, minHeight: 74, fontSize: 15, textAlignVertical: 'top' }]}
        />

        <Section header="File iniziali" inset={13}>
          <Cell title="index.md" mono subtitle="Sempre creato · generato" right={<Icon name="lock" size={14} color={t.textMuted} />} />
          <Cell
            title="checklist.md"
            mono
            right={
              <Switch
                value={withChecklist}
                onValueChange={setWithChecklist}
                trackColor={{ true: brand.purple, false: undefined }}
                thumbColor="#fff"
                ios_backgroundColor={t.fill}
              />
            }
          />
        </Section>
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  avatar: { width: 72, height: 72, borderRadius: 20, alignItems: 'center', justifyContent: 'center', borderCurve: 'continuous' },
  badge: {
    position: 'absolute',
    right: -4,
    bottom: -4,
    width: 26,
    height: 26,
    borderRadius: 13,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  field: { borderRadius: 12, paddingHorizontal: 13, paddingVertical: 11, fontSize: 16 },
});
