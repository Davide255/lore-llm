# Lore LLM — backend

Multi-tenant markdown knowledge base shared by users and their delegated AI agents.
Serverless: **Cloudflare Workers** (MCP server + API), **R2** (files), **D1** (permissions, audit), **AWS Cognito** (user identity).

```
Mobile app ──Cognito JWT──▶ /v1/*  (agents, permissions, audit, reindex)   ┐
                                                                            ├─ Worker ─▶ R2  {user_id}/{project}/…
AI agent ───Agent token───▶ /mcp   (MCP Streamable HTTP, stateless)         ┘            └▶ D1  permissions, audit_logs
```

## MCP tools
- Files: `list_projects`, `list_files`, `read_file`, `read_file_lines`, `search_files`, `write_file`, `append_file`, `patch_file`, `delete_file`
- Checklists (`<project>/checklist.md`): `get_checklist`, `add_checklist_item`, `check_item`, `edit_checklist_item`, `move_checklist_item`, `delete_checklist_item`
- Projects: `create_project`, `rename_project` (moves all files; max 100), `delete_project` (needs `confirm=true`)

All are scoped to the agent's user and project scope (write tools need `read_write`; renaming needs access to both names);
`<project>/index.md` is generated and read-only. Attachments are listed (`attachment: true`) but cannot be read or written by agents.

## OAuth for MCP clients
Hosted connectors (Claude.ai, ChatGPT, `claude mcp add` without a header) authenticate via OAuth 2.1. The Worker is its own
authorization server (discovery at `/.well-known/oauth-protected-resource` and `/oauth-authorization-server`, dynamic client
registration at `/oauth/register`, `/oauth/authorize` + `/oauth/token`, PKCE S256 only). Login is delegated to the Cognito hosted
UI; after sign-in the user picks name, scope and access level on a consent page, which creates a normal agent. Access tokens are
the usual agent JWT (1 h), refresh tokens rotate (30 d, reuse revokes them), and revoking the agent kills both.
Static agent tokens from `POST /v1/agents` keep working.

Enable it (off by default, `/oauth/*` is 404 until both are set):
1. In Cognito create a **public** app client (no secret, authorization-code grant, scope `openid`) with callback URL
   `https://<worker>/oauth/callback`, and enable a hosted UI domain.
2. Set `COGNITO_DOMAIN` (host only) and `OAUTH_COGNITO_CLIENT_ID` in `wrangler.toml`, then apply migration `0004_oauth.sql`.

## Management API (Cognito ID/access token)
| Route | |
|---|---|
| `POST /v1/agents` | `{name, project_scope, access_level, expires_in_days?}` → token (shown once) |
| `GET /v1/agents` · `PATCH/DELETE /v1/agents/:id` | list · change permissions · revoke |
| `GET /v1/audit?limit&before&agent_id&project` | agent activity timeline |
| `POST /v1/projects/:p/reindex` | rebuild `index.md` |
| `GET /v1/files[?attachments=1]` | every note (and attachment, on request) with its etag |
| `GET/PUT /v1/file?path=` · `DELETE /v1/file?path=` | read/write a note (`{content, overwrite?, if_match?}`) · delete a note or attachment |
| `GET/PUT /v1/blob?path=` | raw attachment bytes (png, jpg, gif, webp, svg, pdf; ≤ 10 MiB); `?overwrite=1`, `If-Match`, `x-lore-etag` |
| `DELETE /v1/folder?path=` · `POST /v1/files/move` | delete a folder · move a file or folder (byte-exact) |
| `GET /v1/version` | change cursor, bumped on every file change by anyone (clients poll it) |

## Develop
```bash
npm ci
npm run typecheck && npm test      # R2/D1 are faked in tests (D1 via node:sqlite)
cp .dev.vars.example .dev.vars     # then: npm run db:migrate:local && npm run dev
```

Docs: [`docs/ARCHITECTURE_DECISIONS.md`](docs/ARCHITECTURE_DECISIONS.md) (deviations from the overview and why) ·
[`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md) (deployment plan).
