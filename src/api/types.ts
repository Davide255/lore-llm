/**
 * Domain types shared by the UI and every KnowledgeBaseClient implementation.
 *
 * The knowledge base is a tree of folders and markdown files:
 *
 *   <root>/
 *     <project>/            ← top-level folders are "projects"
 *       index.md            ← compiled by the backend, read-only for clients
 *       checklist.md        ← nested task list, editable
 *       <any>.md / <dir>/   ← free-form markdown files and folders
 *
 * Every entry is addressed by its path relative to the root, using "/" as
 * separator and without leading slash (e.g. "Athly Dashboard/decisioni/adr-001.md").
 */

export type ISODate = string;

/** Special role of a file inside a project. */
export type FileRole = 'index' | 'checklist' | 'doc';

export type ProjectIcon =
  | 'folder'
  | 'fitness'
  | 'web'
  | 'server'
  | 'campaign'
  | 'science'
  | 'book'
  | 'code'
  | 'design'
  | 'rocket';

export interface ChecklistProgress {
  done: number;
  total: number;
}

export interface Project {
  /** Also the project's root path. */
  name: string;
  description: string;
  icon: ProjectIcon;
  fileCount: number;
  updatedAt: ISODate;
  checklist: ChecklistProgress | null;
}

export interface FolderEntry {
  kind: 'folder';
  path: string;
  name: string;
  fileCount: number;
  folderCount: number;
  updatedAt: ISODate;
}

export interface FileEntry {
  kind: 'file';
  path: string;
  name: string;
  role: FileRole;
  /** Size in bytes. */
  size: number;
  updatedAt: ISODate;
}

export type Entry = FolderEntry | FileEntry;

export interface FolderListing {
  path: string;
  name: string;
  project: string;
  isProjectRoot: boolean;
  /** Only present on project roots. */
  index: FileEntry | null;
  checklist: (FileEntry & { progress: ChecklistProgress }) | null;
  folders: FolderEntry[];
  files: FileEntry[];
}

export interface FileDocument {
  path: string;
  name: string;
  project: string;
  role: FileRole;
  content: string;
  size: number;
  updatedAt: ISODate;
  /** Opaque version used for optimistic concurrency on writes. */
  version: string;
  /** index.md only. */
  generatedAt?: ISODate;
  tokenCount?: number;
}

export interface KBSummary {
  projectCount: number;
  fileCount: number;
  totalBytes: number;
}

export interface RecentFile {
  path: string;
  name: string;
  project: string;
  role: FileRole;
  openedAt: ISODate;
}

// ─── Search ──────────────────────────────────────────────────────────────────

export interface SearchSnippet {
  text: string;
  /** [start, end) character ranges to highlight inside `text`. */
  highlights: [number, number][];
}

export interface SearchHit {
  path: string;
  name: string;
  project: string;
  role: FileRole;
  snippet: SearchSnippet;
  /** Occurrences in the file beyond the one shown in `snippet`. */
  extraMatches: number;
}

export interface SearchResponse {
  query: string;
  totalMatches: number;
  hits: SearchHit[];
  /** Match counts per project, ignoring the project filter. */
  byProject: { project: string; matches: number }[];
}

// ─── Agents & activity ───────────────────────────────────────────────────────

export type AgentPermission = 'read' | 'read-write';

export interface Agent {
  id: string;
  name: string;
  initials: string;
  /** Avatar background. null → neutral surface. */
  color: string | null;
  permission: AgentPermission;
  connectedAt: ISODate;
  lastSeenAt: ISODate | null;
}

export type ActivityKind = 'write' | 'create' | 'delete' | 'check' | 'read' | 'restore';

export interface ActivityEvent {
  id: string;
  agentId: string;
  kind: ActivityKind;
  project: string;
  /** Target file (absent for multi-file reads). */
  path: string | null;
  at: ISODate;
  /** Items checked (kind = check) or files read (kind = read). */
  count?: number;
  added?: number;
  removed?: number;
  /** Present when the event produced a reviewable change. */
  changeId?: string;
}

export interface Change {
  id: string;
  agentId: string;
  path: string;
  project: string;
  at: ISODate;
  /** True when produced by automatic index compilation. */
  automatic: boolean;
  before: string;
  after: string;
  added: number;
  removed: number;
  restorable: boolean;
}

export interface ConnectionInfo {
  endpoint: string;
  token: string;
}

// ─── Settings ────────────────────────────────────────────────────────────────

export interface KBSettings {
  offlineAvailable: boolean;
  regenerateIndexOnChange: boolean;
  lastSyncAt: ISODate | null;
}

// ─── Mutations ───────────────────────────────────────────────────────────────

export type NewFileTemplate = 'empty' | 'sections' | 'checklist';

export interface CreateProjectInput {
  name: string;
  description: string;
  icon: ProjectIcon;
  withChecklist: boolean;
}

export interface CreateFileInput {
  /** Parent folder path. */
  parent: string;
  /** File name including ".md". */
  name: string;
  content: string;
}

/** Returned by delete so the UI can offer an undo window. */
export interface DeleteReceipt {
  token: string;
  path: string;
  kind: 'file' | 'folder';
  /** Undo is possible until this instant. */
  undoUntil: ISODate;
}

export class KBError extends Error {
  constructor(
    public code: 'not_found' | 'conflict' | 'exists' | 'read_only' | 'invalid' | 'network',
    message: string,
  ) {
    super(message);
  }
}
