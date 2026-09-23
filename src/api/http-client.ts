import type { KnowledgeBaseClient, ServerEvent } from './client';
import {
  KBError,
  type Agent,
  type AgentPermission,
  type ActivityEvent,
  type Change,
  type ConnectionInfo,
  type CreateFileInput,
  type CreateProjectInput,
  type DeleteReceipt,
  type FileDocument,
  type FolderListing,
  type KBSettings,
  type KBSummary,
  type Project,
  type RecentFile,
  type SearchResponse,
} from './types';

/**
 * REST client for the Cloudflare Worker described in "Production plan.md".
 * Not used yet — `src/api/index.ts` selects the mock until the backend exists.
 * The routes below are the proposed contract; adjust them here when the
 * Worker is built and nothing else in the app has to change.
 *
 * Paths are always relative to the user's root; the Worker prefixes the
 * Cognito `sub` for tenant isolation.
 */
export class HttpKnowledgeBaseClient implements KnowledgeBaseClient {
  constructor(
    private baseUrl: string,
    /** Returns the current Cognito access token (from the keychain). */
    private getToken: () => Promise<string | null>,
  ) {}

  private async request<T>(method: string, route: string, body?: unknown): Promise<T> {
    const token = await this.getToken();
    let res: Response;
    try {
      res = await fetch(this.baseUrl + route, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      throw new KBError('network', (e as Error).message);
    }
    if (!res.ok) {
      const code =
        res.status === 404 ? 'not_found' : res.status === 409 ? 'conflict' : res.status === 403 ? 'read_only' : 'invalid';
      const msg = await res.text().catch(() => res.statusText);
      throw new KBError(code, msg || res.statusText);
    }
    return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
  }

  private p = (path: string) => encodeURIComponent(path);

  getSummary = () => this.request<KBSummary>('GET', '/v1/summary');
  listProjects = () => this.request<Project[]>('GET', '/v1/projects');
  getProject = (name: string) => this.request<Project>('GET', `/v1/projects/${this.p(name)}`);
  listFolder = (path: string) => this.request<FolderListing>('GET', `/v1/folders?path=${this.p(path)}`);
  listFolderTree = (project: string) => this.request<string[]>('GET', `/v1/projects/${this.p(project)}/tree`);
  getFile = (path: string) => this.request<FileDocument>('GET', `/v1/files?path=${this.p(path)}`);
  listRecentFiles = (limit = 5) => this.request<RecentFile[]>('GET', `/v1/recent/files?limit=${limit}`);
  markOpened = (path: string) => this.request<void>('POST', '/v1/recent/files', { path });

  writeFile = (path: string, content: string, baseVersion?: string) =>
    this.request<FileDocument>('PUT', `/v1/files?path=${this.p(path)}`, { content, baseVersion });
  createFile = (input: CreateFileInput) => this.request<FileDocument>('POST', '/v1/files', input);
  createFolder = (parent: string, name: string) =>
    this.request<{ path: string }>('POST', '/v1/folders', { parent, name }).then((r) => r.path);
  createProject = (input: CreateProjectInput) => this.request<Project>('POST', '/v1/projects', input);
  updateProject = (name: string, patch: Partial<Pick<Project, 'description' | 'icon'>>) =>
    this.request<Project>('PATCH', `/v1/projects/${this.p(name)}`, patch);
  rename = (path: string, newName: string) =>
    this.request<{ path: string }>('POST', '/v1/entries/rename', { path, newName }).then((r) => r.path);
  move = (path: string, targetFolder: string) =>
    this.request<{ path: string }>('POST', '/v1/entries/move', { path, targetFolder }).then((r) => r.path);
  duplicate = (path: string) =>
    this.request<{ path: string }>('POST', '/v1/entries/duplicate', { path }).then((r) => r.path);
  remove = (path: string) => this.request<DeleteReceipt>('DELETE', `/v1/entries?path=${this.p(path)}`);
  undoRemove = (token: string) => this.request<void>('POST', `/v1/trash/${token}/restore`);

  search = (query: string, project?: string | null) =>
    this.request<SearchResponse>(
      'GET',
      `/v1/search?q=${encodeURIComponent(query)}${project ? `&project=${this.p(project)}` : ''}`,
    );
  listRecentSearches = () => this.request<string[]>('GET', '/v1/recent/searches');
  addRecentSearch = (query: string) => this.request<void>('POST', '/v1/recent/searches', { query });
  removeRecentSearch = (query: string) =>
    this.request<void>('DELETE', `/v1/recent/searches?q=${encodeURIComponent(query)}`);

  listAgents = () => this.request<Agent[]>('GET', '/v1/agents');
  getAgent = (id: string) => this.request<Agent>('GET', `/v1/agents/${id}`);
  setAgentPermission = (id: string, permission: AgentPermission) =>
    this.request<Agent>('PATCH', `/v1/agents/${id}`, { permission });
  disconnectAgent = (id: string) => this.request<void>('DELETE', `/v1/agents/${id}`);
  createConnection = () => this.request<ConnectionInfo>('POST', '/v1/agents/connections');
  listActivity = () => this.request<ActivityEvent[]>('GET', '/v1/activity');
  getChange = (id: string) => this.request<Change>('GET', `/v1/changes/${id}`);
  revertChange = (id: string) => this.request<void>('POST', `/v1/changes/${id}/revert`);

  getSettings = () => this.request<KBSettings>('GET', '/v1/settings');
  updateSettings = (patch: Partial<KBSettings>) => this.request<KBSettings>('PATCH', '/v1/settings', patch);
  sync = () => this.request<KBSettings>('POST', '/v1/sync');

  subscribe(_listener: (e: ServerEvent) => void) {
    // TODO: open an SSE stream on `${baseUrl}/v1/events` and forward events.
    return () => {};
  }
}
