import { searchNotes } from '../db/searchIndex';
import { MAX_STARS, addStar, listStars, moveStars, unstar } from '../db/stars';
import { listUserTeams } from '../db/teams';
import { bumpVersion, getVersion, getVersions } from '../db/version';
import type { Env } from '../env';
import { canRead, canWrite, resolveAccess } from '../permissions/access';
import { parseOwner, teamOwner, userOwner, type Owner } from '../storage/owner';
import { PathError, isStorableFile, parseFolder, parsePath, parseProject } from '../storage/paths';
import { parseQuery } from '../storage/search';
import { ConflictError, MAX_ATTACHMENT_BYTES, Store } from '../storage/store';

/**
 * File access for the user's own clients (desktop/mobile), authenticated with
 * the human's Cognito token. Same tenant prefix and path rules as the MCP tools;
 * writes are not audited (the audit log tracks agents).
 *
 * Every route takes an optional `?owner=t:<teamId>` to act on a team's files
 * (default: the caller's own). The caller's role on that owner decides: viewers
 * read, editors and owners write; anyone else gets 403.
 *
 *   GET    /v1/projects                   one row per project: {name, file_count, size, updated_at, checklist: {path, etag, size, uploaded}|null}
 *   GET    /v1/files[?attachments=1&project=P]  every note of the owner, or of one project (path, size, uploaded, etag); attachments on request
 *   GET    /v1/search?q=a+b[&project=P&limit=N]  full-text search over the owner's notes: every term (prefix match) must appear;
 *                                         ranked by BM25 (D1 FTS5); {hits:[{path,score,pathMatch,snippets:[{line,text}]}], scanned, truncated};
 *                                         truncated = some notes are not indexed yet, search again for complete results
 *   GET    /v1/stars                      the caller's starred notes across their own space and their teams': {stars:[{owner,path,starred_at}]}
 *   PUT    /v1/stars?owner=&path=P/a.md   star a note (idempotent; the note must exist; read access is enough)
 *   DELETE /v1/stars?owner=&path=P/a.md   unstar
 *   GET    /v1/version                    {version, updated_at, scopes}: bumped on every change to the owner's files, by anyone;
 *                                         without ?owner, `scopes` holds the cursors of the caller's teams, keyed `t:<teamId>`
 *   GET    /v1/file?path=P/a.md           content + metadata
 *   PUT    /v1/file?path=P/a.md           {content, overwrite?, if_match?}
 *   DELETE /v1/file?path=P/a.md           a note or an attachment
 *   GET    /v1/blob?path=P/img.png        raw attachment bytes (x-lore-etag header)
 *   PUT    /v1/blob?path=P/img.png        raw body; ?overwrite=1, If-Match: <etag>
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
  if (isStorableFile(rel)) throw new PathError('path must be a folder');
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

/** The owner a request acts on: `?owner=t:<teamId>` or, by default, the caller's own space. */
function requestOwner(url: URL, userId: string): Owner {
  const raw = url.searchParams.get('owner');
  if (raw === null) return userOwner(userId);
  try {
    const parsed = parseOwner(raw);
    return parsed.kind === 'team' ? teamOwner(parsed.id) : userOwner(parsed.id);
  } catch {
    throw new PathError('Invalid owner');
  }
}

/** Returns null when the route is not a files route. */
export async function handleFiles(req: Request, env: Env, url: URL, userId: string): Promise<Response | null> {
  try {
    const owner = requestOwner(url, userId);
    if (url.pathname === '/v1/stars') return await handleStars(req, env, url, userId, owner);
    const res = await route(req, env, url, userId, owner);
    // Any successful change moves the owner's change cursor.
    // The write already happened: a failed bump must not turn it into an error.
    if (res && req.method !== 'GET' && res.status < 300) {
      await bumpVersion(env.DB, owner).catch((err) => console.error('version bump failed', String(err)));
    }
    return res;
  } catch (err) {
    if (err instanceof PathError) return json({ error: err.message }, 400);
    if (err instanceof ConflictError) return json({ error: err.message }, 409);
    throw err;
  }
}

/**
 * Stars belong to the caller, not to the space they point into: a viewer can
 * star a team note, and starring must not move the team's change cursor (it
 * moves the caller's own, so their other devices resync).
 */
async function handleStars(req: Request, env: Env, url: URL, userId: string, owner: Owner): Promise<Response> {
  const store = new Store(env.BUCKET);
  if (req.method === 'GET') return json({ stars: await listStars(env.DB, store, userId) });
  if (req.method !== 'PUT' && req.method !== 'DELETE') return json({ error: 'Method not allowed' }, 405);
  if (!canRead(await resolveAccess(env.DB, userId, owner))) return json({ error: 'Forbidden' }, 403);
  const p = parsePath(url.searchParams.get('path'));
  rejectIndex(p.isIndex);
  if (req.method === 'DELETE') {
    const removed = await unstar(env.DB, userId, owner, p.rel);
    if (removed) await bumpVersion(env.DB, userId).catch((err) => console.error('version bump failed', String(err)));
    return json({ ok: true, removed });
  }
  if (!(await store.exists(owner, p.rel))) return json({ error: 'Not found' }, 404);
  if (!(await addStar(env.DB, userId, owner, p.rel))) throw new PathError(`Too many starred notes (max ${MAX_STARS})`);
  await bumpVersion(env.DB, userId).catch((err) => console.error('version bump failed', String(err)));
  return json({ ok: true });
}

async function route(req: Request, env: Env, url: URL, userId: string, owner: Owner): Promise<Response | null> {
  const store = new Store(env.BUCKET);
  const path = url.pathname;
  const m = req.method;

  // Every file operation is checked against the caller's role on the owner's files.
  const role = await resolveAccess(env.DB, userId, owner);
  if (!(m === 'GET' ? canRead(role) : canWrite(role))) return json({ error: 'Forbidden' }, 403);

  if (path === '/v1/files' && m === 'GET') {
    // `?project=P` lists one project only: clients load the rest when the user opens it.
    const project = url.searchParams.has('project') ? parseProject(url.searchParams.get('project')) : undefined;
    return json({ files: await store.listAllFiles(owner, { attachments: url.searchParams.get('attachments') === '1', project }) });
  }

  if (path === '/v1/search' && m === 'GET') {
    const terms = parseQuery(url.searchParams.get('q'));
    if (terms.length === 0) throw new PathError('q is required');
    const rawProject = url.searchParams.get('project');
    const project = rawProject ? parseProject(rawProject) : undefined;
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 100);
    return json(await searchNotes(env.DB, store, owner, terms, { project, limit }));
  }

  if (path === '/v1/projects' && m === 'GET') {
    return json({ projects: await store.listProjectSummaries(owner) });
  }

  if (path === '/v1/version' && m === 'GET') {
    const own = await getVersion(env.DB, owner);
    if (url.searchParams.has('owner')) return json(own);
    const teams = await listUserTeams(env.DB, userId);
    return json({ ...own, scopes: await getVersions(env.DB, teams.map((t) => teamOwner(t.id))) });
  }

  if (path === '/v1/file') {
    if (m === 'GET') {
      const p = parsePath(url.searchParams.get('path'));
      const file = await store.readVersion(owner, p.rel);
      return file ? json(file) : json({ error: 'Not found' }, 404);
    }
    if (m === 'PUT') {
      const p = parsePath(url.searchParams.get('path'));
      rejectIndex(p.isIndex);
      const b = await body(req);
      if (typeof b.content !== 'string') throw new PathError('content must be a string');
      if (b.if_match !== undefined && typeof b.if_match !== 'string') throw new PathError('if_match must be a string');
      const res = await store.save(owner, p.rel, b.content, { overwrite: b.overwrite === true, ifMatch: b.if_match as string | undefined });
      await store.compileIndex(owner, p.project);
      return json(res, res.action === 'CREATE' ? 201 : 200);
    }
    if (m === 'DELETE') {
      const p = parsePath(url.searchParams.get('path'), { attachments: true });
      rejectIndex(p.isIndex);
      if (!(await store.delete(owner, p.rel))) return json({ error: 'Not found' }, 404);
      if (p.kind === 'markdown') await store.compileIndex(owner, p.project);
      return json({ ok: true });
    }
  }

  if (path === '/v1/blob') {
    const p = parsePath(url.searchParams.get('path'), { attachments: true });
    if (p.kind !== 'attachment') throw new PathError('use /v1/file for notes');
    if (m === 'GET') {
      const obj = await store.readBlob(owner, p.rel);
      if (!obj) return json({ error: 'Not found' }, 404);
      return new Response(obj.body, {
        headers: { 'content-type': p.contentType, 'content-length': String(obj.size), 'x-lore-etag': obj.etag },
      });
    }
    if (m === 'PUT') {
      const declared = Number(req.headers.get('content-length') ?? 0);
      if (declared > MAX_ATTACHMENT_BYTES) throw new PathError(`File too large (max ${MAX_ATTACHMENT_BYTES} bytes)`);
      const ifMatch = req.headers.get('if-match') ?? undefined;
      const res = await store.saveBlob(owner, p.rel, await req.arrayBuffer(), p.contentType, {
        overwrite: url.searchParams.get('overwrite') === '1',
        ifMatch,
      });
      return json(res, res.action === 'CREATE' ? 201 : 200);
    }
  }

  if (path === '/v1/folder' && m === 'DELETE') {
    const f = parseFolderPath(url.searchParams.get('path'));
    const files = await store.listUnder(owner, f.rel);
    if (files.length > MAX_BATCH) throw new PathError(`Folder too large (max ${MAX_BATCH} files)`);
    for (const file of files) await store.delete(owner, file.path);
    if (f.rel !== f.project) await store.compileIndex(owner, f.project);
    return json({ ok: true, deleted: files.length });
  }

  if (path === '/v1/files/move' && m === 'POST') {
    const b = await body(req);
    return json(await move(store, env.DB, owner, b.from, b.to));
  }

  return null;
}

/**
 * R2 has no rename: copy then delete. A file moves alone; a folder moves with
 * everything under it. Copies are byte-exact, so attachments survive a move.
 */
async function move(store: Store, db: D1Database, owner: Owner, from: unknown, to: unknown) {
  const isFile = typeof from === 'string' && isStorableFile(from);
  const pairs: [string, string, string][] = [];
  const projects = new Set<string>();

  if (isFile) {
    const a = parsePath(from, { attachments: true });
    const b = parsePath(to, { attachments: true });
    rejectIndex(a.isIndex);
    rejectIndex(b.isIndex);
    if (a.kind !== b.kind) throw new PathError('A move cannot change a note into an attachment or back');
    pairs.push([a.rel, b.rel, b.contentType]);
    projects.add(a.project).add(b.project);
  } else {
    const a = parseFolderPath(from);
    const b = parseFolderPath(to);
    if (b.rel === a.rel || b.rel.startsWith(`${a.rel}/`)) throw new PathError('Cannot move a folder inside itself');
    // The generated index stays behind; it is rebuilt for the destination.
    const files = (await store.listUnder(owner, a.rel)).filter((f) => f.path.toLowerCase() !== `${a.project}/index.md`.toLowerCase());
    if (files.length > MAX_BATCH) throw new PathError(`Folder too large (max ${MAX_BATCH} files)`);
    for (const f of files) {
      const dest = parsePath(`${b.rel}${f.path.slice(a.rel.length)}`, { attachments: true });
      rejectIndex(dest.isIndex);
      pairs.push([f.path, dest.rel, dest.contentType]);
    }
    projects.add(a.project).add(b.project);
  }

  for (const [, dest] of pairs) {
    if (await store.exists(owner, dest)) throw new PathError(`File already exists: ${dest}`);
  }
  for (const [src, dest, contentType] of pairs) {
    if (!(await store.copy(owner, src, dest, contentType))) continue;
    await store.delete(owner, src);
  }
  if (isFile) await moveStars(db, owner, pairs[0]![0], pairs[0]![1], true);
  else await moveStars(db, owner, parseFolderPath(from).rel, parseFolderPath(to).rel, false);
  for (const project of projects) await store.compileIndex(owner, project);
  return { ok: true, moved: pairs.length };
}
