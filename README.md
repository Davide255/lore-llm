# Lore LLM — backend

Multi-tenant markdown knowledge base shared by users and their delegated AI agents.
Serverless: **Cloudflare Workers** (MCP server + API), **R2** (files), **D1** (permissions, audit), **AWS Cognito** (user identity).

```
Mobile app ──Cognito JWT──▶ /v1/*  (agents, permissions, audit, reindex)   ┐
                                                                            ├─ Worker ─▶ R2  {user_id}/{project}/…
AI agent ───Agent token───▶ /mcp   (MCP Streamable HTTP, stateless)         ┘            └▶ D1  permissions, audit_logs
```

## MCP tools
`list_projects`, `list_files`, `read_file`, `write_file`, `append_file`, `delete_file` — all scoped to the agent's user and
project scope; `<project>/index.md` is generated and read-only. Attachments are listed (`attachment: true`) but
cannot be read or written by agents.

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
