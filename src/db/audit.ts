export type AuditAction = 'CREATE' | 'UPDATE' | 'DELETE';

export interface AuditRow {
  log_id: number;
  timestamp: string;
  user_id: string;
  agent_id: string;
  action: AuditAction;
  target_path: string;
}

export async function insertAudit(
  db: D1Database,
  entry: { userId: string; agentId: string; action: AuditAction; targetPath: string },
): Promise<void> {
  await db
    .prepare('INSERT INTO audit_logs (timestamp, user_id, agent_id, action, target_path) VALUES (?, ?, ?, ?, ?)')
    .bind(new Date().toISOString(), entry.userId, entry.agentId, entry.action, entry.targetPath)
    .run();
}

/** Keyset pagination on log_id (newest first). Always filtered by user_id. */
export async function listAudit(
  db: D1Database,
  userId: string,
  opts: { limit: number; before?: number; agentId?: string; project?: string },
): Promise<AuditRow[]> {
  const where = ['user_id = ?'];
  const args: unknown[] = [userId];
  if (opts.before !== undefined) {
    where.push('log_id < ?');
    args.push(opts.before);
  }
  if (opts.agentId) {
    where.push('agent_id = ?');
    args.push(opts.agentId);
  }
  if (opts.project) {
    where.push("target_path LIKE ? ESCAPE '\\'");
    args.push(`${opts.project.replace(/[\\%_]/g, '\\$&')}/%`);
  }
  const res = await db
    .prepare(`SELECT * FROM audit_logs WHERE ${where.join(' AND ')} ORDER BY log_id DESC LIMIT ?`)
    .bind(...args, opts.limit)
    .all<AuditRow>();
  return res.results;
}
