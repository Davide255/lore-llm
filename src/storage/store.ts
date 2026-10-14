import { PathError, objectKey } from './paths';

export const MAX_FILE_BYTES = 1024 * 1024; // 1 MiB per markdown file
const APPEND_RETRIES = 4;

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

  /** Every file of the user, across all projects. */
  async listAllFiles(userId: string): Promise<FileVersion[]> {
    const root = `${userId}/`;
    const { objects } = await this.listAll(root);
    return objects
      .map((o) => ({ path: o.key.slice(root.length), size: o.size, uploaded: o.uploaded.toISOString(), etag: o.etag }))
      .sort((a, b) => a.path.localeCompare(b.path));
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
      httpMetadata: { contentType: 'text/markdown; charset=utf-8' },
      ...(opts.ifMatch ? { onlyIf: { etagMatches: opts.ifMatch } } : {}),
    });
    if (!put) throw new ConflictError(`File was modified by someone else: ${rel}`);
    return {
      action: exists ? 'UPDATE' : 'CREATE',
      file: { path: rel, size: put.size, uploaded: put.uploaded.toISOString(), etag: put.etag },
    };
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
    await this.bucket.put(key, content, { httpMetadata: { contentType: 'text/markdown; charset=utf-8' } });
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
        httpMetadata: { contentType: 'text/markdown; charset=utf-8' },
        ...(current ? { onlyIf: { etagMatches: current.etag } } : {}),
      });
      if (put) return current ? 'UPDATE' : 'CREATE';
    }
    throw new Error('Concurrent modification, please retry');
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
    const files = (await this.listFiles(userId, project)).filter((f) => f.path.toLowerCase() !== 'index.md');
    const key = objectKey(userId, `${project}/index.md`);
    if (files.length === 0) {
      await this.bucket.delete(key);
      return;
    }
    await this.bucket.put(key, renderIndex(project, files), {
      httpMetadata: { contentType: 'text/markdown; charset=utf-8' },
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
