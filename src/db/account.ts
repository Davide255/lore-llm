/**
 * Removes every D1 row that belongs to a user: agents (and the OAuth codes and
 * refresh tokens issued to them), the audit log, in-flight OAuth requests and
 * the change cursor. Idempotent.
 */
export async function deleteUserRows(db: D1Database, userId: string): Promise<void> {
  const agents = 'SELECT agent_id FROM permissions WHERE user_id = ?';
  await db.prepare(`DELETE FROM oauth_refresh_tokens WHERE agent_id IN (${agents})`).bind(userId).run();
  await db.prepare(`DELETE FROM oauth_codes WHERE agent_id IN (${agents})`).bind(userId).run();
  await db.prepare('DELETE FROM oauth_requests WHERE user_id = ?').bind(userId).run();
  await db.prepare('DELETE FROM audit_logs WHERE user_id = ?').bind(userId).run();
  await db.prepare('DELETE FROM permissions WHERE user_id = ?').bind(userId).run();
  await db.prepare('DELETE FROM space_versions WHERE user_id = ?').bind(userId).run();
}
