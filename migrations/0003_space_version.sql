-- One counter per user, bumped on every change to their files (by the user's
-- own clients or by an agent). Clients poll it to know when to re-list.
CREATE TABLE space_versions (
  user_id    TEXT PRIMARY KEY,
  version    INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
