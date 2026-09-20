import AsyncStorage from '@react-native-async-storage/async-storage';
import { KnowledgeDocument, NewKnowledgeDocument } from '../types/document';

const STORAGE_KEY = '@lore_documents_v1';

const SEED_DOCUMENTS: KnowledgeDocument[] = [
  {
    id: 'doc-seed-1',
    title: 'Agent Operating Guidelines',
    category: 'System Guidelines',
    tags: ['guidelines', 'agents', 'core-principles'],
    targetAgents: ['All Agents'],
    content: `# Core Agent Operating Guidelines

Welcome to the shared knowledge base. All AI agents operate under these core directives.

## 1. Safety & Determinism
- Always verify inputs and validate JSON schema before executing actions.
- Never execute destructive commands without user confirmation.

\`\`\`typescript
interface ActionPayload {
  action: 'read' | 'write' | 'execute';
  target: string;
  confirmed: boolean;
}
\`\`\`

## 2. Communication Protocol
> "Be concise, objective, and reference canonical documents by ID."

- Provide source attribution when quoting knowledge.
- Keep agent memory synchronized after each conversation turn.

### Agent Handoff Checklist
1. Export active context variables.
2. Store key decisions in lore memory.
3. Clean up temporary scratchpads.`,
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 3).toISOString(),
    updatedAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 1).toISOString(),
  },
  {
    id: 'doc-seed-2',
    title: 'The Obsidian Citadel: World Lore',
    category: 'World Lore',
    tags: ['lore', 'world-building', 'factions'],
    targetAgents: ['Writer', 'Planner'],
    content: `# The Obsidian Citadel

The **Obsidian Citadel** serves as the central anchor point for all generative lore in our universe.

---

### Geographic Overview
Constructed in the First Era atop the *Crystalline Fault*, the fortress is powered by ambient geothermal ley lines.

### Key Factions
* **The Archivists**: Keepers of lost technologies and forgotten speech.
* **The Synchronizers**: Technomancers who bridge AI intelligences with biological senses.
* **The Void Walkers**: Explorers charting undiscovered quantum dimensions.

> *Quote from the Codex:* "Those who forget the foundations shall stumble when the spires fall."

### Artifact Matrix
| Artifact | Tier | Resonance |
| :--- | :--- | :--- |
| Chrono-Prism | Mythic | Temporal Distortion |
| Echo Core | Rare | Cognitive Recall |
| Etheric Needle | Legendary | Reality Weaving |`,
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 5).toISOString(),
    updatedAt: new Date(Date.now() - 1000 * 60 * 60 * 12).toISOString(),
  },
  {
    id: 'doc-seed-3',
    title: 'Agent Long-Term Memory Architecture',
    category: 'Agent Memory',
    tags: ['memory', 'architecture', 'context'],
    targetAgents: ['Coder', 'Researcher'],
    content: `# Agent Long-Term Memory Architecture

This document describes how shared knowledge is ingested and retrieved by agent instances.

## Memory Tiers
1. **Episodic Memory**: Transient dialogue tokens held in immediate context.
2. **Semantic Memory**: Embeddings and indexed documents stored in this knowledge base.
3. **Procedural Memory**: Hardcoded tool calling contracts and execution plans.

## Code Example: Context Retrieval

\`\`\`javascript
async function injectAgentContext(query, topK = 3) {
  const docs = await loreStorage.getDocuments();
  const relevant = docs.filter(d => 
    d.tags.some(tag => query.toLowerCase().includes(tag))
  );
  return relevant.slice(0, topK);
}
\`\`\`

All agents must check this knowledge base before replying with domain assumptions.`,
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 7).toISOString(),
    updatedAt: new Date(Date.now() - 1000 * 60 * 60 * 48).toISOString(),
  },
];

export async function getDocuments(): Promise<KnowledgeDocument[]> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) {
      // First run: seed initial knowledge
      await seedInitialKnowledge();
      return SEED_DOCUMENTS;
    }
    const parsed: KnowledgeDocument[] = JSON.parse(raw);
    return parsed.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  } catch (error) {
    console.error('Failed to get documents:', error);
    return [];
  }
}

export async function getDocumentById(id: string): Promise<KnowledgeDocument | null> {
  const docs = await getDocuments();
  return docs.find(doc => doc.id === id) ?? null;
}

export async function saveDocument(document: KnowledgeDocument): Promise<KnowledgeDocument> {
  const docs = await getDocuments();
  const index = docs.findIndex(d => d.id === document.id);
  const updatedDoc: KnowledgeDocument = {
    ...document,
    updatedAt: new Date().toISOString(),
  };

  let newDocs: KnowledgeDocument[];
  if (index >= 0) {
    newDocs = [...docs];
    newDocs[index] = updatedDoc;
  } else {
    newDocs = [updatedDoc, ...docs];
  }

  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(newDocs));
  return updatedDoc;
}

export async function createDocument(doc: NewKnowledgeDocument): Promise<KnowledgeDocument> {
  const now = new Date().toISOString();
  const newDoc: KnowledgeDocument = {
    ...doc,
    id: `doc-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
    createdAt: now,
    updatedAt: now,
  };
  const docs = await getDocuments();
  const updated = [newDoc, ...docs];
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
  return newDoc;
}

export async function deleteDocument(id: string): Promise<void> {
  const docs = await getDocuments();
  const filtered = docs.filter(d => d.id !== id);
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(filtered));
}

export async function seedInitialKnowledge(force: boolean = false): Promise<KnowledgeDocument[]> {
  if (force) {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(SEED_DOCUMENTS));
    return SEED_DOCUMENTS;
  }
  const existing = await AsyncStorage.getItem(STORAGE_KEY);
  if (!existing) {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(SEED_DOCUMENTS));
    return SEED_DOCUMENTS;
  }
  return JSON.parse(existing);
}

export async function exportKnowledgeBase(): Promise<string> {
  const docs = await getDocuments();
  return JSON.stringify(
    {
      exportedAt: new Date().toISOString(),
      version: '1.0',
      documentsCount: docs.length,
      documents: docs,
    },
    null,
    2
  );
}

export async function importKnowledgeBase(jsonString: string): Promise<KnowledgeDocument[]> {
  try {
    const data = JSON.parse(jsonString);
    const docs = Array.isArray(data) ? data : data.documents;
    if (!Array.isArray(docs)) {
      throw new Error('Invalid knowledge base format');
    }
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(docs));
    return docs;
  } catch {
    throw new Error('Could not parse knowledge base JSON');
  }
}
