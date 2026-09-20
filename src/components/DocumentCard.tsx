import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View, useColorScheme } from 'react-native';
import { ChevronRight, FileText, Bot } from 'lucide-react-native';
import { KnowledgeDocument } from '@/types/document';
import { Colors, Fonts, Spacing } from '@/constants/theme';

interface DocumentCardProps {
  document: KnowledgeDocument;
  onPress: () => void;
}

export function DocumentCard({ document, onPress }: DocumentCardProps) {
  const scheme = useColorScheme();
  const colors = Colors[scheme === 'dark' ? 'dark' : 'light'];

  // Strip markdown symbols for clean snippet
  const snippet = document.content
    .replace(/^#+\s+/gm, '')
    .replace(/\*|_|`|\[|\]/g, '')
    .trim()
    .slice(0, 110);

  const formattedDate = new Date(document.updatedAt).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });

  return (
    <TouchableOpacity
      style={[
        styles.card,
        {
          backgroundColor: colors.card,
          borderColor: colors.border,
        },
      ]}
      onPress={onPress}
      activeOpacity={0.7}>
      <View style={styles.headerRow}>
        <View style={styles.titleContainer}>
          <FileText size={18} color={colors.primary} style={styles.icon} />
          <Text style={[styles.title, { color: colors.text }]} numberOfLines={1}>
            {document.title}
          </Text>
        </View>
        <ChevronRight size={18} color={colors.textSecondary} />
      </View>

      <Text style={[styles.snippet, { color: colors.textSecondary }]} numberOfLines={2}>
        {snippet || 'Empty document'}
      </Text>

      <View style={styles.footerRow}>
        <View style={styles.tagsRow}>
          <View style={[styles.categoryBadge, { backgroundColor: colors.backgroundElement }]}>
            <Text style={[styles.categoryText, { color: colors.primary }]}>
              {document.category}
            </Text>
          </View>

          {document.targetAgents?.length > 0 && (
            <View style={[styles.agentBadge, { backgroundColor: colors.primaryLight }]}>
              <Bot size={12} color={colors.primary} style={{ marginRight: 4 }} />
              <Text style={[styles.agentText, { color: colors.primary }]}>
                {document.targetAgents[0]}
                {document.targetAgents.length > 1 ? ` +${document.targetAgents.length - 1}` : ''}
              </Text>
            </View>
          )}
        </View>

        <Text style={[styles.dateText, { color: colors.textSecondary }]}>
          {formattedDate}
        </Text>
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  card: {
    padding: Spacing.three,
    borderRadius: 12,
    borderWidth: 1,
    marginBottom: Spacing.two,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  titleContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    marginRight: 8,
  },
  icon: {
    marginRight: 8,
  },
  title: {
    fontSize: 16,
    fontWeight: '600',
    fontFamily: Fonts?.sans ?? 'normal',
    flex: 1,
  },
  snippet: {
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 10,
  },
  footerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  tagsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 6,
    flex: 1,
  },
  categoryBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  categoryText: {
    fontSize: 11,
    fontWeight: '500',
  },
  agentBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  agentText: {
    fontSize: 11,
    fontWeight: '500',
  },
  dateText: {
    fontSize: 12,
    marginLeft: 8,
  },
});
