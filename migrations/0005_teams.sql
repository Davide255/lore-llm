-- Teams and sharing. Add-only: nothing here changes existing tables.

-- Directory of people seen by the API (from the verified token), so teammates
-- can be invited by email.
CREATE TABLE users (
  id         TEXT PRIMARY KEY,
  email      TEXT,
  name       TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX users_email ON users (email);

CREATE TABLE teams (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE team_members (
  team_id   TEXT NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
  user_id   TEXT NOT NULL,
  role      TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
  joined_at TEXT NOT NULL,
  PRIMARY KEY (team_id, user_id)
);
CREATE INDEX team_members_user ON team_members (user_id);

-- Pending invitations by email: either to join a team (path IS NULL) or to
-- access one item of an owner's files.
CREATE TABLE invites (
  id         TEXT PRIMARY KEY,
  team_id    TEXT REFERENCES teams (id) ON DELETE CASCADE,
  owner      TEXT,
  path       TEXT,
  email      TEXT NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
  invited_by TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined', 'revoked')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX invites_email ON invites (email, status);

-- Access to a project, folder or file (`path` = `Project[/folder/file.md]`) of an owner.
CREATE TABLE shares (
  id              TEXT PRIMARY KEY,
  owner           TEXT NOT NULL,
  path            TEXT NOT NULL,
  grantee_user_id TEXT NOT NULL,
  role            TEXT NOT NULL CHECK (role IN ('editor', 'viewer')),
  created_by      TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  UNIQUE (owner, path, grantee_user_id)
);
CREATE INDEX shares_grantee ON shares (grantee_user_id);
