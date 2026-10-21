import type { Owner } from '../storage/owner';

/**
 * Change cursor for an owner's files (a user or a team). A single D1 row per owner lets
 * clients detect any change (theirs, another device's, an agent's) with one
 * cheap read instead of re-listing R2.
 */
// `space_versions.user_id` holds the owner key (a user id, or `t:<teamId>`).
export async function bumpVersion(db: D1Database, owner: Owner): Promise<void> {
  await db
    .prepare(
      'INSERT INTO space_versions (user_id, version, updated_at) VALUES (?, 1, ?) ' +
        'ON CONFLICT (user_id) DO UPDATE SET version = version + 1, updated_at = excluded.updated_at',
    )
    .bind(owner, new Date().toISOString())
    .run();
}

export async function getVersion(db: D1Database, owner: Owner): Promise<{ version: number; updated_at: string | null }> {
  const row = await db
    .prepare('SELECT version, updated_at FROM space_versions WHERE user_id = ?')
    .bind(owner)
    .first<{ version: number; updated_at: string }>();
  return row ?? { version: 0, updated_at: null };
}

/** Cursors of several owners at once (a user's personal space plus their teams). Owners never changed report version 0. */
export async function getVersions(db: D1Database, owners: Owner[]): Promise<Record<string, { version: number; updated_at: string | null }>> {
  const out: Record<string, { version: number; updated_at: string | null }> = {};
  for (const o of owners) out[o] = { version: 0, updated_at: null };
  if (owners.length === 0) return out;
  const res = await db
    .prepare(`SELECT user_id, version, updated_at FROM space_versions WHERE user_id IN (${owners.map(() => '?').join(',')})`)
    .bind(...owners)
    .all<{ user_id: string; version: number; updated_at: string }>();
  for (const r of res.results) out[r.user_id] = { version: r.version, updated_at: r.updated_at };
  return out;
}
