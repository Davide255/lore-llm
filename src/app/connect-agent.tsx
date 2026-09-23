import * as Clipboard from 'expo-clipboard';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';

import type { ConnectionInfo } from '@/api';
import { HeaderItems } from '@/components/header-items';
import { Icon } from '@/components/icon';
import { Banner, Cell, Loading, Section } from '@/components/ui';
import { actions, attempt } from '@/data/hooks';
import { fonts, useTheme } from '@/theme';

/** Issue MCP credentials an agent can use to read/write the base. */
export default function ConnectAgentScreen() {
  const t = useTheme();
  const [info, setInfo] = useState<ConnectionInfo | null>(null);
  // Inline feedback: the global toast would render underneath this modal.
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    attempt(() => actions.createConnection()).then((i) => i && setInfo(i));
  }, []);

  const copy = async (label: string, value: string) => {
    await Clipboard.setStringAsync(value);
    setCopied(label);
    setTimeout(() => setCopied((c) => (c === label ? null : c)), 1500);
  };

  return (
    <>
      <HeaderItems right={[{ kind: 'button', label: 'Fine', variant: 'done', onPress: () => router.back() }]} />
      {!info ? (
        <Loading />
      ) : (
        <ScrollView style={{ flex: 1, backgroundColor: t.background }} contentContainerStyle={{ padding: 16 }} contentInsetAdjustmentBehavior="automatic">
          <Text style={{ color: t.textSecondary, fontSize: 14, lineHeight: 20, marginHorizontal: 6, marginTop: 4 }}>
            Aggiungi questo server MCP nelle impostazioni del tuo agente (Claude, Codex, …). Potrà leggere la base; la scrittura si abilita dopo, dai suoi permessi.
          </Text>
          <Section header="Server MCP" inset={13}>
            {[
              { label: 'Endpoint', value: info.endpoint },
              { label: 'Token', value: info.token },
            ].map((row) => (
              <Cell
                key={row.label}
                title={row.label}
                subtitle={<Text style={{ fontFamily: fonts.mono }}>{row.value}</Text>}
                right={<Icon name={copied === row.label ? 'check' : 'copy'} size={17} color={t.accentText} />}
                onPress={() => copy(row.label, row.value)}
              />
            ))}
          </Section>
          <View style={{ marginTop: 18 }}>
            <Banner icon="lock">Il token è mostrato una sola volta. Trattalo come una password.</Banner>
          </View>
        </ScrollView>
      )}
    </>
  );
}
