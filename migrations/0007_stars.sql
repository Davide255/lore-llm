-- Starred notes ("Starred" section in the apps). Per user, across the spaces
-- they can read (their own and their teams'), by path. See src/db/stars.ts. Add-only.
CREATE TABLE starred (
  user_id    TEXT NOT NULL,
  owner      TEXT NOT NULL,  -- user id or t:<teamId>
  path       TEXT NOT NULL,  -- Project/folder/file.md
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, owner, path)
);
