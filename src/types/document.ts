export interface KnowledgeDocument {
  id: string;
  title: string;
  content: string;
  category: string;
  tags: string[];
  targetAgents: string[];
  createdAt: string;
  updatedAt: string;
}

export type NewKnowledgeDocument = Omit<KnowledgeDocument, 'id' | 'createdAt' | 'updatedAt'>;

export const DEFAULT_CATEGORIES = [
  'System Guidelines',
  'World Lore',
  'Tool Definitions',
  'Agent Memory',
  'Rules & Constraints',
] as const;

export const DEFAULT_AGENTS = [
  'All Agents',
  'Coder',
  'Researcher',
  'Planner',
  'Writer',
] as const;
