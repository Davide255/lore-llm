import type { Owner } from '../storage/owner';
import type { Store } from '../storage/store';

/**
 * Starred notes: per user, across the spaces they can read (their own and their
 * teams'). R2 object metadata would be lost on every overwrite or move, so stars
 * live in D1, keyed by (owner, path).
 *
 * Keeping them true: moves made through the files API carry the star along
 * (`moveStars`); every listing prunes stars whose note no longer exists
 * (`pruneStars`, one R2 listing per starred owner), which covers deletes by
 * clients, agents, project deletes and team transfers alike. Stars of a team the
 * user left are hidden by the query, and deleted with the account.
 */
export interface Star {
  owner: Owner;
  path: string;
  starred_at: string;
}

export const MAX_STARS = 500;

/** Stars the user can still see: their own space, or a team they belong to. */
const VISIBLE =
  "user_id = ? AND (owner = ? OR owner IN (SELECT 't:' || team_id FROM team_members WHERE user_id = ?))";

export async function listStars(db: D1Database, store: Store, userId: string): Promise<Star[]> {
  const rows = await readStars(db, userId);
  const owners = [...new Set(rows.map((r) => r.owner))];
  const dead = new Set<string>();
  for (const owner of owners) {
    const live = new Set((await store.listAllFiles(owner)).map((f) => f.path));
    for (const r of rows) if (r.owner === owner && !live.has(r.path)) dead.add(`${r.owner}\0${r.path}`);
  }
  for (const key of dead) {
    const [owner, path] = key.split('\0') as [string, string];
    await db.prepare('DELETE FROM starred WHERE user_id = ? AND owner = ? AND path = ?').bind(userId, owner, path).run();
  }
  return rows.filter((r) => !dead.has(`${r.owner}\0${r.path}`));
}

async function readStars(db: D1Database, userId: string): Promise<Star[]> {
  const { results } = await db
    .prepare(`SELECT owner, path, created_at AS starred_at FROM starred WHERE ${VISIBLE} ORDER BY created_at DESC, path`)
    .bind(userId, userId, userId)
    .all<Star>();
  return results;
}

/** Idempotent. Returns false when the user is at the star limit. */
export async function addStar(db: D1Database, userId: string, owner: Owner, path: string): Promise<boolean> {
  const count = await db.prepare('SELECT COUNT(*) AS n FROM starred WHERE user_id = ?').bind(userId).first<{ n: number }>();
  const already = await db.prepare('SELECT 1 AS x FROM starred WHERE user_id = ? AND owner = ? AND path = ?').bind(userId, owner, path).first();
  if (!already && (count?.n ?? 0) >= MAX_STARS) return false;
  await db
    .prepare('INSERT INTO starred (user_id, owner, path, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (user_id, owner, path) DO NOTHING')
    .bind(userId, owner, path, new Date().toISOString())
    .run();
  return true;
}

export async function unstar(db: D1Database, userId: string, owner: Owner, path: string): Promise<boolean> {
  const r = await db.prepare('DELETE FROM starred WHERE user_id = ? AND owner = ? AND path = ?').bind(userId, owner, path).run();
  return (r.meta?.changes ?? 0) > 0;
}

/** A file moved from `from` to `to`, or a folder `from/` to `to/`, inside one owner: every user's stars follow. */
export async function moveStars(db: D1Database, owner: Owner, from: string, to: string, isFile: boolean): Promise<void> {
  if (isFile) {
    await db.prepare('UPDATE starred SET path = ? WHERE owner = ? AND path = ?').bind(to, owner, from).run();
    return;
  }
  const src = `${from}/`;
  await db
    .prepare('UPDATE starred SET path = ? || substr(path, ?) WHERE owner = ? AND substr(path, 1, ?) = ?')
    .bind(`${to}/`, src.length + 1, owner, src.length, src)
    .run();
}

/** Account deletion: the user's stars, and every star on their own space. */
export async function deleteUserStars(db: D1Database, userId: string): Promise<void> {
  await db.prepare('DELETE FROM starred WHERE user_id = ? OR owner = ?').bind(userId, userId).run();
}

/** Team deletion: stars on the team's space. */
export async function deleteOwnerStars(db: D1Database, owner: Owner): Promise<void> {
  await db.prepare('DELETE FROM starred WHERE owner = ?').bind(owner).run();
}
