import React, { useState, useCallback } from 'react';
import {
  StyleSheet,
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  Alert,
  TextInput,
  Modal,
  useColorScheme,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from 'expo-router';
import {
  Download,
  Upload,
  RotateCcw,
  X,
  Info,
} from 'lucide-react-native';

import {
  getDocuments,
  exportKnowledgeBase,
  importKnowledgeBase,
  seedInitialKnowledge,
} from '@/services/storage';
import { KnowledgeDocument } from '@/types/document';
import { Colors, Fonts, Spacing } from '@/constants/theme';

export default function SettingsScreen() {
  const scheme = useColorScheme();
  const colors = Colors[scheme === 'dark' ? 'dark' : 'light'];

  const [documents, setDocuments] = useState<KnowledgeDocument[]>([]);
  const [importModalVisible, setImportModalVisible] = useState(false);
  const [importText, setImportText] = useState('');
  const [exportModalVisible, setExportModalVisible] = useState(false);
  const [exportText, setExportText] = useState('');

  const loadData = useCallback(async () => {
    const docs = await getDocuments();
    setDocuments(docs);
  }, []);

  useFocusEffect(
    useCallback(() => {
      loadData();
    }, [loadData])
  );

  const totalWords = documents.reduce((acc, doc) => {
    const words = doc.content.trim().split(/\s+/).filter(Boolean).length;
    return acc + words;
  }, 0);

  const totalCategories = new Set(documents.map(d => d.category)).size;

  const handleExport = async () => {
    const json = await exportKnowledgeBase();
    setExportText(json);
    setExportModalVisible(true);
  };

  const handleImportSubmit = async () => {
    if (!importText.trim()) return;
    try {
      await importKnowledgeBase(importText.trim());
      await loadData();
      setImportModalVisible(false);
      setImportText('');
      Alert.alert('Success', 'Knowledge base successfully imported!');
    } catch {
      Alert.alert('Error', 'Failed to import JSON: Invalid format');
    }
  };

  const handleResetSeed = () => {
    Alert.alert(
      'Reset Sample Knowledge',
      'This will restore the standard AI agent guidelines, lore, and memory examples.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Reset',
          style: 'destructive',
          onPress: async () => {
            await seedInitialKnowledge(true);
            await loadData();
            Alert.alert('Reset Complete', 'Default agent knowledge documents have been restored.');
          },
        },
      ]
    );
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]} edges={['top']}>
      <View style={styles.header}>
        <Text style={[styles.title, { color: colors.text }]}>Settings & Data</Text>
        <Text style={[styles.subtitle, { color: colors.textSecondary }]}>
          Knowledge base stats, backup, and storage management
        </Text>
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        {/* Statistics Cards */}
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.text }]}>Overview</Text>
          <View style={styles.statsGrid}>
            <View style={[styles.statCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Text style={[styles.statValue, { color: colors.primary }]}>{documents.length}</Text>
              <Text style={[styles.statLabel, { color: colors.textSecondary }]}>Documents</Text>
            </View>
            <View style={[styles.statCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Text style={[styles.statValue, { color: colors.accent }]}>{totalCategories}</Text>
              <Text style={[styles.statLabel, { color: colors.textSecondary }]}>Categories</Text>
            </View>
            <View style={[styles.statCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Text style={[styles.statValue, { color: colors.text }]}>{totalWords.toLocaleString()}</Text>
              <Text style={[styles.statLabel, { color: colors.textSecondary }]}>Total Words</Text>
            </View>
          </View>
        </View>

        {/* Data Management Section */}
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.text }]}>Data Operations</Text>

          <TouchableOpacity
            style={[styles.rowButton, { backgroundColor: colors.card, borderColor: colors.border }]}
            onPress={handleExport}
            activeOpacity={0.7}>
            <View style={styles.rowIcon}>
              <Download size={20} color={colors.primary} />
            </View>
            <View style={styles.rowContent}>
              <Text style={[styles.rowTitle, { color: colors.text }]}>Export Knowledge Base</Text>
              <Text style={[styles.rowSubtitle, { color: colors.textSecondary }]}>
                Export all documents into JSON for agent sync or backups
              </Text>
            </View>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.rowButton, { backgroundColor: colors.card, borderColor: colors.border }]}
            onPress={() => setImportModalVisible(true)}
            activeOpacity={0.7}>
            <View style={styles.rowIcon}>
              <Upload size={20} color={colors.accent} />
            </View>
            <View style={styles.rowContent}>
              <Text style={[styles.rowTitle, { color: colors.text }]}>Import Knowledge Base</Text>
              <Text style={[styles.rowSubtitle, { color: colors.textSecondary }]}>
                Paste JSON documents to restore or merge knowledge
              </Text>
            </View>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.rowButton, { backgroundColor: colors.card, borderColor: colors.border }]}
            onPress={handleResetSeed}
            activeOpacity={0.7}>
            <View style={styles.rowIcon}>
              <RotateCcw size={20} color="#EF4444" />
            </View>
            <View style={styles.rowContent}>
              <Text style={[styles.rowTitle, { color: colors.text }]}>Reset Sample Knowledge</Text>
              <Text style={[styles.rowSubtitle, { color: colors.textSecondary }]}>
                Re-populate default agent guidelines and lore documents
              </Text>
            </View>
          </TouchableOpacity>
        </View>

        {/* About info */}
        <View style={[styles.infoBox, { backgroundColor: colors.backgroundElement, borderColor: colors.border }]}>
          <Info size={18} color={colors.primary} style={{ marginRight: 8, marginTop: 2 }} />
          <Text style={[styles.infoText, { color: colors.textSecondary }]}>
            Lore KB stores all documents locally via AsyncStorage. Knowledge can be accessed and consumed by AI agents via standard JSON sync.
          </Text>
        </View>
      </ScrollView>

      {/* Export Modal */}
      <Modal visible={exportModalVisible} animationType="slide" transparent>
        <View style={styles.modalOverlay}>
          <View style={[styles.modalContent, { backgroundColor: colors.background, borderColor: colors.border }]}>
            <View style={styles.modalHeader}>
              <Text style={[styles.modalTitle, { color: colors.text }]}>Export JSON</Text>
              <TouchableOpacity onPress={() => setExportModalVisible(false)}>
                <X size={22} color={colors.textSecondary} />
              </TouchableOpacity>
            </View>
            <TextInput
              style={[
                styles.modalTextInput,
                {
                  backgroundColor: colors.codeBg,
                  color: colors.text,
                  borderColor: colors.border,
                },
              ]}
              multiline
              editable={false}
              value={exportText}
              selectTextOnFocus
            />
            <TouchableOpacity
              style={[styles.primaryModalButton, { backgroundColor: colors.primary }]}
              onPress={() => setExportModalVisible(false)}>
              <Text style={styles.primaryModalButtonText}>Done</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Import Modal */}
      <Modal visible={importModalVisible} animationType="slide" transparent>
        <View style={styles.modalOverlay}>
          <View style={[styles.modalContent, { backgroundColor: colors.background, borderColor: colors.border }]}>
            <View style={styles.modalHeader}>
              <Text style={[styles.modalTitle, { color: colors.text }]}>Import JSON</Text>
              <TouchableOpacity onPress={() => setImportModalVisible(false)}>
                <X size={22} color={colors.textSecondary} />
              </TouchableOpacity>
            </View>
            <TextInput
              style={[
                styles.modalTextInput,
                {
                  backgroundColor: colors.codeBg,
                  color: colors.text,
                  borderColor: colors.border,
                },
              ]}
              multiline
              placeholder="Paste knowledge base JSON here..."
              placeholderTextColor={colors.textSecondary}
              value={importText}
              onChangeText={setImportText}
            />
            <TouchableOpacity
              style={[styles.primaryModalButton, { backgroundColor: colors.primary }]}
              onPress={handleImportSubmit}>
              <Text style={styles.primaryModalButtonText}>Import</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
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
  section: {
    marginTop: 20,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 12,
  },
  statsGrid: {
    flexDirection: 'row',
    gap: 10,
  },
  statCard: {
    flex: 1,
    padding: 14,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: 'center',
  },
  statValue: {
    fontSize: 22,
    fontWeight: '700',
    marginBottom: 4,
  },
  statLabel: {
    fontSize: 12,
  },
  rowButton: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 14,
    borderRadius: 12,
    borderWidth: 1,
    marginBottom: 10,
  },
  rowIcon: {
    marginRight: 14,
  },
  rowContent: {
    flex: 1,
  },
  rowTitle: {
    fontSize: 15,
    fontWeight: '600',
    marginBottom: 2,
  },
  rowSubtitle: {
    fontSize: 12,
    lineHeight: 16,
  },
  infoBox: {
    flexDirection: 'row',
    padding: 14,
    borderRadius: 12,
    borderWidth: 1,
    marginTop: 24,
  },
  infoText: {
    fontSize: 13,
    lineHeight: 18,
    flex: 1,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'flex-end',
  },
  modalContent: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderWidth: 1,
    padding: 20,
    maxHeight: '80%',
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 14,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '700',
  },
  modalTextInput: {
    height: 220,
    borderRadius: 10,
    borderWidth: 1,
    padding: 12,
    fontSize: 13,
    fontFamily: Fonts?.mono ?? 'monospace',
    textAlignVertical: 'top',
    marginBottom: 16,
  },
  primaryModalButton: {
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: 'center',
  },
  primaryModalButtonText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '600',
  },
});
