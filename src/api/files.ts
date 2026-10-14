import type { Env } from '../env';
import { PathError, parseFolder, parsePath, parseProject } from '../storage/paths';
import { ConflictError, Store } from '../storage/store';

/**
 * File access for the user's own clients (desktop/mobile), authenticated with
 * the human's Cognito token. Same tenant prefix and path rules as the MCP tools;
 * writes are not audited (the audit log tracks agents).
 *
 *   GET    /v1/files                      every file of the user (path, size, uploaded, etag)
 *   GET    /v1/file?path=P/a.md           content + metadata
 *   PUT    /v1/file?path=P/a.md           {content, overwrite?, if_match?}
 *   DELETE /v1/file?path=P/a.md
 *   DELETE /v1/folder?path=P[/sub]        every file under the folder
 *   POST   /v1/files/move                 {from, to} — a file or a whole folder
 */

// R2 calls per request are limited; folder operations stay well below.
const MAX_BATCH = 100;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function rejectIndex(isIndex: boolean): void {
  if (isIndex) throw new PathError('index.md is generated automatically and cannot be modified.');
}

/** `Project` or `Project/folder/...` (no file). */
function parseFolderPath(input: unknown): { project: string; rel: string } {
  const rel = parseFolder(input);
  if (!rel) throw new PathError('path is required');
  const [first] = rel.split('/');
  const project = parseProject(first);
  if (rel.toLowerCase().endsWith('.md')) throw new PathError('path must be a folder');
  return { project, rel };
}

async function body(req: Request): Promise<Record<string, unknown>> {
  try {
    const b = await req.json();
    if (typeof b === 'object' && b !== null && !Array.isArray(b)) return b as Record<string, unknown>;
  } catch {
    /* fall through */
  }
  throw new PathError('Body must be a JSON object');
}

/** Returns null when the route is not a files route. */
export async function handleFiles(req: Request, env: Env, url: URL, userId: string): Promise<Response | null> {
  const store = new Store(env.BUCKET);
  const path = url.pathname;
  const m = req.method;

  try {
    if (path === '/v1/files' && m === 'GET') {
      return json({ files: await store.listAllFiles(userId) });
    }

    if (path === '/v1/file') {
      const p = parsePath(url.searchParams.get('path'));
      if (m === 'GET') {
        const file = await store.readVersion(userId, p.rel);
        return file ? json(file) : json({ error: 'Not found' }, 404);
      }
      if (m === 'PUT') {
        rejectIndex(p.isIndex);
        const b = await body(req);
        if (typeof b.content !== 'string') throw new PathError('content must be a string');
        if (b.if_match !== undefined && typeof b.if_match !== 'string') throw new PathError('if_match must be a string');
        const res = await store.save(userId, p.rel, b.content, { overwrite: b.overwrite === true, ifMatch: b.if_match as string | undefined });
        await store.compileIndex(userId, p.project);
        return json(res, res.action === 'CREATE' ? 201 : 200);
      }
      if (m === 'DELETE') {
        rejectIndex(p.isIndex);
        if (!(await store.delete(userId, p.rel))) return json({ error: 'Not found' }, 404);
        await store.compileIndex(userId, p.project);
        return json({ ok: true });
      }
    }

    if (path === '/v1/folder' && m === 'DELETE') {
      const f = parseFolderPath(url.searchParams.get('path'));
      const files = await store.listUnder(userId, f.rel);
      if (files.length > MAX_BATCH) throw new PathError(`Folder too large (max ${MAX_BATCH} files)`);
      for (const file of files) await store.delete(userId, file.path);
      if (f.rel !== f.project) await store.compileIndex(userId, f.project);
      return json({ ok: true, deleted: files.length });
    }

    if (path === '/v1/files/move' && m === 'POST') {
      const b = await body(req);
      return json(await move(store, userId, b.from, b.to));
    }

    return null;
  } catch (err) {
    if (err instanceof PathError) return json({ error: err.message }, 400);
    if (err instanceof ConflictError) return json({ error: err.message }, 409);
    throw err;
  }
}

/** R2 has no rename: copy then delete. A file moves alone; a folder moves with everything under it. */
async function move(store: Store, userId: string, from: unknown, to: unknown) {
  const isFile = typeof from === 'string' && from.toLowerCase().endsWith('.md');
  const pairs: [string, string][] = [];
  const projects = new Set<string>();

  if (isFile) {
    const a = parsePath(from);
    const b = parsePath(to);
    rejectIndex(a.isIndex);
    rejectIndex(b.isIndex);
    pairs.push([a.rel, b.rel]);
    projects.add(a.project).add(b.project);
  } else {
    const a = parseFolderPath(from);
    const b = parseFolderPath(to);
    if (b.rel === a.rel || b.rel.startsWith(`${a.rel}/`)) throw new PathError('Cannot move a folder inside itself');
    // The generated index stays behind; it is rebuilt for the destination.
    const files = (await store.listUnder(userId, a.rel)).filter((f) => f.path.toLowerCase() !== `${a.project}/index.md`.toLowerCase());
    if (files.length > MAX_BATCH) throw new PathError(`Folder too large (max ${MAX_BATCH} files)`);
    for (const f of files) {
      const dest = parsePath(`${b.rel}${f.path.slice(a.rel.length)}`);
      rejectIndex(dest.isIndex);
      pairs.push([f.path, dest.rel]);
    }
    projects.add(a.project).add(b.project);
  }

  for (const [, dest] of pairs) {
    if ((await store.read(userId, dest)) !== null) throw new PathError(`File already exists: ${dest}`);
  }
  for (const [src, dest] of pairs) {
    const content = await store.read(userId, src);
    if (content === null) continue;
    await store.save(userId, dest, content, { overwrite: false });
    await store.delete(userId, src);
  }
  for (const project of projects) await store.compileIndex(userId, project);
  return { ok: true, moved: pairs.length };
}
