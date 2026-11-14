/**
 * The Lambda reads and writes the knowledge base only through the lore-llm
 * Worker, with the caller's own Cognito token. That keeps one place for the
 * access rules (team roles: viewers read, editors write), index.md, the change
 * cursor and the search index: nothing here touches R2 or D1.
 */
import { StudyError } from './types';

export type Fetch = typeof fetch;

export interface WorkerClient {
  readNote(path: string, owner?: string): Promise<string>;
  readBlob(path: string, owner?: string): Promise<{ bytes: Uint8Array; contentType: string }>;
  /** Creates the note (never overwrites); on a name clash tries `name-2.md`, `name-3.md`… Returns the path written. */
  createNote(path: string, content: string, owner?: string): Promise<string>;
}

const MAX_SUFFIX = 9;

export function workerClient(baseUrl: string, token: string, fetcher: Fetch = fetch): WorkerClient {
  const url = (route: string, path: string, owner?: string) => {
    const q = new URLSearchParams({ path });
    if (owner) q.set('owner', owner);
    return `${baseUrl.replace(/\/+$/, '')}${route}?${q}`;
  };
  const headers = { authorization: `Bearer ${token}` };

  async function call(input: string, init: RequestInit = {}): Promise<Response> {
    try {
      return await fetcher(input, { ...init, headers: { ...headers, ...(init.headers as Record<string, string>) } });
    } catch (err) {
      throw new StudyError('upstream', `Knowledge base unreachable: ${String(err)}`);
    }
  }

  async function fail(res: Response, path: string): Promise<never> {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    if (res.status === 401) throw new StudyError('unauthorized', 'Session expired');
    if (res.status === 403) throw new StudyError('forbidden', `No access to ${path}`);
    if (res.status === 404) throw new StudyError('not_found', `File not found: ${path}`);
    if (res.status === 400) throw new StudyError('invalid', body.error ?? `Invalid path: ${path}`);
    throw new StudyError('upstream', `Knowledge base error ${res.status}${body.error ? `: ${body.error}` : ''}`);
  }

  async function peekError(res: Response): Promise<string> {
    const body = (await res.clone().json().catch(() => ({}))) as { error?: string };
    return body.error ?? '';
  }

  return {
    async readNote(path, owner) {
      const res = await call(url('/v1/file', path, owner));
      if (!res.ok) return fail(res, path);
      const body = (await res.json()) as { content?: unknown };
      if (typeof body.content !== 'string') throw new StudyError('upstream', `Unexpected response for ${path}`);
      return body.content;
    },

    async readBlob(path, owner) {
      const res = await call(url('/v1/blob', path, owner));
      if (!res.ok) return fail(res, path);
      return { bytes: new Uint8Array(await res.arrayBuffer()), contentType: res.headers.get('content-type') ?? '' };
    },

    async createNote(path, content, owner) {
      const dot = path.toLowerCase().lastIndexOf('.md');
      for (let n = 1; n <= MAX_SUFFIX; n++) {
        const candidate = n === 1 ? path : `${path.slice(0, dot)}-${n}${path.slice(dot)}`;
        const res = await call(url('/v1/file', candidate, owner), {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ content, overwrite: false }),
        });
        if (res.ok) return candidate;
        // The Worker answers 400 "File already exists" for a taken name (409 is an etag conflict).
        const clash = res.status === 409 || (res.status === 400 && /already exists/i.test(await peekError(res)));
        if (!clash) return fail(res, candidate);
      }
      throw new StudyError('upstream', `Could not find a free name for ${path}`);
    },
  };
}
