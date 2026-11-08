import type { Owner } from '../storage/owner';
import { ftsTerms, snippetsFor, titleOf, type SearchHit } from '../storage/search';
import type { Store } from '../storage/store';

/**
 * Full-text index (D1 FTS5) over one owner's notes (a user's space or a team's).
 * R2 is the source of truth; the index is reconciled against the R2 listing
 * (path + etag, no body reads) at the start of every search, so it is correct no
 * matter which client, agent, folder operation or project transfer changed the
 * files. A first search over a large, never-indexed space indexes at most
 * MAX_INDEX_PER_SEARCH notes and says so (`truncated`); the following searches
 * continue. The caller must already have checked read access to `owner`.
 */
export const MAX_INDEX_PER_SEARCH = 100;
const READ_CONCURRENCY = 10;
const SNIPPET_SOURCE_CHARS = 65536; // snippets come from the head of the note
const MAX_LIMIT = 100;

const tokenOf = (owner: Owner) => owner.replace(/[^A-Za-z0-9]/g, '');

export interface SearchResult {
  hits: SearchHit[];
  /** Notes in the index for this owner. */
  scanned: number;
  /** True while some notes are still waiting to be indexed: results may be incomplete. */
  truncated: boolean;
}

/** Brings the owner's rows in line with R2. Returns how many notes are still unindexed. */
export async function reconcileIndex(db: D1Database, store: Store, owner: Owner): Promise<number> {
  const listed = (await store.listAllFiles(owner)).filter((f) => f.path.includes('/') && !/(^|\/)index\.md$/i.test(f.path));
  const { results } = await db.prepare('SELECT path, etag FROM note_index WHERE owner = ?').bind(owner).all<{ path: string; etag: string }>();
  const indexed = new Map(results.map((r) => [r.path, r.etag]));
  const live = new Set(listed.map((f) => f.path));

  for (const path of indexed.keys()) {
    if (!live.has(path)) await db.prepare('DELETE FROM note_index WHERE owner = ? AND path = ?').bind(owner, path).run();
  }

  const todo = listed.filter((f) => indexed.get(f.path) !== f.etag);
  const batch = todo.slice(0, MAX_INDEX_PER_SEARCH);
  const tok = tokenOf(owner);
  for (let i = 0; i < batch.length; i += READ_CONCURRENCY) {
    await Promise.all(
      batch.slice(i, i + READ_CONCURRENCY).map(async (f) => {
        const note = await store.readVersion(owner, f.path);
        if (!note) return; // deleted meanwhile; the next reconcile drops it
        await db
          .prepare(
            'INSERT INTO note_index (owner, tok, path, etag, title, body) VALUES (?, ?, ?, ?, ?, ?) ' +
              'ON CONFLICT (owner, path) DO UPDATE SET etag = excluded.etag, title = excluded.title, body = excluded.body',
          )
          .bind(owner, tok, f.path, note.etag, titleOf(f.path, note.content), note.content)
          .run();
      }),
    );
  }
  return todo.length - batch.length;
}

export async function searchNotes(
  db: D1Database,
  store: Store,
  owner: Owner,
  terms: string[],
  opts: { project?: string; limit?: number } = {},
): Promise<SearchResult> {
  const pending = await reconcileIndex(db, store, owner);
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), MAX_LIMIT);
  const prefix = opts.project ? `${opts.project}/` : '';
  const match = `tok:"${tokenOf(owner)}" AND (${ftsTerms(terms)})`;

  const { results } = await db
    .prepare(
      `SELECT n.path AS path, substr(n.body, 1, ${SNIPPET_SOURCE_CHARS}) AS head, -bm25(note_fts, 0, 5, 1, 3) AS score ` +
        'FROM note_fts JOIN note_index n ON n.id = note_fts.rowid ' +
        'WHERE note_fts MATCH ? AND n.owner = ? AND substr(n.path, 1, ?) = ? ' +
        'ORDER BY score DESC, n.path LIMIT ?',
    )
    .bind(match, owner, prefix.length, prefix, limit)
    .all<{ path: string; head: string; score: number }>();

  const hits: SearchHit[] = results.map((r) => {
    const lowerPath = r.path.toLowerCase();
    return {
      path: r.path,
      score: Math.round(r.score * 100) / 100,
      pathMatch: terms.some((t) => lowerPath.includes(t)),
      snippets: snippetsFor(r.head, terms),
    };
  });
  const count = await db.prepare('SELECT COUNT(*) AS n FROM note_index WHERE owner = ?').bind(owner).first<{ n: number }>();
  return { hits, scanned: count?.n ?? 0, truncated: pending > 0 };
}

/** Drops an owner's index (account or team deletion); it rebuilds on the next search. */
export async function clearIndex(db: D1Database, owner: Owner): Promise<void> {
  await db.prepare('DELETE FROM note_index WHERE owner = ?').bind(owner).run();
}
