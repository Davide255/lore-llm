import React, { useState, useEffect } from 'react';
import {
  StyleSheet,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  Alert,
  KeyboardAvoidingView,
  Platform,
  useColorScheme,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ArrowLeft, Check, Eye, Edit3, Bot } from 'lucide-react-native';

import { getDocumentById, saveDocument, createDocument } from '@/services/storage';
import {
  KnowledgeDocument,
  DEFAULT_CATEGORIES,
  DEFAULT_AGENTS,
} from '@/types/document';
import { MarkdownViewer } from '@/components/MarkdownViewer';
import { Colors, Fonts, Spacing } from '@/constants/theme';

export default function DocumentEditScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id?: string }>();
  const scheme = useColorScheme();
  const colors = Colors[scheme === 'dark' ? 'dark' : 'light'];

  const isEditing = Boolean(id);

  const [title, setTitle] = useState('');
  const [category, setCategory] = useState<string>(DEFAULT_CATEGORIES[0]);
  const [customCategory, setCustomCategory] = useState('');
  const [selectedAgents, setSelectedAgents] = useState<string[]>(['All Agents']);
  const [tagsInput, setTagsInput] = useState('');
  const [content, setContent] = useState('');
  const [activeTab, setActiveTab] = useState<'edit' | 'preview'>('edit');
  const [existingDoc, setExistingDoc] = useState<KnowledgeDocument | null>(null);

  useEffect(() => {
    if (id) {
      getDocumentById(id).then(doc => {
        if (doc) {
          setExistingDoc(doc);
          setTitle(doc.title);
          setCategory(doc.category);
          setSelectedAgents(doc.targetAgents ?? ['All Agents']);
          setTagsInput((doc.tags ?? []).join(', '));
          setContent(doc.content);
        }
      });
    }
  }, [id]);

  const toggleAgent = (agent: string) => {
    setSelectedAgents(prev => {
      if (agent === 'All Agents') {
        return ['All Agents'];
      }
      const filtered = prev.filter(a => a !== 'All Agents');
      if (filtered.includes(agent)) {
        const next = filtered.filter(a => a !== agent);
        return next.length === 0 ? ['All Agents'] : next;
      } else {
        return [...filtered, agent];
      }
    });
  };

  const handleSave = async () => {
    const trimmedTitle = title.trim();
    const trimmedContent = content.trim();

    if (!trimmedTitle) {
      Alert.alert('Validation', 'Please enter a document title.');
      return;
    }
    if (!trimmedContent) {
      Alert.alert('Validation', 'Document content cannot be empty.');
      return;
    }

    const finalCategory = customCategory.trim() ? customCategory.trim() : category;
    const tags = tagsInput
      .split(',')
      .map(t => t.trim().toLowerCase().replace(/^#/, ''))
      .filter(Boolean);

    if (isEditing && existingDoc) {
      await saveDocument({
        ...existingDoc,
        title: trimmedTitle,
        category: finalCategory,
        content: trimmedContent,
        tags,
        targetAgents: selectedAgents,
      });
    } else {
      await createDocument({
        title: trimmedTitle,
        category: finalCategory,
        content: trimmedContent,
        tags,
        targetAgents: selectedAgents,
      });
    }

    router.back();
  };

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

        <Text style={[styles.navTitle, { color: colors.text }]}>
          {isEditing ? 'Edit Document' : 'New Document'}
        </Text>

        <TouchableOpacity
          style={[styles.saveButton, { backgroundColor: colors.primary }]}
          onPress={handleSave}
          activeOpacity={0.8}>
          <Check size={18} color="#ffffff" style={{ marginRight: 4 }} />
          <Text style={styles.saveButtonText}>Save</Text>
        </TouchableOpacity>
      </View>

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.scrollContent}>
          {/* Title Input */}
          <Text style={[styles.fieldLabel, { color: colors.textSecondary }]}>TITLE</Text>
          <TextInput
            style={[
              styles.titleInput,
              {
                backgroundColor: colors.card,
                borderColor: colors.border,
                color: colors.text,
              },
            ]}
            placeholder="e.g. Agent Memory Architecture"
            placeholderTextColor={colors.textSecondary}
            value={title}
            onChangeText={setTitle}
          />

          {/* Category Selection */}
          <Text style={[styles.fieldLabel, { color: colors.textSecondary }]}>CATEGORY</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipRow}>
            {DEFAULT_CATEGORIES.map(cat => {
              const isSelected = category === cat && !customCategory;
              return (
                <TouchableOpacity
                  key={cat}
                  style={[
                    styles.chip,
                    {
                      backgroundColor: isSelected ? colors.primary : colors.backgroundElement,
                      borderColor: isSelected ? colors.primary : colors.border,
                    },
                  ]}
                  onPress={() => {
                    setCategory(cat);
                    setCustomCategory('');
                  }}>
                  <Text style={[styles.chipText, { color: isSelected ? '#ffffff' : colors.textSecondary }]}>
                    {cat}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>

          {/* Target Agents */}
          <Text style={[styles.fieldLabel, { color: colors.textSecondary }]}>TARGET AGENTS</Text>
          <View style={styles.wrapChipRow}>
            {DEFAULT_AGENTS.map(agent => {
              const isSelected = selectedAgents.includes(agent);
              return (
                <TouchableOpacity
                  key={agent}
                  style={[
                    styles.chip,
                    {
                      backgroundColor: isSelected ? colors.primaryLight : colors.backgroundElement,
                      borderColor: isSelected ? colors.primary : colors.border,
                    },
                  ]}
                  onPress={() => toggleAgent(agent)}>
                  <Bot size={13} color={colors.primary} style={{ marginRight: 4 }} />
                  <Text style={[styles.chipText, { color: colors.primary }]}>{agent}</Text>
                </TouchableOpacity>
              );
            })}
          </View>

          {/* Tags Input */}
          <Text style={[styles.fieldLabel, { color: colors.textSecondary }]}>TAGS (comma-separated)</Text>
          <TextInput
            style={[
              styles.input,
              {
                backgroundColor: colors.card,
                borderColor: colors.border,
                color: colors.text,
              },
            ]}
            placeholder="lore, guidelines, rules"
            placeholderTextColor={colors.textSecondary}
            value={tagsInput}
            onChangeText={setTagsInput}
          />

          {/* Content Editor / Preview Switcher */}
          <View style={styles.contentHeader}>
            <Text style={[styles.fieldLabel, { color: colors.textSecondary, marginBottom: 0 }]}>
              CONTENT (MARKDOWN)
            </Text>

            <View style={[styles.tabToggle, { backgroundColor: colors.backgroundElement }]}>
              <TouchableOpacity
                style={[
                  styles.tabOption,
                  activeTab === 'edit' && { backgroundColor: colors.primary },
                ]}
                onPress={() => setActiveTab('edit')}>
                <Edit3 size={14} color={activeTab === 'edit' ? '#ffffff' : colors.textSecondary} />
                <Text
                  style={[
                    styles.tabOptionText,
                    { color: activeTab === 'edit' ? '#ffffff' : colors.textSecondary },
                  ]}>
                  Edit
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[
                  styles.tabOption,
                  activeTab === 'preview' && { backgroundColor: colors.primary },
                ]}
                onPress={() => setActiveTab('preview')}>
                <Eye size={14} color={activeTab === 'preview' ? '#ffffff' : colors.textSecondary} />
                <Text
                  style={[
                    styles.tabOptionText,
                    { color: activeTab === 'preview' ? '#ffffff' : colors.textSecondary },
                  ]}>
                  Preview
                </Text>
              </TouchableOpacity>
            </View>
          </View>

          {activeTab === 'edit' ? (
            <TextInput
              style={[
                styles.contentInput,
                {
                  backgroundColor: colors.card,
                  borderColor: colors.border,
                  color: colors.text,
                  fontFamily: Fonts?.mono ?? 'monospace',
                },
              ]}
              multiline
              textAlignVertical="top"
              placeholder="# Enter markdown document here...&#10;&#10;## Section&#10;- Points&#10;&#10;```typescript&#10;// code snippet&#10;```"
              placeholderTextColor={colors.textSecondary}
              value={content}
              onChangeText={setContent}
            />
          ) : (
            <View
              style={[
                styles.previewContainer,
                {
                  backgroundColor: colors.card,
                  borderColor: colors.border,
                },
              ]}>
              {content.trim() ? (
                <MarkdownViewer content={content} />
              ) : (
                <Text style={{ color: colors.textSecondary, fontStyle: 'italic', padding: 20 }}>
                  Nothing to preview. Switch to Edit to write markdown.
                </Text>
              )}
            </View>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
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
  navTitle: {
    fontSize: 17,
    fontWeight: '600',
  },
  saveButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 18,
  },
  saveButtonText: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '600',
  },
  scrollContent: {
    paddingHorizontal: Spacing.four,
    paddingVertical: Spacing.three,
    paddingBottom: 60,
  },
  fieldLabel: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.8,
    marginBottom: 6,
    marginTop: 12,
  },
  titleInput: {
    fontSize: 16,
    fontWeight: '600',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: 1,
  },
  input: {
    fontSize: 14,
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: 8,
    borderWidth: 1,
  },
  chipRow: {
    flexDirection: 'row',
    marginBottom: 4,
  },
  wrapChipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 4,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    borderWidth: 1,
    marginRight: 8,
    marginBottom: 6,
  },
  chipText: {
    fontSize: 12,
    fontWeight: '500',
  },
  contentHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 16,
    marginBottom: 8,
  },
  tabToggle: {
    flexDirection: 'row',
    borderRadius: 8,
    padding: 2,
  },
  tabOption: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 6,
    gap: 4,
  },
  tabOptionText: {
    fontSize: 12,
    fontWeight: '600',
  },
  contentInput: {
    minHeight: 280,
    fontSize: 14,
    lineHeight: 20,
    padding: 14,
    borderRadius: 8,
    borderWidth: 1,
  },
  previewContainer: {
    minHeight: 280,
    padding: 14,
    borderRadius: 8,
    borderWidth: 1,
  },
});
