-- OAuth 2.1 authorization server for /mcp (dynamic client registration + auth code with PKCE).
-- Add-only. Codes and refresh tokens are stored as SHA-256 hashes, never in clear.

CREATE TABLE oauth_clients (
  client_id     TEXT PRIMARY KEY,
  client_name   TEXT NOT NULL,
  redirect_uris TEXT NOT NULL, -- JSON array
  created_at    INTEGER NOT NULL
);

-- An in-flight /authorize request, from the redirect to Cognito until the user consents.
CREATE TABLE oauth_requests (
  txn_id           TEXT PRIMARY KEY,
  client_id        TEXT NOT NULL,
  redirect_uri     TEXT NOT NULL,
  code_challenge   TEXT NOT NULL,
  state            TEXT,
  cognito_verifier TEXT NOT NULL,
  user_id          TEXT,
  csrf             TEXT,
  expires_at       INTEGER NOT NULL
);

CREATE TABLE oauth_codes (
  code_hash      TEXT PRIMARY KEY,
  client_id      TEXT NOT NULL,
  redirect_uri   TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  agent_id       TEXT NOT NULL,
  expires_at     INTEGER NOT NULL,
  used_at        INTEGER
);
CREATE INDEX idx_oauth_codes_agent ON oauth_codes (agent_id);

CREATE TABLE oauth_refresh_tokens (
  token_hash  TEXT PRIMARY KEY,
  agent_id    TEXT NOT NULL,
  client_id   TEXT NOT NULL,
  expires_at  INTEGER NOT NULL,
  consumed_at INTEGER
);
CREATE INDEX idx_oauth_refresh_agent ON oauth_refresh_tokens (agent_id);
