import React, { useState, useCallback, useMemo } from 'react';
import {
  StyleSheet,
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  useColorScheme,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useFocusEffect } from 'expo-router';
import { Folder, Tag, Layers } from 'lucide-react-native';

import { getDocuments } from '@/services/storage';
import { KnowledgeDocument } from '@/types/document';
import { Colors, Fonts, Spacing } from '@/constants/theme';
import { DocumentCard } from '@/components/DocumentCard';

export default function CategoriesScreen() {
  const router = useRouter();
  const scheme = useColorScheme();
  const colors = Colors[scheme === 'dark' ? 'dark' : 'light'];

  const [documents, setDocuments] = useState<KnowledgeDocument[]>([]);
  const [activeFilter, setActiveFilter] = useState<{ type: 'category' | 'tag'; value: string } | null>(
    null
  );

  const loadDocs = useCallback(async () => {
    const docs = await getDocuments();
    setDocuments(docs);
  }, []);

  useFocusEffect(
    useCallback(() => {
      loadDocs();
    }, [loadDocs])
  );

  // Group by category
  const categoryCounts = useMemo(() => {
    const map = new Map<string, number>();
    documents.forEach(d => {
      const cat = d.category || 'Uncategorized';
      map.set(cat, (map.get(cat) ?? 0) + 1);
    });
    return Array.from(map.entries()).map(([category, count]) => ({ category, count }));
  }, [documents]);

  // Group by tag
  const tagCounts = useMemo(() => {
    const map = new Map<string, number>();
    documents.forEach(d => {
      (d.tags || []).forEach(t => {
        map.set(t, (map.get(t) ?? 0) + 1);
      });
    });
    return Array.from(map.entries()).map(([tag, count]) => ({ tag, count }));
  }, [documents]);

  const filteredDocuments = useMemo(() => {
    if (!activeFilter) return [];
    if (activeFilter.type === 'category') {
      return documents.filter(d => d.category === activeFilter.value);
    }
    return documents.filter(d => (d.tags || []).includes(activeFilter.value));
  }, [documents, activeFilter]);

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]} edges={['top']}>
      <View style={styles.header}>
        <Text style={[styles.title, { color: colors.text }]}>Explorer</Text>
        <Text style={[styles.subtitle, { color: colors.textSecondary }]}>
          Browse knowledge by categories and tags
        </Text>
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        {/* Categories Section */}
        <View style={styles.sectionHeader}>
          <Folder size={18} color={colors.primary} style={{ marginRight: 6 }} />
          <Text style={[styles.sectionTitle, { color: colors.text }]}>Categories</Text>
        </View>

        <View style={styles.grid}>
          {categoryCounts.map(({ category, count }) => {
            const isSelected =
              activeFilter?.type === 'category' && activeFilter.value === category;
            return (
              <TouchableOpacity
                key={category}
                style={[
                  styles.categoryCard,
                  {
                    backgroundColor: isSelected ? colors.primaryLight : colors.card,
                    borderColor: isSelected ? colors.primary : colors.border,
                  },
                ]}
                onPress={() =>
                  setActiveFilter(prev =>
                    prev?.type === 'category' && prev.value === category
                      ? null
                      : { type: 'category', value: category }
                  )
                }>
                <View style={styles.categoryCardHeader}>
                  <Folder size={16} color={colors.primary} />
                  <View style={[styles.countBadge, { backgroundColor: colors.backgroundElement }]}>
                    <Text style={[styles.countText, { color: colors.primary }]}>{count}</Text>
                  </View>
                </View>
                <Text style={[styles.categoryName, { color: colors.text }]} numberOfLines={1}>
                  {category}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {/* Tags Section */}
        <View style={[styles.sectionHeader, { marginTop: 24 }]}>
          <Tag size={18} color={colors.accent} style={{ marginRight: 6 }} />
          <Text style={[styles.sectionTitle, { color: colors.text }]}>Knowledge Tags</Text>
        </View>

        <View style={styles.tagsContainer}>
          {tagCounts.map(({ tag, count }) => {
            const isSelected = activeFilter?.type === 'tag' && activeFilter.value === tag;
            return (
              <TouchableOpacity
                key={tag}
                style={[
                  styles.tagChip,
                  {
                    backgroundColor: isSelected ? colors.primary : colors.backgroundElement,
                    borderColor: isSelected ? colors.primary : colors.border,
                  },
                ]}
                onPress={() =>
                  setActiveFilter(prev =>
                    prev?.type === 'tag' && prev.value === tag ? null : { type: 'tag', value: tag }
                  )
                }>
                <Text
                  style={[
                    styles.tagText,
                    { color: isSelected ? '#ffffff' : colors.textSecondary },
                  ]}>
                  #{tag} ({count})
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {/* Filtered Results if selected */}
        {activeFilter && (
          <View style={styles.resultsSection}>
            <View style={styles.resultsHeader}>
              <Layers size={18} color={colors.primary} style={{ marginRight: 6 }} />
              <Text style={[styles.sectionTitle, { color: colors.text }]}>
                {activeFilter.type === 'category' ? 'Category:' : 'Tag:'}{' '}
                <Text style={{ color: colors.primary }}>{activeFilter.value}</Text>
              </Text>
            </View>

            {filteredDocuments.map(doc => (
              <DocumentCard
                key={doc.id}
                document={doc}
                onPress={() =>
                  router.push({
                    pathname: '/document/[id]',
                    params: { id: doc.id },
                  })
                }
              />
            ))}
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    paddingHorizontal: Spacing.four,
    paddingTop: Spacing.two,
    paddingBottom: Spacing.two,
  },
  title: {
    fontSize: 24,
    fontWeight: '700',
    fontFamily: Fonts?.sans ?? 'normal',
  },
  subtitle: {
    fontSize: 13,
    marginTop: 2,
  },
  content: {
    paddingHorizontal: Spacing.four,
    paddingBottom: 40,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '600',
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  categoryCard: {
    width: '48%',
    padding: 12,
    borderRadius: 10,
    borderWidth: 1,
  },
  categoryCardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  categoryName: {
    fontSize: 14,
    fontWeight: '600',
  },
  countBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 10,
  },
  countText: {
    fontSize: 11,
    fontWeight: '700',
  },
  tagsContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  tagChip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 14,
    borderWidth: 1,
  },
  tagText: {
    fontSize: 12,
    fontWeight: '500',
  },
  resultsSection: {
    marginTop: 28,
  },
  resultsHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
  },
});
