import type { AccessLevel } from '../env';

export interface PermissionRow {
  agent_id: string;
  user_id: string;
  name: string;
  project_scope: string;
  access_level: AccessLevel;
  created_at: string;
}

export async function getAgent(db: D1Database, agentId: string): Promise<PermissionRow | null> {
  return db.prepare('SELECT * FROM permissions WHERE agent_id = ?').bind(agentId).first<PermissionRow>();
}

export async function createAgent(db: D1Database, row: PermissionRow): Promise<void> {
  await db
    .prepare(
      'INSERT INTO permissions (agent_id, user_id, name, project_scope, access_level, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .bind(row.agent_id, row.user_id, row.name, row.project_scope, row.access_level, row.created_at)
    .run();
}

export async function listAgents(db: D1Database, userId: string): Promise<PermissionRow[]> {
  const res = await db
    .prepare('SELECT * FROM permissions WHERE user_id = ? ORDER BY created_at DESC')
    .bind(userId)
    .all<PermissionRow>();
  return res.results;
}

/** Scoped by user_id: a user can never touch another user's agent. Returns false when no row matched. */
export async function updateAgent(
  db: D1Database,
  userId: string,
  agentId: string,
  patch: { project_scope?: string; access_level?: AccessLevel; name?: string },
): Promise<boolean> {
  const res = await db
    .prepare(
      `UPDATE permissions SET
         project_scope = COALESCE(?, project_scope),
         access_level  = COALESCE(?, access_level),
         name          = COALESCE(?, name)
       WHERE agent_id = ? AND user_id = ?`,
    )
    .bind(patch.project_scope ?? null, patch.access_level ?? null, patch.name ?? null, agentId, userId)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

export async function deleteAgent(db: D1Database, userId: string, agentId: string): Promise<boolean> {
  const res = await db.prepare('DELETE FROM permissions WHERE agent_id = ? AND user_id = ?').bind(agentId, userId).run();
  return (res.meta.changes ?? 0) > 0;
}
