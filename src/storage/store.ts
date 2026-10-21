import type { Owner } from './owner';
import { MARKDOWN_TYPE, PathError, isMarkdown, objectKey } from './paths';

export const MAX_FILE_BYTES = 1024 * 1024; // 1 MiB per markdown file
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 10 MiB per attachment
const APPEND_RETRIES = 4;
/** R2 calls per request are limited; whole-project operations stay below this many files. */
export const MAX_BATCH = 100;

export interface FileInfo {
  /** Project-relative path. */
  path: string;
  size: number;
  uploaded: string;
}

export type WriteAction = 'CREATE' | 'UPDATE';

/** A file as the user's own clients see it (management API), with the etag for optimistic concurrency. */
export interface FileVersion {
  /** Path inside the owner's root: `Project/folder/file.md`. */
  path: string;
  size: number;
  uploaded: string;
  etag: string;
}

/** A project as listed on the home screen: counts plus the checklist's version (its content is fetched separately). */
export interface ProjectSummary {
  name: string;
  /** Notes, without the generated index. */
  file_count: number;
  /** Bytes of every note, index included. */
  size: number;
  /** Newest note (the index does not count); empty when the project has none. */
  updated_at: string;
  checklist: { path: string; etag: string; size: number; uploaded: string } | null;
}

/** Thrown when an `ifMatch` precondition fails: someone else changed the file meanwhile. */
export class ConflictError extends Error {}

/** All R2 access for one deployment. Methods take the owner (a user or a team) and add its prefix themselves. */
export class Store {
  constructor(private bucket: R2Bucket) {}

  private async listAll(prefix: string, delimiter?: string) {
    const objects: R2Object[] = [];
    const prefixes: string[] = [];
    let cursor: string | undefined;
    do {
      const res = await this.bucket.list({ prefix, delimiter, cursor, limit: 1000 });
      objects.push(...res.objects);
      prefixes.push(...res.delimitedPrefixes);
      cursor = res.truncated ? res.cursor : undefined;
    } while (cursor);
    return { objects, prefixes };
  }

  async listProjects(owner: Owner): Promise<string[]> {
    const root = `${owner}/`;
    const { prefixes } = await this.listAll(root, '/');
    return prefixes.map((p) => p.slice(root.length, -1)).sort();
  }

  async listFiles(owner: Owner, project: string, folder = ''): Promise<FileInfo[]> {
    const base = objectKey(owner, `${project}/`);
    const { objects } = await this.listAll(folder ? `${base}${folder}/` : base);
    return objects
      .map((o) => ({ path: o.key.slice(base.length), size: o.size, uploaded: o.uploaded.toISOString() }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  /**
   * Every file of the owner, across all projects, or of one project. Attachments are
   * listed only on request: older clients assume every listed file is a readable note.
   */
  async listAllFiles(owner: Owner, opts: { attachments?: boolean; project?: string } = {}): Promise<FileVersion[]> {
    const root = `${owner}/`;
    const { objects } = await this.listAll(opts.project ? `${root}${opts.project}/` : root);
    return objects
      .filter((o) => opts.attachments || isMarkdown(o.key))
      .map((o) => ({ path: o.key.slice(root.length), size: o.size, uploaded: o.uploaded.toISOString(), etag: o.etag }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  /**
   * One row per project, from a single listing (no file is read): enough to draw the
   * project list and its checklist progress without downloading the project.
   * Counts cover notes only, without the generated index.
   */
  async listProjectSummaries(owner: Owner): Promise<ProjectSummary[]> {
    const root = `${owner}/`;
    const { objects } = await this.listAll(root);
    const byProject = new Map<string, ProjectSummary>();
    for (const o of objects) {
      if (!isMarkdown(o.key)) continue;
      const rel = o.key.slice(root.length);
      const slash = rel.indexOf('/');
      if (slash === -1) continue;
      const name = rel.slice(0, slash);
      const inProject = rel.slice(slash + 1);
      const row = byProject.get(name) ?? { name, file_count: 0, size: 0, updated_at: '', checklist: null };
      byProject.set(name, row);
      row.size += o.size;
      const lower = inProject.toLowerCase();
      if (lower === 'index.md') continue;
      row.file_count++;
      const uploaded = o.uploaded.toISOString();
      if (uploaded > row.updated_at) row.updated_at = uploaded;
      if (lower === 'checklist.md') row.checklist = { path: rel, etag: o.etag, size: o.size, uploaded };
    }
    return [...byProject.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  async exists(owner: Owner, rel: string): Promise<boolean> {
    return (await this.bucket.head(objectKey(owner, rel))) !== null;
  }

  /** Permanently removes every object of the owner (notes and attachments). Returns how many. */
  async deleteAll(owner: Owner): Promise<number> {
    const { objects } = await this.listAll(`${owner}/`);
    const keys = objects.map((o) => o.key);
    // One R2 call per 1000 keys, to stay well under the per-request subrequest limit.
    for (let i = 0; i < keys.length; i += 1000) await this.bucket.delete(keys.slice(i, i + 1000));
    return keys.length;
  }

  /** Files under `Project/` or `Project/folder/` (used to move/delete whole folders). */
  async listUnder(owner: Owner, relPrefix: string): Promise<FileVersion[]> {
    const root = `${owner}/`;
    const { objects } = await this.listAll(objectKey(owner, `${relPrefix}/`));
    return objects.map((o) => ({ path: o.key.slice(root.length), size: o.size, uploaded: o.uploaded.toISOString(), etag: o.etag }));
  }

  async readVersion(owner: Owner, rel: string): Promise<(FileVersion & { content: string }) | null> {
    const obj = await this.bucket.get(objectKey(owner, rel));
    if (!obj) return null;
    return { path: rel, size: obj.size, uploaded: obj.uploaded.toISOString(), etag: obj.etag, content: await obj.text() };
  }

  /**
   * Write for the user's own clients. `ifMatch` makes the write conditional on
   * the etag the client last saw, so an editor never silently clobbers an agent.
   */
  async save(
    owner: Owner,
    rel: string,
    content: string,
    opts: { overwrite: boolean; ifMatch?: string },
  ): Promise<{ action: WriteAction; file: FileVersion }> {
    assertSize(content);
    const key = objectKey(owner, rel);
    const exists = (await this.bucket.head(key)) !== null;
    if (exists && !opts.overwrite) throw new PathError(`File already exists: ${rel}`);
    const put = await this.bucket.put(key, content, {
      httpMetadata: { contentType: MARKDOWN_TYPE },
      ...(opts.ifMatch ? { onlyIf: { etagMatches: opts.ifMatch } } : {}),
    });
    if (!put) throw new ConflictError(`File was modified by someone else: ${rel}`);
    return {
      action: exists ? 'UPDATE' : 'CREATE',
      file: { path: rel, size: put.size, uploaded: put.uploaded.toISOString(), etag: put.etag },
    };
  }

  /** Raw object for an attachment download (bytes, etag, size). */
  async readBlob(owner: Owner, rel: string): Promise<R2ObjectBody | null> {
    return this.bucket.get(objectKey(owner, rel));
  }

  /** Binary twin of `save`: same overwrite/ifMatch semantics. The content type comes from the path, never the client. */
  async saveBlob(
    owner: Owner,
    rel: string,
    bytes: ArrayBuffer,
    contentType: string,
    opts: { overwrite: boolean; ifMatch?: string },
  ): Promise<{ action: WriteAction; file: FileVersion }> {
    if (bytes.byteLength > MAX_ATTACHMENT_BYTES) throw new PathError(`File too large (max ${MAX_ATTACHMENT_BYTES} bytes)`);
    const key = objectKey(owner, rel);
    const exists = (await this.bucket.head(key)) !== null;
    if (exists && !opts.overwrite) throw new PathError(`File already exists: ${rel}`);
    const put = await this.bucket.put(key, bytes, {
      httpMetadata: { contentType },
      ...(opts.ifMatch ? { onlyIf: { etagMatches: opts.ifMatch } } : {}),
    });
    if (!put) throw new ConflictError(`File was modified by someone else: ${rel}`);
    return {
      action: exists ? 'UPDATE' : 'CREATE',
      file: { path: rel, size: put.size, uploaded: put.uploaded.toISOString(), etag: put.etag },
    };
  }

  /** Byte-exact copy (notes and attachments alike). Returns false when the source is gone. */
  async copy(owner: Owner, src: string, dest: string, contentType: string): Promise<boolean> {
    const obj = await this.bucket.get(objectKey(owner, src));
    if (!obj) return false;
    await this.bucket.put(objectKey(owner, dest), await obj.arrayBuffer(), { httpMetadata: { contentType } });
    return true;
  }

  async read(owner: Owner, rel: string): Promise<string | null> {
    const obj = await this.bucket.get(objectKey(owner, rel));
    return obj ? obj.text() : null;
  }

  async write(owner: Owner, rel: string, content: string, overwrite: boolean): Promise<WriteAction> {
    assertSize(content);
    const key = objectKey(owner, rel);
    const exists = (await this.bucket.head(key)) !== null;
    if (exists && !overwrite) throw new PathError(`File already exists: ${rel} (set overwrite=true to replace it)`);
    await this.bucket.put(key, content, { httpMetadata: { contentType: MARKDOWN_TYPE } });
    return exists ? 'UPDATE' : 'CREATE';
  }

  /**
   * Atomic append: read-modify-write guarded by the object's etag, so two agents
   * appending to checklist.md at the same time cannot overwrite each other.
   */
  async append(owner: Owner, rel: string, addition: string): Promise<WriteAction> {
    const key = objectKey(owner, rel);
    for (let i = 0; i < APPEND_RETRIES; i++) {
      const current = await this.bucket.get(key);
      const base = current ? await current.text() : '';
      const sep = base === '' || base.endsWith('\n') ? '' : '\n';
      const next = `${base}${sep}${addition}`;
      assertSize(next);
      const put = await this.bucket.put(key, next, {
        httpMetadata: { contentType: MARKDOWN_TYPE },
        ...(current ? { onlyIf: { etagMatches: current.etag } } : {}),
      });
      if (put) return current ? 'UPDATE' : 'CREATE';
    }
    throw new Error('Concurrent modification, please retry');
  }

  /**
   * Atomic read-modify-write of an existing file, guarded by its etag.
   * `fn` may throw to abort. Returns false when the file does not exist.
   */
  async modify(owner: Owner, rel: string, fn: (content: string) => string): Promise<boolean> {
    const key = objectKey(owner, rel);
    for (let i = 0; i < APPEND_RETRIES; i++) {
      const current = await this.bucket.get(key);
      if (!current) return false;
      const next = fn(await current.text());
      assertSize(next);
      const put = await this.bucket.put(key, next, {
        httpMetadata: { contentType: MARKDOWN_TYPE },
        onlyIf: { etagMatches: current.etag },
      });
      if (put) return true;
    }
    throw new Error('Concurrent modification, please retry');
  }

  /** Deletes every file of the project (notes, attachments, index). Returns how many were removed. */
  async deleteProject(owner: Owner, project: string): Promise<number> {
    const files = await this.listUnder(owner, project);
    if (files.length > MAX_BATCH) throw new PathError(`Project too large (max ${MAX_BATCH} files)`);
    for (const f of files) await this.bucket.delete(objectKey(owner, f.path));
    return files.length;
  }

  /**
   * R2 has no rename: copy every file under the new prefix, then delete the old ones.
   * The generated index stays behind and is rebuilt for the new name.
   */
  async renameProject(owner: Owner, from: string, to: string): Promise<number> {
    const files = (await this.listUnder(owner, from)).filter((f) => f.path.toLowerCase() !== `${from}/index.md`.toLowerCase());
    if (files.length === 0) throw new PathError(`Project not found: ${from}`);
    if (files.length > MAX_BATCH) throw new PathError(`Project too large (max ${MAX_BATCH} files)`);
    if ((await this.listUnder(owner, to)).length > 0) throw new PathError(`Project already exists: ${to}`);
    for (const f of files) {
      const obj = await this.bucket.get(objectKey(owner, f.path));
      if (!obj) continue;
      await this.bucket.put(objectKey(owner, `${to}${f.path.slice(from.length)}`), await obj.arrayBuffer(), {
        httpMetadata: { contentType: obj.httpMetadata?.contentType },
      });
    }
    for (const f of files) await this.bucket.delete(objectKey(owner, f.path));
    await this.bucket.delete(objectKey(owner, `${from}/index.md`));
    await this.compileIndex(owner, to);
    return files.length;
  }

  /**
   * Moves a whole project from one owner to another (a personal space into a team).
   * R2 has no rename: copy every file, then delete the originals. The generated index
   * stays behind and is rebuilt for the destination.
   */
  async transferProject(from: Owner, to: Owner, project: string): Promise<number> {
    const files = (await this.listUnder(from, project)).filter((f) => f.path.toLowerCase() !== `${project}/index.md`.toLowerCase());
    if (files.length === 0) throw new PathError(`Project not found: ${project}`);
    if (files.length > MAX_BATCH) throw new PathError(`Project too large (max ${MAX_BATCH} files)`);
    if ((await this.listUnder(to, project)).length > 0) throw new PathError(`Project already exists in the destination: ${project}`);
    for (const f of files) {
      const obj = await this.bucket.get(objectKey(from, f.path));
      if (!obj) continue;
      await this.bucket.put(objectKey(to, f.path), await obj.arrayBuffer(), { httpMetadata: { contentType: obj.httpMetadata?.contentType } });
    }
    for (const f of files) await this.bucket.delete(objectKey(from, f.path));
    await this.bucket.delete(objectKey(from, `${project}/index.md`));
    await this.compileIndex(to, project);
    return files.length;
  }

  async delete(owner: Owner, rel: string): Promise<boolean> {
    const key = objectKey(owner, rel);
    if ((await this.bucket.head(key)) === null) return false;
    await this.bucket.delete(key);
    return true;
  }

  /**
   * Regenerates `<project>/index.md` from the current file listing.
   * Removes it when the project has no other file left.
   *
   * Note: two concurrent writes can each compile from a slightly stale listing
   * (last writer wins). `POST /v1/projects/:project/reindex` repairs that.
   */
  async compileIndex(owner: Owner, project: string): Promise<void> {
    // Notes only: attachments are reached through the notes that embed them.
    const files = (await this.listFiles(owner, project)).filter((f) => isMarkdown(f.path) && f.path.toLowerCase() !== 'index.md');
    const key = objectKey(owner, `${project}/index.md`);
    if (files.length === 0) {
      await this.bucket.delete(key);
      return;
    }
    await this.bucket.put(key, renderIndex(project, files), {
      httpMetadata: { contentType: MARKDOWN_TYPE },
      customMetadata: { generated: 'true' },
    });
  }
}

function assertSize(content: string): void {
  if (new TextEncoder().encode(content).byteLength > MAX_FILE_BYTES) {
    throw new PathError(`File too large (max ${MAX_FILE_BYTES} bytes)`);
  }
}

export function renderIndex(project: string, files: FileInfo[]): string {
  const lines = [
    `# ${project}`,
    '',
    '> Auto-generated by Lore LLM. Read-only: changes are overwritten.',
    '',
  ];
  const byFolder = new Map<string, FileInfo[]>();
  for (const f of files) {
    const i = f.path.lastIndexOf('/');
    const folder = i === -1 ? '' : f.path.slice(0, i);
    byFolder.set(folder, [...(byFolder.get(folder) ?? []), f]);
  }
  const folders = [...byFolder.keys()].sort((a, b) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)));
  for (const folder of folders) {
    if (folder !== '') lines.push('', `## ${folder}/`, '');
    for (const f of byFolder.get(folder)!) {
      const name = f.path.slice(f.path.lastIndexOf('/') + 1);
      lines.push(`- [${name}](${encodeURI(f.path)}) — ${f.size} B, updated ${f.uploaded.slice(0, 10)}`);
    }
  }
  return `${lines.join('\n')}\n`;
}
