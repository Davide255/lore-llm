import React, { useState, useCallback } from 'react';
import {
  StyleSheet,
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  Alert,
  useColorScheme,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter, useFocusEffect } from 'expo-router';
import { ArrowLeft, Edit3, Trash2, Calendar, Bot, Folder } from 'lucide-react-native';

import { getDocumentById, deleteDocument } from '@/services/storage';
import { KnowledgeDocument } from '@/types/document';
import { MarkdownViewer } from '@/components/MarkdownViewer';
import { Colors, Fonts, Spacing } from '@/constants/theme';

export default function DocumentDetailScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const scheme = useColorScheme();
  const colors = Colors[scheme === 'dark' ? 'dark' : 'light'];

  const [document, setDocument] = useState<KnowledgeDocument | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchDoc = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    const doc = await getDocumentById(id);
    setDocument(doc);
    setLoading(false);
  }, [id]);

  useFocusEffect(
    useCallback(() => {
      fetchDoc();
    }, [fetchDoc])
  );

  const handleDelete = () => {
    if (!document) return;
    Alert.alert(
      'Delete Document',
      `Are you sure you want to delete "${document.title}"?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            await deleteDocument(document.id);
            router.back();
          },
        },
      ]
    );
  };

  if (loading) {
    return (
      <SafeAreaView style={[styles.container, styles.centered, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.primary} />
      </SafeAreaView>
    );
  }

  if (!document) {
    return (
      <SafeAreaView style={[styles.container, styles.centered, { backgroundColor: colors.background }]}>
        <Text style={[styles.notFoundText, { color: colors.text }]}>Document not found</Text>
        <TouchableOpacity style={[styles.backButton, { backgroundColor: colors.primary }]} onPress={() => router.back()}>
          <Text style={styles.backButtonText}>Go Back</Text>
        </TouchableOpacity>
      </SafeAreaView>
    );
  }

  const formattedDate = new Date(document.updatedAt).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]} edges={['top']}>
      {/* Top Navbar */}
      <View style={[styles.navbar, { borderBottomColor: colors.border }]}>
        <TouchableOpacity
          style={styles.navAction}
          onPress={() => router.back()}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <ArrowLeft size={22} color={colors.text} />
        </TouchableOpacity>

        <View style={styles.navRightActions}>
          <TouchableOpacity
            style={[styles.actionIconBtn, { backgroundColor: colors.backgroundElement }]}
            onPress={() =>
              router.push({
                pathname: '/document/edit',
                params: { id: document.id },
              })
            }>
            <Edit3 size={18} color={colors.primary} />
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.actionIconBtn, { backgroundColor: colors.backgroundElement }]}
            onPress={handleDelete}>
            <Trash2 size={18} color="#EF4444" />
          </TouchableOpacity>
        </View>
      </View>

      <ScrollView contentContainerStyle={styles.scrollContent}>
        {/* Document Header Info */}
        <View style={styles.headerInfo}>
          <Text style={[styles.docTitle, { color: colors.text }]}>{document.title}</Text>

          <View style={styles.metadataRow}>
            <View style={[styles.badge, { backgroundColor: colors.backgroundElement }]}>
              <Folder size={12} color={colors.primary} style={{ marginRight: 4 }} />
              <Text style={[styles.badgeText, { color: colors.primary }]}>{document.category}</Text>
            </View>

            {document.targetAgents?.map(agent => (
              <View key={agent} style={[styles.badge, { backgroundColor: colors.primaryLight }]}>
                <Bot size={12} color={colors.primary} style={{ marginRight: 4 }} />
                <Text style={[styles.badgeText, { color: colors.primary }]}>{agent}</Text>
              </View>
            ))}

            <View style={styles.dateInfo}>
              <Calendar size={12} color={colors.textSecondary} style={{ marginRight: 4 }} />
              <Text style={[styles.dateText, { color: colors.textSecondary }]}>{formattedDate}</Text>
            </View>
          </View>

          {document.tags?.length > 0 && (
            <View style={styles.tagsRow}>
              {document.tags.map(tag => (
                <Text key={tag} style={[styles.tagText, { color: colors.accent }]}>
                  #{tag}
                </Text>
              ))}
            </View>
          )}
        </View>

        <View style={[styles.divider, { backgroundColor: colors.border }]} />

        {/* Markdown Renderer */}
        <View style={styles.markdownContainer}>
          <MarkdownViewer content={document.content} />
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  centered: {
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  navbar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.four,
    paddingVertical: 12,
    borderBottomWidth: 1,
  },
  navAction: {
    padding: 4,
  },
  navRightActions: {
    flexDirection: 'row',
    gap: 12,
  },
  actionIconBtn: {
    padding: 8,
    borderRadius: 8,
  },
  scrollContent: {
    paddingHorizontal: Spacing.four,
    paddingVertical: Spacing.three,
    paddingBottom: 60,
  },
  headerInfo: {
    marginBottom: 16,
  },
  docTitle: {
    fontSize: 26,
    fontWeight: '700',
    fontFamily: Fonts?.sans ?? 'normal',
    marginBottom: 12,
  },
  metadataRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 8,
    marginBottom: 10,
  },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
  },
  badgeText: {
    fontSize: 12,
    fontWeight: '600',
  },
  dateInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    marginLeft: 'auto',
  },
  dateText: {
    fontSize: 12,
  },
  tagsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  tagText: {
    fontSize: 13,
    fontWeight: '500',
  },
  divider: {
    height: 1,
    marginBottom: 18,
  },
  markdownContainer: {
    paddingBottom: 20,
  },
  notFoundText: {
    fontSize: 18,
    fontWeight: '600',
    marginBottom: 16,
  },
  backButton: {
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 20,
  },
  backButtonText: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '600',
  },
});
