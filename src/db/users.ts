const REFRESH_MS = 24 * 60 * 60 * 1000;

/**
 * Directory of people seen by the API, so teammates can be invited by email.
 * Only ID tokens carry email and name; an access token never blanks stored values.
 * Rows are rewritten only when something changed or after a day, not on every request.
 */
export async function upsertUser(db: D1Database, user: { userId: string; email?: string; name?: string }): Promise<void> {
  await db
    .prepare(
      'INSERT INTO users (id, email, name, updated_at) VALUES (?, ?, ?, ?) ' +
        'ON CONFLICT (id) DO UPDATE SET email = COALESCE(excluded.email, email), name = COALESCE(excluded.name, name), updated_at = excluded.updated_at ' +
        'WHERE users.updated_at < ? OR (excluded.email IS NOT NULL AND users.email IS NOT excluded.email) ' +
        'OR (excluded.name IS NOT NULL AND users.name IS NOT excluded.name)',
    )
    .bind(
      user.userId,
      user.email?.trim().toLowerCase() ?? null,
      user.name ?? null,
      new Date().toISOString(),
      new Date(Date.now() - REFRESH_MS).toISOString(),
    )
    .run();
}
