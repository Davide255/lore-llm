# Decisions and deviations from `Architecture_Overview.md`

Where the implementation differs from the overview, and why. Disagree with any of these and they are cheap to change.

## 1. Streamable HTTP instead of SSE
The overview says agents connect "via Server-Sent Events". The MCP spec replaced the old HTTP+SSE transport with
**Streamable HTTP** (2025-03-26) and clients are moving to it. The legacy transport needs a long-lived stream plus a
session-to-stream mapping, which on stateless Workers means Durable Objects or fragile in-isolate state, for no benefit
here (all tools are short request/response). The server is therefore stateless: `POST /mcp`, JSON responses, `GET /mcp` → 405.
Cost: clients that speak *only* the legacy SSE transport can't connect (a bridge such as `mcp-remote` can help).

## 2. Agent token = HS256 JWT **plus** a D1 row
The overview says the Worker "decodes the token" to get `agent_id` and `user_id`. A pure self-contained JWT can't be revoked
before expiry. So the token only identifies (`sub`=agent_id, `uid`=user_id); authorization comes from the `permissions` row,
and **deleting the row revokes instantly**. Tokens also expire (default 90 days, max 365). The row's `user_id` must match
the token's `uid`. No token is stored; it is shown once at creation.

## 3. Extra columns / endpoints
`permissions` gets `name` and `created_at` (needed to list agents in the app). `project_scope` accepts a comma-separated list
(`A/*,B/*`) because one scope per agent is too restrictive. Management API (Cognito-authenticated): create/list/patch/revoke agents,
audit timeline, reindex.

## 4. Index compilation: inline, audit: async
`ctx.waitUntil` is used for the audit log as specified. The index is rebuilt **inline** instead, so an agent that writes and
immediately reads `index.md` sees the update. Trade-off: a few ms per write (one `list` + one `put`). Known limitation:
two concurrent writes can compile from a slightly stale listing (last writer wins); `POST /v1/projects/:p/reindex` repairs it.

## 5. Audit via `waitUntil` can lose entries
If the D1 insert fails after the response, the modification happened but isn't logged (it is `console.error`ed). Accepted
per the overview for latency; if auditing must be guaranteed, `await` the insert (adds one D1 write to each modifying call).

## 6. Security properties and their limits
- Tenant isolation is enforced in one place (`objectKey`) and the path parser rejects `..`, `.`, empty segments, backslashes,
  control characters and non-`.md` files; tested including cross-tenant reads. It relies on `user_id` coming only from a verified token.
- `index.md` (any letter case) is read-only for agents.
- `write_file` does **not overwrite by default** (`overwrite=true` required) so a confused agent can't silently clobber a file.
- `append_file` uses an etag precondition, so concurrent appends to `checklist.md` don't lose data.
- **Not protected:** a `read_write` agent can delete any file in its scope and R2 has no versioning here. Backups/soft delete are in the plan (Phase 4).
- Flat 1 MiB limit per file; only `.md` files.

## 7. OAuth for /mcp: the Worker is the authorization server
Hosted MCP connectors need OAuth 2.1 with dynamic client registration, which Cognito doesn't offer, and Cognito tokens carry
no per-agent identity. So the Worker serves the OAuth endpoints itself and uses Cognito's hosted UI only to log the human in.
Consent creates an ordinary `permissions` row and issues the existing agent JWT (1 h) plus a rotating refresh token, so
tool authorization and revocation (delete the row) are unchanged; `deleteAgent` also drops refresh tokens and codes.
Codes and refresh tokens are stored hashed; codes are single use (60 s); a replayed code or refresh token revokes the agent's
refresh tokens. Only public clients with S256 PKCE and exact-match https/loopback redirect URIs are accepted. The consent
form is protected by an HttpOnly cookie plus a CSRF token. Static agent tokens remain supported. OAuth stays off until
`COGNITO_DOMAIN` and `OAUTH_COGNITO_CLIENT_ID` are set. Limits: the client registry is capped (5000) rather than rate limited,
and expired rows are purged opportunistically on `/authorize`.

## 8. Search and stars for the user's clients (D1 derived state)
**Search** is D1 FTS5 (`note_index` + `note_fts`, migration 0006), per owner (a user's space or a team's) and behind the same
role check as reads. R2 stays the source of truth; the index is a derived copy that can be dropped at any time. Instead of
hooking every write path (clients, agents, folder moves, project transfers), each search first reconciles the index with the R2
listing (path + etag, no body reads): changed notes are re-read and indexed, deleted ones dropped. So the index is always correct,
at the cost of one R2 list per search (fine for thousands of notes; past ~50k notes per owner, track changes by timestamp
instead). A never-indexed space is indexed at most 100 notes per search and the response says `truncated`. Queries are quoted
prefix tokens (no FTS syntax injection) and are confined to one owner's rows by a per-owner token plus an exact `owner` filter.
Rows are deleted with the account or the team. The MCP tool `search_files` uses the same index (it used to read
every file on each call): an agent's project scope is applied inside the query, results are ranked with a snippet and line
number, and a `note` entry says when the index is still being built. Not covered: substring matching (token/prefix only),
semantic search.

**Stars** (`starred`, migration 0007) are per user, cover notes and whole projects (a path with no `/` is a project), and span
the user's own space and their teams': a viewer can star a team note or project, nobody sees anyone else's stars, and starring moves the caller's own change cursor, never the team's. They are D1 rows
keyed by (owner, path), not R2 metadata, which a move or overwrite would lose. Moves through the files API and the MCP `rename_project` carry the stars along (a
project renamed keeps its own star; moved into a folder it is no longer a project and loses it); every listing prunes stars whose
note or project is gone (one R2 listing per starred owner), which covers deletes by clients and agents. A project transferred to
a team loses its stars (no hook there).
Stars of a team the user left are hidden. Limit 500 per user.

## 9. Study mode on a separate AWS Lambda
The study mode (questions generated from a project's notes, answers graded with the user's criteria) needs a language model, PDFs
and photos of up to 10 MiB each, and responses that last minutes. It runs on an AWS Lambda (`study-lambda/`, Function URL with
`InvokeMode: RESPONSE_STREAM`, SSE) instead of this Worker: the Worker is on the free plan (10 ms of CPU per request) and
base64-encoding a large PDF for the model would exceed it, and the Worker stays dependency-free.

The Lambda **never touches R2 or D1**. It verifies the Cognito token itself (same pool and app clients), then reads notes and
attachments and writes the report through `GET /v1/file`, `GET /v1/blob` and `PUT /v1/file` with that same token. Team roles,
`index.md`, the change cursor and the search index therefore behave exactly as for an app write, with no new code here; a
viewer gets the grade but no saved report (`save_failed`). It is stateless: the questions, answer key included, travel to the app
and come back at grading time — acceptable for a personal study tool, and it avoids a session store. The grade is computed by
code from per-criterion scores the model gives; the model never does the arithmetic. Not covered: a per-user quota (any valid
token can spend model calls, bounded only by the 12 files / 20 MB / 30 questions limits).
