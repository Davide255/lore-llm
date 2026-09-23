import AsyncStorage from '@react-native-async-storage/async-storage';

import type { KnowledgeBaseClient, ServerEvent } from '../client';
import {
  KBError,
  type ActivityEvent,
  type Agent,
  type AgentPermission,
  type Change,
  type CreateFileInput,
  type CreateProjectInput,
  type DeleteReceipt,
  type FileDocument,
  type FileEntry,
  type FolderEntry,
  type FolderListing,
  type KBSettings,
  type Project,
  type ProjectIcon,
  type SearchHit,
  type SearchResponse,
} from '../types';
import {
  seedActivity,
  seedAgents,
  seedChanges,
  seedFiles,
  seedProjects,
  seedRecentFiles,
  seedRecentSearches,
} from './seed';
import { byteLength } from '@/lib/format';
import { diffLines, diffStats } from '@/lib/diff';
import { checklistProgress, parse, plainText } from '@/lib/markdown';
import {
  CHECKLIST_FILE,
  INDEX_FILE,
  basename,
  dirname,
  joinPath,
  projectOf,
  roleOf,
  splitPath,
} from '@/lib/paths';

/**
 * In-memory implementation of the backend, persisted to AsyncStorage so the
 * demo survives reloads. It mimics the behaviour described in the production
 * plan: index.md is recompiled in the background after every write, deletes are
 * soft (undoable), and agents' writes are recorded as reviewable changes.
 */

const STORAGE_KEY = 'kb.mock.v1';
const UNDO_WINDOW_MS = 10_000;
const REGEN_DELAY_MS = 1_600;
const INDEX_PAUSE_MS = 60 * 60_000;

interface StoredFile {
  content: string;
  updatedAt: string;
  version: number;
  generatedAt?: string;
}

interface TrashItem {
  kind: 'file' | 'folder';
  path: string;
  files: Record<string, StoredFile>;
  folders: string[];
  project?: { name: string; meta: ProjectMeta };
}

interface ProjectMeta {
  description: string;
  icon: ProjectIcon;
}

interface State {
  files: Record<string, StoredFile>;
  folders: string[];
  projects: Record<string, ProjectMeta>;
  trash: Record<string, TrashItem>;
  agents: Agent[];
  activity: ActivityEvent[];
  changes: Record<string, Change>;
  recentSearches: string[];
  recentFiles: { path: string; openedAt: string }[];
  settings: KBSettings;
  indexPausedUntil: Record<string, string>;
}

const iso = (msAgo = 0) => new Date(Date.now() - msAgo).toISOString();
const uid = () => Math.random().toString(36).slice(2, 10);
const wait = (ms = 80 + Math.random() * 140) => new Promise((r) => setTimeout(r, ms));

function buildSeed(): State {
  const files: Record<string, StoredFile> = {};
  for (const f of seedFiles) files[f.path] = { content: f.content, updatedAt: iso(f.ago), version: 1 };
  files['Athly Dashboard/index.md'].generatedAt = files['Athly Dashboard/index.md'].updatedAt;

  const folders: string[] = [];
  const projects: Record<string, ProjectMeta> = {};
  for (const p of seedProjects) {
    projects[p.name] = { description: p.description, icon: p.icon };
    folders.push(p.name, ...p.folders.map((f) => joinPath(p.name, f)));
  }

  const changes: Record<string, Change> = {};
  for (const c of seedChanges) {
    const after = files[c.path]?.content ?? '';
    let before = c.before;
    if (c.id === 'chg-checklist') {
      before = after.replace('- [x] Breakpoint', '- [ ] Breakpoint').replace('- [x] Unificare', '- [ ] Unificare');
    }
    const stats = diffStats(diffLines(before, after));
    changes[c.id] = { ...c, before, after, at: iso(c.ago), ...stats };
  }
  const activity = seedActivity.map(({ ago, ...e }) => {
    const change = e.changeId ? changes[e.changeId] : undefined;
    return { ...e, at: iso(ago), added: change?.added, removed: change?.removed };
  });

  const state: State = {
    files,
    folders,
    projects,
    trash: {},
    agents: seedAgents.map(({ seenAgo, ...a }) => ({
      ...a,
      connectedAt: iso(30 * 24 * 60 * 60_000),
      lastSeenAt: seenAgo == null ? null : iso(seenAgo),
    })),
    activity,
    changes,
    recentSearches: [...seedRecentSearches],
    recentFiles: seedRecentFiles.map((r) => ({ path: r.path, openedAt: iso(r.ago) })),
    settings: { offlineAvailable: true, regenerateIndexOnChange: true, lastSyncAt: iso(2 * 60_000) },
    indexPausedUntil: {},
  };
  // Every project gets a compiled index.md, like the backend would.
  for (const p of seedProjects) {
    if (!files[joinPath(p.name, INDEX_FILE)]) compileIndexInto(state, p.name);
  }
  return state;
}

function compileIndexInto(state: State, project: string) {
  const path = joinPath(project, INDEX_FILE);
  const meta = state.projects[project];
  if (!meta) return;
  const previous = state.files[path]?.content ?? '';
  const topFolders = state.folders.filter((f) => dirname(f) === project).sort();
  const topFiles = Object.keys(state.files)
    .filter((f) => dirname(f) === project && basename(f) !== INDEX_FILE && basename(f) !== CHECKLIST_FILE)
    .sort();
  const countIn = (folder: string) => Object.keys(state.files).filter((f) => f.startsWith(folder + '/')).length;
  const width = Math.max(0, ...topFolders.map((f) => basename(f).length + 1)) + 3;
  const structure = [
    ...topFolders.map((f) => `${(basename(f) + '/').padEnd(width)}${countIn(f)} file`),
    ...topFiles.map(basename),
  ];

  // Keep curated sections (e.g. "Concetti chiave") that agents added before.
  const kept = previous
    .split(/\n(?=## )/)
    .filter((section) => section.startsWith('## ') && !section.startsWith('## Struttura'))
    .map((s) => s.trim());

  const parts = [`# ${project}`, meta.description.trim()].filter(Boolean);
  parts.push('## Struttura\n\n```\n' + (structure.length ? structure.join('\n') : '(vuoto)') + '\n```');
  parts.push(...kept);
  const content = parts.join('\n\n') + '\n';
  const now = iso();
  state.files[path] = {
    content,
    updatedAt: now,
    generatedAt: now,
    version: (state.files[path]?.version ?? 0) + 1,
  };
}

export class MockKnowledgeBaseClient implements KnowledgeBaseClient {
  private state: State | null = null;
  private loading: Promise<State> | null = null;
  private listeners = new Set<(e: ServerEvent) => void>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private regenTimers = new Map<string, ReturnType<typeof setTimeout>>();

  // ─── infrastructure ───────────────────────────────────────────────────────

  private async db(): Promise<State> {
    if (this.state) return this.state;
    if (!this.loading) {
      this.loading = (async () => {
        try {
          const raw = await AsyncStorage.getItem(STORAGE_KEY);
          if (raw) return JSON.parse(raw) as State;
        } catch {
          // Corrupt or unavailable storage: fall back to the seed.
        }
        return buildSeed();
      })().then((s) => (this.state = s));
    }
    return this.loading;
  }

  private persist() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      if (this.state) AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(this.state)).catch(() => {});
    }, 300);
  }

  private emit(e: ServerEvent) {
    this.listeners.forEach((l) => l(e));
  }

  subscribe(listener: (e: ServerEvent) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async resetDemoData() {
    this.state = buildSeed();
    this.loading = Promise.resolve(this.state);
    this.persist();
    this.emit({ type: 'changed', paths: [] });
  }

  /** Simulates the Worker recompiling index.md after a write. */
  private scheduleIndex(project: string) {
    const s = this.state!;
    if (!s.projects[project] || !s.settings.regenerateIndexOnChange) return;
    const paused = s.indexPausedUntil[project];
    if (paused && new Date(paused).getTime() > Date.now()) return;
    clearTimeout(this.regenTimers.get(project));
    this.emit({ type: 'index-regenerating', project });
    this.regenTimers.set(
      project,
      setTimeout(() => {
        if (!this.state?.projects[project]) return;
        compileIndexInto(this.state, project);
        this.persist();
        this.emit({ type: 'index-regenerated', project });
        this.emit({ type: 'changed', paths: [joinPath(project, INDEX_FILE)] });
      }, REGEN_DELAY_MS),
    );
  }

  private touched(...paths: string[]) {
    this.persist();
    const projects = new Set(paths.map(projectOf).filter(Boolean));
    projects.forEach((p) => this.scheduleIndex(p));
  }

  private fileEntry(path: string, f: StoredFile): FileEntry {
    return {
      kind: 'file',
      path,
      name: basename(path),
      role: roleOf(path),
      size: byteLength(f.content),
      updatedAt: f.updatedAt,
    };
  }

  private folderEntry(s: State, path: string): FolderEntry {
    const files = Object.entries(s.files).filter(([p]) => p.startsWith(path + '/'));
    const updatedAt = files.reduce((max, [, f]) => (f.updatedAt > max ? f.updatedAt : max), '');
    return {
      kind: 'folder',
      path,
      name: basename(path),
      fileCount: files.length,
      folderCount: s.folders.filter((f) => dirname(f) === path).length,
      updatedAt: updatedAt || iso(),
    };
  }

  private toProject(s: State, name: string): Project {
    const meta = s.projects[name];
    if (!meta) throw new KBError('not_found', `Progetto "${name}" non trovato`);
    const files = Object.entries(s.files).filter(([p]) => projectOf(p) === name);
    const checklist = s.files[joinPath(name, CHECKLIST_FILE)];
    const progress = checklist ? checklistProgress(checklist.content) : null;
    return {
      name,
      description: meta.description,
      icon: meta.icon,
      fileCount: files.filter(([p]) => roleOf(p) !== 'index').length,
      // The compiled index doesn't count as user/agent activity.
      updatedAt: files
        .filter(([p]) => roleOf(p) !== 'index')
        .reduce((max, [, f]) => (f.updatedAt > max ? f.updatedAt : max), ''),
      checklist: progress && progress.total > 0 ? progress : null,
    };
  }

  private toDocument(path: string, f: StoredFile): FileDocument {
    return {
      path,
      name: basename(path),
      project: projectOf(path),
      role: roleOf(path),
      content: f.content,
      size: byteLength(f.content),
      updatedAt: f.updatedAt,
      version: String(f.version),
      generatedAt: f.generatedAt,
      tokenCount: roleOf(path) === 'index' ? Math.round(f.content.length / 3.6) : undefined,
    };
  }

  private exists(s: State, path: string) {
    return !!s.files[path] || s.folders.includes(path);
  }

  private assertFolder(s: State, path: string) {
    if (!s.folders.includes(path)) throw new KBError('not_found', `Cartella "${path}" non trovata`);
  }

  private assertWritable(path: string) {
    if (roleOf(path) === 'index') throw new KBError('read_only', 'index.md è generato automaticamente');
  }

  /** Re-key every file/folder under `from` to `to`. */
  private movePrefix(s: State, from: string, to: string) {
    const re = (p: string) => (p === from ? to : p.startsWith(from + '/') ? to + p.slice(from.length) : p);
    s.files = Object.fromEntries(Object.entries(s.files).map(([p, f]) => [re(p), f]));
    s.folders = s.folders.map(re);
    s.recentFiles = s.recentFiles.map((r) => ({ ...r, path: re(r.path) }));
  }

  // ─── browse ───────────────────────────────────────────────────────────────

  async getSummary() {
    const s = await this.db();
    await wait();
    const files = Object.values(s.files);
    return {
      projectCount: Object.keys(s.projects).length,
      fileCount: Object.keys(s.files).filter((p) => roleOf(p) !== 'index').length,
      totalBytes: files.reduce((n, f) => n + byteLength(f.content), 0),
    };
  }

  async listProjects() {
    const s = await this.db();
    await wait();
    return Object.keys(s.projects)
      .map((name) => this.toProject(s, name))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async getProject(name: string) {
    const s = await this.db();
    await wait();
    return this.toProject(s, name);
  }

  async listFolder(path: string): Promise<FolderListing> {
    const s = await this.db();
    await wait();
    this.assertFolder(s, path);
    const root = splitPath(path).length === 1;
    const files = Object.entries(s.files)
      .filter(([p]) => dirname(p) === path)
      .map(([p, f]) => this.fileEntry(p, f));
    const index = root ? (files.find((f) => f.role === 'index') ?? null) : null;
    const checklistFile = root ? files.find((f) => f.role === 'checklist') : undefined;
    return {
      path,
      name: basename(path),
      project: projectOf(path),
      isProjectRoot: root,
      index,
      checklist: checklistFile
        ? { ...checklistFile, progress: checklistProgress(s.files[checklistFile.path].content) }
        : null,
      folders: s.folders
        .filter((f) => dirname(f) === path)
        .map((f) => this.folderEntry(s, f))
        .sort((a, b) => a.name.localeCompare(b.name)),
      files: files
        .filter((f) => f.role === 'doc')
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    };
  }

  async listFolderTree(project: string) {
    const s = await this.db();
    await wait(60);
    return s.folders.filter((f) => projectOf(f) === project).sort();
  }

  async getFile(path: string) {
    const s = await this.db();
    await wait();
    const f = s.files[path];
    if (!f) throw new KBError('not_found', `File "${path}" non trovato`);
    return this.toDocument(path, f);
  }

  async listRecentFiles(limit = 5) {
    const s = await this.db();
    await wait(60);
    return s.recentFiles
      .filter((r) => s.files[r.path])
      .slice(0, limit)
      .map((r) => ({ ...r, name: basename(r.path), project: projectOf(r.path), role: roleOf(r.path) }));
  }

  async markOpened(path: string) {
    const s = await this.db();
    s.recentFiles = [{ path, openedAt: iso() }, ...s.recentFiles.filter((r) => r.path !== path)].slice(0, 20);
    this.persist();
  }

  // ─── write ────────────────────────────────────────────────────────────────

  async writeFile(path: string, content: string, baseVersion?: string) {
    const s = await this.db();
    await wait();
    this.assertWritable(path);
    const f = s.files[path];
    if (!f) throw new KBError('not_found', `File "${path}" non trovato`);
    if (baseVersion && baseVersion !== String(f.version)) {
      throw new KBError('conflict', 'Il file è stato modificato da qualcun altro nel frattempo.');
    }
    s.files[path] = { content, updatedAt: iso(), version: f.version + 1 };
    this.touched(path);
    return this.toDocument(path, s.files[path]);
  }

  async createFile({ parent, name, content }: CreateFileInput) {
    const s = await this.db();
    await wait();
    this.assertFolder(s, parent);
    const path = joinPath(parent, name);
    if (this.exists(s, path)) throw new KBError('exists', `"${name}" esiste già`);
    this.assertWritable(path);
    s.files[path] = { content, updatedAt: iso(), version: 1 };
    this.touched(path);
    return this.toDocument(path, s.files[path]);
  }

  async createFolder(parent: string, name: string) {
    const s = await this.db();
    await wait();
    this.assertFolder(s, parent);
    const path = joinPath(parent, name);
    if (this.exists(s, path)) throw new KBError('exists', `"${name}" esiste già`);
    s.folders.push(path);
    this.touched(path);
    return path;
  }

  async createProject({ name, description, icon, withChecklist }: CreateProjectInput) {
    const s = await this.db();
    await wait();
    const clean = name.trim();
    if (!clean || clean.includes('/')) throw new KBError('invalid', 'Nome progetto non valido');
    if (s.projects[clean]) throw new KBError('exists', `Il progetto "${clean}" esiste già`);
    s.projects[clean] = { description: description.trim(), icon };
    s.folders.push(clean);
    if (withChecklist) {
      s.files[joinPath(clean, CHECKLIST_FILE)] = {
        content: '## Da fare\n\n- [ ] Prima attività\n',
        updatedAt: iso(),
        version: 1,
      };
    }
    compileIndexInto(s, clean);
    this.persist();
    return this.toProject(s, clean);
  }

  async updateProject(name: string, patch: Partial<Pick<Project, 'description' | 'icon'>>) {
    const s = await this.db();
    await wait();
    const meta = s.projects[name];
    if (!meta) throw new KBError('not_found', `Progetto "${name}" non trovato`);
    s.projects[name] = { ...meta, ...patch };
    this.touched(name);
    return this.toProject(s, name);
  }

  async rename(path: string, newName: string) {
    const s = await this.db();
    await wait();
    if (roleOf(path) !== 'doc' && s.files[path]) throw new KBError('read_only', 'I file speciali non si rinominano');
    if (!this.exists(s, path)) throw new KBError('not_found', 'Elemento non trovato');
    const target = joinPath(dirname(path), newName);
    if (target === path) return path;
    if (this.exists(s, target)) throw new KBError('exists', `"${newName}" esiste già`);
    if (splitPath(path).length === 1) {
      s.projects[target] = s.projects[path];
      delete s.projects[path];
      s.activity = s.activity.map((e) => (e.project === path ? { ...e, project: target } : e));
    }
    this.movePrefix(s, path, target);
    if (splitPath(path).length === 1) compileIndexInto(s, target);
    this.touched(target);
    return target;
  }

  async move(path: string, targetFolder: string) {
    const s = await this.db();
    await wait();
    this.assertFolder(s, targetFolder);
    if (roleOf(path) !== 'doc') throw new KBError('read_only', 'I file speciali non si spostano');
    if (targetFolder === path || targetFolder.startsWith(path + '/'))
      throw new KBError('invalid', 'Non puoi spostare una cartella dentro sé stessa');
    const target = joinPath(targetFolder, basename(path));
    if (this.exists(s, target)) throw new KBError('exists', `"${basename(path)}" esiste già lì`);
    this.movePrefix(s, path, target);
    this.touched(path, target);
    return target;
  }

  async duplicate(path: string) {
    const s = await this.db();
    await wait();
    const f = s.files[path];
    if (!f) throw new KBError('not_found', 'File non trovato');
    const stem = basename(path).replace(/\.md$/, '');
    let n = 1;
    let target = joinPath(dirname(path), `${stem}-copia.md`);
    while (this.exists(s, target)) target = joinPath(dirname(path), `${stem}-copia-${++n}.md`);
    s.files[target] = { content: f.content, updatedAt: iso(), version: 1 };
    this.touched(target);
    return target;
  }

  async remove(path: string): Promise<DeleteReceipt> {
    const s = await this.db();
    await wait();
    this.assertWritable(path);
    const isFolder = s.folders.includes(path);
    if (!isFolder && !s.files[path]) throw new KBError('not_found', 'Elemento non trovato');
    const token = uid();
    const inside = (p: string) => p === path || p.startsWith(path + '/');
    const item: TrashItem = {
      kind: isFolder ? 'folder' : 'file',
      path,
      files: Object.fromEntries(Object.entries(s.files).filter(([p]) => inside(p))),
      folders: s.folders.filter(inside),
    };
    if (splitPath(path).length === 1) {
      item.project = { name: path, meta: s.projects[path] };
      delete s.projects[path];
    }
    s.files = Object.fromEntries(Object.entries(s.files).filter(([p]) => !inside(p)));
    s.folders = s.folders.filter((f) => !inside(f));
    s.trash[token] = item;
    this.touched(path);
    return { token, path, kind: item.kind, undoUntil: new Date(Date.now() + UNDO_WINDOW_MS).toISOString() };
  }

  async undoRemove(token: string) {
    const s = await this.db();
    await wait();
    const item = s.trash[token];
    if (!item) throw new KBError('not_found', 'Niente da ripristinare');
    Object.assign(s.files, item.files);
    s.folders.push(...item.folders.filter((f) => !s.folders.includes(f)));
    if (item.project) s.projects[item.project.name] = item.project.meta;
    delete s.trash[token];
    this.touched(item.path);
  }

  // ─── search ───────────────────────────────────────────────────────────────

  async search(query: string, project?: string | null): Promise<SearchResponse> {
    const s = await this.db();
    await wait();
    const q = query.trim().toLowerCase();
    if (!q) return { query, totalMatches: 0, hits: [], byProject: [] };
    const count = (text: string) => {
      let n = 0;
      let i = text.toLowerCase().indexOf(q);
      while (i !== -1) {
        n++;
        i = text.toLowerCase().indexOf(q, i + q.length);
      }
      return n;
    };
    const all: (SearchHit & { matches: number; updatedAt: string })[] = [];
    for (const [path, f] of Object.entries(s.files)) {
      const lines = parse(f.content).flatMap((b) =>
        'text' in b ? (b.type === 'code' ? b.text.split('\n') : [plainText(b.text)]) : [],
      );
      const matches = lines.reduce((n, l) => n + count(l), 0);
      if (!matches) continue;
      const line = lines.find((l) => count(l) > 0)!;
      const snippet = makeSnippet(line, q);
      all.push({
        path,
        name: basename(path),
        project: projectOf(path),
        role: roleOf(path),
        snippet,
        extraMatches: matches - snippet.highlights.length,
        matches,
        updatedAt: f.updatedAt,
      });
    }
    const byProject = new Map<string, number>();
    all.forEach((h) => byProject.set(h.project, (byProject.get(h.project) ?? 0) + h.matches));
    const hits = all
      .filter((h) => !project || h.project === project)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return {
      query,
      totalMatches: hits.reduce((n, h) => n + h.matches, 0),
      hits: hits.map(({ matches: _m, updatedAt: _u, ...h }) => h),
      byProject: [...byProject.entries()]
        .map(([p, matches]) => ({ project: p, matches }))
        .sort((a, b) => b.matches - a.matches),
    };
  }

  async listRecentSearches() {
    const s = await this.db();
    return s.recentSearches;
  }

  async addRecentSearch(query: string) {
    const s = await this.db();
    const q = query.trim();
    if (!q) return;
    s.recentSearches = [q, ...s.recentSearches.filter((x) => x !== q)].slice(0, 8);
    this.persist();
  }

  async removeRecentSearch(query: string) {
    const s = await this.db();
    s.recentSearches = s.recentSearches.filter((x) => x !== query);
    this.persist();
  }

  // ─── agents ───────────────────────────────────────────────────────────────

  async listAgents() {
    const s = await this.db();
    await wait();
    return s.agents;
  }

  async getAgent(id: string) {
    const s = await this.db();
    await wait();
    const a = s.agents.find((x) => x.id === id);
    if (!a) throw new KBError('not_found', 'Agente non trovato');
    return a;
  }

  async setAgentPermission(id: string, permission: AgentPermission) {
    const s = await this.db();
    await wait();
    s.agents = s.agents.map((a) => (a.id === id ? { ...a, permission } : a));
    this.persist();
    return s.agents.find((a) => a.id === id)!;
  }

  async disconnectAgent(id: string) {
    const s = await this.db();
    await wait();
    s.agents = s.agents.filter((a) => a.id !== id);
    this.persist();
  }

  async createConnection() {
    await wait();
    return { endpoint: 'https://kb.example.com/mcp/sse', token: `kb_${uid()}${uid()}` };
  }

  async listActivity() {
    const s = await this.db();
    await wait();
    return [...s.activity].sort((a, b) => b.at.localeCompare(a.at));
  }

  async getChange(id: string) {
    const s = await this.db();
    await wait();
    const c = s.changes[id];
    if (!c) throw new KBError('not_found', 'Modifica non trovata');
    return { ...c, restorable: c.restorable && !!s.files[c.path] };
  }

  async revertChange(id: string) {
    const s = await this.db();
    await wait();
    const c = s.changes[id];
    const f = c && s.files[c.path];
    if (!c || !f || !c.restorable) throw new KBError('invalid', 'Questa modifica non si può ripristinare');
    s.files[c.path] = { ...f, content: c.before, updatedAt: iso(), version: f.version + 1 };
    s.changes[id] = { ...c, restorable: false };
    s.indexPausedUntil[c.project] = new Date(Date.now() + INDEX_PAUSE_MS).toISOString();
    this.persist();
    this.emit({ type: 'changed', paths: [c.path] });
  }

  // ─── settings ─────────────────────────────────────────────────────────────

  async getSettings() {
    const s = await this.db();
    await wait(60);
    return s.settings;
  }

  async updateSettings(patch: Partial<KBSettings>) {
    const s = await this.db();
    await wait(60);
    s.settings = { ...s.settings, ...patch };
    this.persist();
    return s.settings;
  }

  async sync() {
    const s = await this.db();
    await wait(700);
    s.settings = { ...s.settings, lastSyncAt: iso() };
    this.persist();
    return s.settings;
  }
}

function makeSnippet(line: string, q: string) {
  const lower = line.toLowerCase();
  const first = lower.indexOf(q);
  const start = Math.max(0, first - 24);
  const end = Math.min(line.length, start + 96);
  let text = line.slice(start, end);
  let offset = start;
  if (start > 0) {
    text = '…' + text;
    offset -= 1;
  }
  if (end < line.length) text += '…';
  const highlights: [number, number][] = [];
  let i = lower.indexOf(q, start);
  while (i !== -1 && i + q.length <= end) {
    highlights.push([i - offset, i - offset + q.length]);
    i = lower.indexOf(q, i + q.length);
  }
  return { text, highlights };
}
