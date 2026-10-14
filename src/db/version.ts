/**
 * Change cursor for a user's knowledge base. A single D1 row per user lets
 * clients detect any change (theirs, another device's, an agent's) with one
 * cheap read instead of re-listing R2.
 */
export async function bumpVersion(db: D1Database, userId: string): Promise<void> {
  await db
    .prepare(
      'INSERT INTO space_versions (user_id, version, updated_at) VALUES (?, 1, ?) ' +
        'ON CONFLICT (user_id) DO UPDATE SET version = version + 1, updated_at = excluded.updated_at',
    )
    .bind(userId, new Date().toISOString())
    .run();
}

export async function getVersion(db: D1Database, userId: string): Promise<{ version: number; updated_at: string | null }> {
  const row = await db
    .prepare('SELECT version, updated_at FROM space_versions WHERE user_id = ?')
    .bind(userId)
    .first<{ version: number; updated_at: string }>();
  return row ?? { version: 0, updated_at: null };
}
