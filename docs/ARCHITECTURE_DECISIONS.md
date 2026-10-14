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
