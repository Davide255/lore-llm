-- Full-text search index over notes, per owner (a user's space or a team's).
-- R2 stays the source of truth: this is a derived copy, rebuilt from R2 on
-- demand (see src/db/searchIndex.ts), so it can be dropped and recreated at any time. Add-only.
CREATE TABLE note_index (
  id    INTEGER PRIMARY KEY,
  owner TEXT NOT NULL,   -- user id or t:<teamId>, as in the R2 key prefix
  tok   TEXT NOT NULL,   -- owner reduced to [A-Za-z0-9]: one FTS token that keeps a query inside its owner's rows
  path  TEXT NOT NULL,   -- Project/folder/file.md
  etag  TEXT NOT NULL,   -- R2 etag of the indexed version
  title TEXT NOT NULL,
  body  TEXT NOT NULL,
  UNIQUE (owner, path)
);

CREATE VIRTUAL TABLE note_fts USING fts5(
  tok, title, body, path,
  content = 'note_index', content_rowid = 'id',
  tokenize = 'unicode61 remove_diacritics 2',
  prefix = '2 3'
);

CREATE TRIGGER note_index_ai AFTER INSERT ON note_index BEGIN
  INSERT INTO note_fts (rowid, tok, title, body, path) VALUES (new.id, new.tok, new.title, new.body, new.path);
END;
CREATE TRIGGER note_index_ad AFTER DELETE ON note_index BEGIN
  INSERT INTO note_fts (note_fts, rowid, tok, title, body, path) VALUES ('delete', old.id, old.tok, old.title, old.body, old.path);
END;
CREATE TRIGGER note_index_au AFTER UPDATE ON note_index BEGIN
  INSERT INTO note_fts (note_fts, rowid, tok, title, body, path) VALUES ('delete', old.id, old.tok, old.title, old.body, old.path);
  INSERT INTO note_fts (rowid, tok, title, body, path) VALUES (new.id, new.tok, new.title, new.body, new.path);
END;
