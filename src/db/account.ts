/**
 * Removes every D1 row that belongs to a user: agents (and the OAuth codes and
 * refresh tokens issued to them), the audit log, in-flight OAuth requests, the
 * change cursor, and their place in teams: memberships, invites sent or
 * addressed to their email, shares given or received and the directory entry.
 * Teams they solely own are checked first (`soleOwnedTeams`). Idempotent.
 */
/** Teams where the user is the only owner: deleting them would orphan the team's files. */
export async function soleOwnedTeams(db: D1Database, userId: string): Promise<string[]> {
  const res = await db
    .prepare(
      "SELECT m.team_id FROM team_members m WHERE m.user_id = ? AND m.role = 'owner' " +
        "AND (SELECT COUNT(*) FROM team_members o WHERE o.team_id = m.team_id AND o.role = 'owner') = 1",
    )
    .bind(userId)
    .all<{ team_id: string }>();
  return res.results.map((r) => r.team_id);
}

export async function deleteUserRows(db: D1Database, userId: string): Promise<void> {
  const agents = 'SELECT agent_id FROM permissions WHERE user_id = ?';
  await db.prepare(`DELETE FROM oauth_refresh_tokens WHERE agent_id IN (${agents})`).bind(userId).run();
  await db.prepare(`DELETE FROM oauth_codes WHERE agent_id IN (${agents})`).bind(userId).run();
  await db.prepare('DELETE FROM oauth_requests WHERE user_id = ?').bind(userId).run();
  await db.prepare('DELETE FROM audit_logs WHERE user_id = ?').bind(userId).run();
  await db.prepare('DELETE FROM permissions WHERE user_id = ?').bind(userId).run();
  await db.prepare('DELETE FROM space_versions WHERE user_id = ?').bind(userId).run();
  const email = 'SELECT email FROM users WHERE id = ?';
  await db.prepare(`DELETE FROM invites WHERE invited_by = ? OR email = (${email})`).bind(userId, userId).run();
  await db.prepare('DELETE FROM shares WHERE created_by = ? OR grantee_user_id = ?').bind(userId, userId).run();
  await db.prepare('DELETE FROM team_members WHERE user_id = ?').bind(userId).run();
  await db.prepare('DELETE FROM users WHERE id = ?').bind(userId).run();
}
