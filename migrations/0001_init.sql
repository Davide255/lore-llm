-- Agent permissions. One row per agent. Deleting the row revokes the agent
-- immediately (the token is only valid while its row exists).
CREATE TABLE permissions (
  agent_id      TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  name          TEXT NOT NULL,
  -- '*' or 'Project/*'; comma-separated list allowed ('A/*,B/*')
  project_scope TEXT NOT NULL,
  access_level  TEXT NOT NULL CHECK (access_level IN ('read_only', 'read_write')),
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_permissions_user ON permissions (user_id);

-- Audit log of every file modification made by an agent.
-- No foreign key on purpose: logs must outlive a revoked agent.
CREATE TABLE audit_logs (
  log_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp   TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  agent_id    TEXT NOT NULL,
  action      TEXT NOT NULL CHECK (action IN ('CREATE', 'UPDATE', 'DELETE')),
  target_path TEXT NOT NULL
);
CREATE INDEX idx_audit_user_log ON audit_logs (user_id, log_id DESC);
