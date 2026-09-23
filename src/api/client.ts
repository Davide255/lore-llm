import type {
  Agent,
  AgentPermission,
  ActivityEvent,
  Change,
  ConnectionInfo,
  CreateFileInput,
  CreateProjectInput,
  DeleteReceipt,
  FileDocument,
  FolderListing,
  KBSettings,
  KBSummary,
  Project,
  RecentFile,
  SearchResponse,
} from './types';

/**
 * Everything the app needs from the backend. The UI only talks to this
 * interface (through `src/data/hooks.ts`), so swapping the mock for the real
 * HTTP client is a one-line change in `src/api/index.ts`.
 */
export interface KnowledgeBaseClient {
  // Browse
  getSummary(): Promise<KBSummary>;
  listProjects(): Promise<Project[]>;
  getProject(name: string): Promise<Project>;
  listFolder(path: string): Promise<FolderListing>;
  /** Every folder of a project (for "Move to…" and location pickers). */
  listFolderTree(project: string): Promise<string[]>;
  getFile(path: string): Promise<FileDocument>;
  listRecentFiles(limit?: number): Promise<RecentFile[]>;
  markOpened(path: string): Promise<void>;

  // Write
  /** Fails with `conflict` if `baseVersion` is stale, `read_only` for index.md. */
  writeFile(path: string, content: string, baseVersion?: string): Promise<FileDocument>;
  createFile(input: CreateFileInput): Promise<FileDocument>;
  createFolder(parent: string, name: string): Promise<string>;
  createProject(input: CreateProjectInput): Promise<Project>;
  updateProject(name: string, patch: Partial<Pick<Project, 'description' | 'icon'>>): Promise<Project>;
  rename(path: string, newName: string): Promise<string>;
  move(path: string, targetFolder: string): Promise<string>;
  duplicate(path: string): Promise<string>;
  remove(path: string): Promise<DeleteReceipt>;
  undoRemove(token: string): Promise<void>;

  // Search
  search(query: string, project?: string | null): Promise<SearchResponse>;
  listRecentSearches(): Promise<string[]>;
  addRecentSearch(query: string): Promise<void>;
  removeRecentSearch(query: string): Promise<void>;

  // Agents
  listAgents(): Promise<Agent[]>;
  getAgent(id: string): Promise<Agent>;
  setAgentPermission(id: string, permission: AgentPermission): Promise<Agent>;
  disconnectAgent(id: string): Promise<void>;
  createConnection(): Promise<ConnectionInfo>;
  listActivity(): Promise<ActivityEvent[]>;
  getChange(id: string): Promise<Change>;
  /** Restores the file to `change.before` and pauses index regeneration for 1h. */
  revertChange(id: string): Promise<void>;

  // Settings
  getSettings(): Promise<KBSettings>;
  updateSettings(patch: Partial<KBSettings>): Promise<KBSettings>;
  sync(): Promise<KBSettings>;

  /**
   * Server-pushed changes (e.g. index.md recompiled, an agent wrote a file).
   * The HTTP client will back this with SSE; the mock fires it after its
   * simulated background jobs. Returns an unsubscribe function.
   */
  subscribe(listener: (event: ServerEvent) => void): () => void;
}

export type ServerEvent =
  | { type: 'index-regenerating'; project: string }
  | { type: 'index-regenerated'; project: string }
  | { type: 'changed'; paths: string[] };
