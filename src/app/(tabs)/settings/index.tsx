import { SegmentedControl } from '@expo/ui/community/segmented-control';
import { router, Stack } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Alert, Switch } from 'react-native';

import { resetDemoData } from '@/api';
import { AgentAvatar, Cell, IconWell, Screen, Section, SectionHeader } from '@/components/ui';
import { actions, attempt, useAgents, useSettings, useSummary } from '@/data/hooks';
import { fileSize, relativeTime } from '@/lib/format';
import { routes } from '@/lib/routes';
import { brand, useTheme } from '@/theme';
import { setAppearance, useAppearance, type AppearancePreference } from '@/theme/appearance';

const appearanceOptions: { value: AppearancePreference; label: string }[] = [
  { value: 'system', label: 'Sistema' },
  { value: 'light', label: 'Chiaro' },
  { value: 'dark', label: 'Scuro' },
];

/** F3 — Settings. Per-agent permissions are the only place that decides who writes. */
export default function SettingsScreen() {
  const t = useTheme();
  const settings = useSettings();
  const summary = useSummary();
  const agents = useAgents();
  const [syncing, setSyncing] = useState(false);
  const appearance = useAppearance();
  const s = settings.data;

  const toggle = (value: boolean, onValueChange: (v: boolean) => void) => (
    <Switch value={value} onValueChange={onValueChange} trackColor={{ true: brand.purple, false: undefined }} thumbColor="#fff" ios_backgroundColor={t.fill} />
  );

  const sync = async () => {
    setSyncing(true);
    await attempt(() => actions.sync(), 'Sincronizzazione non riuscita');
    setSyncing(false);
  };

  return (
    <>
      <Stack.Screen options={{ title: 'Impostazioni' }} />
      <Screen>
        <Section header="Base di conoscenza">
          <Cell
            icon={<IconWell name={syncing ? 'sync' : 'cloudDone'} />}
            title="Sincronizzazione"
            subtitle={
              syncing
                ? 'Sincronizzazione in corso…'
                : `${relativeTime(s?.lastSyncAt)}${summary.data ? ` · ${summary.data.fileCount} file, ${fileSize(summary.data.totalBytes)}` : ''}`
            }
            right={syncing ? <ActivityIndicator color={t.textMuted} /> : undefined}
            chevron={!syncing}
            onPress={syncing ? undefined : sync}
          />
          <Cell
            icon={<IconWell name="offline" />}
            title="Disponibile offline"
            right={toggle(!!s?.offlineAvailable, (v) => actions.updateSettings({ offlineAvailable: v }))}
          />
        </Section>

        <Section header="Agenti" footer="Solo gli agenti con accesso in scrittura possono modificare i file.">
          {(agents.data ?? []).map((a) => (
            <Cell
              key={a.id}
              icon={<AgentAvatar agent={a} />}
              title={a.name}
              subtitle={a.permission === 'read-write' ? 'Lettura e scrittura' : 'Sola lettura'}
              chevron
              onPress={() => router.push(routes.agent(a.id))}
            />
          ))}
          <Cell
            icon={<IconWell name="add" background="transparent" />}
            title="Collega un agente"
            titleColor={t.accentText}
            onPress={() => router.push(routes.connectAgent())}
          />
        </Section>

        <SectionHeader>Aspetto</SectionHeader>
        <SegmentedControl
          values={appearanceOptions.map((o) => o.label)}
          selectedIndex={appearanceOptions.findIndex((o) => o.value === appearance)}
          onValueChange={(label) => setAppearance(appearanceOptions.find((o) => o.label === label)!.value)}
          appearance={t.scheme}
          tintColor={t.accent}
        />

        <Section header="Indice" footer="index.md viene ricompilato in background dopo ogni modifica al progetto.">
          <Cell
            icon={<IconWell name="index" />}
            title="Rigenera dopo ogni modifica"
            right={toggle(!!s?.regenerateIndexOnChange, (v) => actions.updateSettings({ regenerateIndexOnChange: v }))}
          />
        </Section>

        {resetDemoData && (
          <Section header="Sviluppo" footer="Il backend non è ancora collegato: i dati sono simulati sul dispositivo.">
            <Cell
              icon={<IconWell name="restore" />}
              title="Ripristina dati demo"
              titleColor={t.error}
              onPress={() =>
                Alert.alert('Ripristinare i dati demo?', 'Tutte le modifiche locali verranno perse.', [
                  { text: 'Annulla', style: 'cancel' },
                  { text: 'Ripristina', style: 'destructive', onPress: () => resetDemoData?.() },
                ])
              }
            />
          </Section>
        )}
      </Screen>
    </>
  );
}
