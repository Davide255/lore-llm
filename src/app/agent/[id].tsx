import { SegmentedControl } from '@expo/ui/community/segmented-control';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { Alert, View } from 'react-native';

import { AgentAvatar, Cell, ErrorState, Loading, Screen, Section, SectionHeader } from '@/components/ui';
import { actions, attempt, useActivity, useAgent } from '@/data/hooks';
import { relativeTime } from '@/lib/format';
import { basename } from '@/lib/paths';
import { routes } from '@/lib/routes';
import { useTheme } from '@/theme';

/** Agent detail: permission, recent activity, disconnect. */
export default function AgentScreen() {
  const t = useTheme();
  const { id } = useLocalSearchParams<{ id: string }>();
  const agent = useAgent(id);
  const activity = useActivity();
  const a = agent.data;
  const events = (activity.data ?? []).filter((e) => e.agentId === id).slice(0, 5);

  const disconnect = () =>
    Alert.alert(`Scollegare ${a?.name}?`, 'L’agente perderà subito l’accesso alla base di conoscenza.', [
      { text: 'Annulla', style: 'cancel' },
      {
        text: 'Scollega',
        style: 'destructive',
        onPress: async () => {
          const ok = await attempt(() => actions.disconnectAgent(id).then(() => true));
          if (ok) router.back();
        },
      },
    ]);

  return (
    <>
      <Stack.Screen options={{ title: a?.name ?? '' }} />
      {agent.loading ? (
        <Loading />
      ) : agent.error || !a ? (
        <ErrorState error={agent.error} onRetry={agent.refresh} />
      ) : (
        <Screen contentContainerStyle={{ paddingTop: 8 }}>
          <Section>
            <Cell
              icon={<AgentAvatar agent={a} />}
              title={a.name}
              strong
              subtitle={a.lastSeenAt ? `Ultimo accesso ${relativeTime(a.lastSeenAt)}` : 'Mai collegato'}
            />
          </Section>

          <SectionHeader>Permessi</SectionHeader>
          <View>
            <SegmentedControl
              values={['Sola lettura', 'Lettura e scrittura']}
              selectedIndex={a.permission === 'read' ? 0 : 1}
              onValueChange={(v) => attempt(() => actions.setAgentPermission(id, v === 'Sola lettura' ? 'read' : 'read-write'))}
              appearance={t.scheme}
              tintColor={t.accent}
            />
          </View>

          <Section header="Attività recente">
            {events.map((e) => (
              <Cell
                key={e.id}
                title={e.path ? basename(e.path) : e.project}
                mono={!!e.path}
                subtitle={`${e.kind === 'read' ? 'Lettura' : 'Scrittura'} · ${relativeTime(e.at)}`}
                chevron={!!e.changeId}
                onPress={e.changeId ? () => router.push(routes.change(e.changeId!)) : undefined}
              />
            ))}
          </Section>

          <Section style={{ marginTop: 24 }} inset={13}>
            <Cell title="Scollega agente" titleColor={t.error} onPress={disconnect} />
          </Section>
        </Screen>
      )}
    </>
  );
}
