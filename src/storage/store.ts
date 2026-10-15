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
  /** Path inside the user's root: `Project/folder/file.md`. */
  path: string;
  size: number;
  uploaded: string;
  etag: string;
}

/** Thrown when an `ifMatch` precondition fails: someone else changed the file meanwhile. */
export class ConflictError extends Error {}

/** All R2 access for one deployment. Methods take `userId` and add the tenant prefix themselves. */
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

  async listProjects(userId: string): Promise<string[]> {
    const root = `${userId}/`;
    const { prefixes } = await this.listAll(root, '/');
    return prefixes.map((p) => p.slice(root.length, -1)).sort();
  }

  async listFiles(userId: string, project: string, folder = ''): Promise<FileInfo[]> {
    const base = objectKey(userId, `${project}/`);
    const { objects } = await this.listAll(folder ? `${base}${folder}/` : base);
    return objects
      .map((o) => ({ path: o.key.slice(base.length), size: o.size, uploaded: o.uploaded.toISOString() }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  /**
   * Every file of the user, across all projects. Attachments are listed only on
   * request: older clients assume every listed file is a readable note.
   */
  async listAllFiles(userId: string, opts: { attachments?: boolean } = {}): Promise<FileVersion[]> {
    const root = `${userId}/`;
    const { objects } = await this.listAll(root);
    return objects
      .filter((o) => opts.attachments || isMarkdown(o.key))
      .map((o) => ({ path: o.key.slice(root.length), size: o.size, uploaded: o.uploaded.toISOString(), etag: o.etag }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  async exists(userId: string, rel: string): Promise<boolean> {
    return (await this.bucket.head(objectKey(userId, rel))) !== null;
  }

  /** Files under `Project/` or `Project/folder/` (used to move/delete whole folders). */
  async listUnder(userId: string, relPrefix: string): Promise<FileVersion[]> {
    const root = `${userId}/`;
    const { objects } = await this.listAll(objectKey(userId, `${relPrefix}/`));
    return objects.map((o) => ({ path: o.key.slice(root.length), size: o.size, uploaded: o.uploaded.toISOString(), etag: o.etag }));
  }

  async readVersion(userId: string, rel: string): Promise<(FileVersion & { content: string }) | null> {
    const obj = await this.bucket.get(objectKey(userId, rel));
    if (!obj) return null;
    return { path: rel, size: obj.size, uploaded: obj.uploaded.toISOString(), etag: obj.etag, content: await obj.text() };
  }

  /**
   * Write for the user's own clients. `ifMatch` makes the write conditional on
   * the etag the client last saw, so an editor never silently clobbers an agent.
   */
  async save(
    userId: string,
    rel: string,
    content: string,
    opts: { overwrite: boolean; ifMatch?: string },
  ): Promise<{ action: WriteAction; file: FileVersion }> {
    assertSize(content);
    const key = objectKey(userId, rel);
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
  async readBlob(userId: string, rel: string): Promise<R2ObjectBody | null> {
    return this.bucket.get(objectKey(userId, rel));
  }

  /** Binary twin of `save`: same overwrite/ifMatch semantics. The content type comes from the path, never the client. */
  async saveBlob(
    userId: string,
    rel: string,
    bytes: ArrayBuffer,
    contentType: string,
    opts: { overwrite: boolean; ifMatch?: string },
  ): Promise<{ action: WriteAction; file: FileVersion }> {
    if (bytes.byteLength > MAX_ATTACHMENT_BYTES) throw new PathError(`File too large (max ${MAX_ATTACHMENT_BYTES} bytes)`);
    const key = objectKey(userId, rel);
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
  async copy(userId: string, src: string, dest: string, contentType: string): Promise<boolean> {
    const obj = await this.bucket.get(objectKey(userId, src));
    if (!obj) return false;
    await this.bucket.put(objectKey(userId, dest), await obj.arrayBuffer(), { httpMetadata: { contentType } });
    return true;
  }

  async read(userId: string, rel: string): Promise<string | null> {
    const obj = await this.bucket.get(objectKey(userId, rel));
    return obj ? obj.text() : null;
  }

  async write(userId: string, rel: string, content: string, overwrite: boolean): Promise<WriteAction> {
    assertSize(content);
    const key = objectKey(userId, rel);
    const exists = (await this.bucket.head(key)) !== null;
    if (exists && !overwrite) throw new PathError(`File already exists: ${rel} (set overwrite=true to replace it)`);
    await this.bucket.put(key, content, { httpMetadata: { contentType: MARKDOWN_TYPE } });
    return exists ? 'UPDATE' : 'CREATE';
  }

  /**
   * Atomic append: read-modify-write guarded by the object's etag, so two agents
   * appending to checklist.md at the same time cannot overwrite each other.
   */
  async append(userId: string, rel: string, addition: string): Promise<WriteAction> {
    const key = objectKey(userId, rel);
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
  async modify(userId: string, rel: string, fn: (content: string) => string): Promise<boolean> {
    const key = objectKey(userId, rel);
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
  async deleteProject(userId: string, project: string): Promise<number> {
    const files = await this.listUnder(userId, project);
    if (files.length > MAX_BATCH) throw new PathError(`Project too large (max ${MAX_BATCH} files)`);
    for (const f of files) await this.bucket.delete(objectKey(userId, f.path));
    return files.length;
  }

  /**
   * R2 has no rename: copy every file under the new prefix, then delete the old ones.
   * The generated index stays behind and is rebuilt for the new name.
   */
  async renameProject(userId: string, from: string, to: string): Promise<number> {
    const files = (await this.listUnder(userId, from)).filter((f) => f.path.toLowerCase() !== `${from}/index.md`.toLowerCase());
    if (files.length === 0) throw new PathError(`Project not found: ${from}`);
    if (files.length > MAX_BATCH) throw new PathError(`Project too large (max ${MAX_BATCH} files)`);
    if ((await this.listUnder(userId, to)).length > 0) throw new PathError(`Project already exists: ${to}`);
    for (const f of files) {
      const obj = await this.bucket.get(objectKey(userId, f.path));
      if (!obj) continue;
      await this.bucket.put(objectKey(userId, `${to}${f.path.slice(from.length)}`), await obj.arrayBuffer(), {
        httpMetadata: { contentType: obj.httpMetadata?.contentType },
      });
    }
    for (const f of files) await this.bucket.delete(objectKey(userId, f.path));
    await this.bucket.delete(objectKey(userId, `${from}/index.md`));
    await this.compileIndex(userId, to);
    return files.length;
  }

  async delete(userId: string, rel: string): Promise<boolean> {
    const key = objectKey(userId, rel);
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
  async compileIndex(userId: string, project: string): Promise<void> {
    // Notes only: attachments are reached through the notes that embed them.
    const files = (await this.listFiles(userId, project)).filter((f) => isMarkdown(f.path) && f.path.toLowerCase() !== 'index.md');
    const key = objectKey(userId, `${project}/index.md`);
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
