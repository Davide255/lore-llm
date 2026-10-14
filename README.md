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
project scope; `<project>/index.md` is generated and read-only.

## Management API (Cognito ID/access token)
| Route | |
|---|---|
| `POST /v1/agents` | `{name, project_scope, access_level, expires_in_days?}` → token (shown once) |
| `GET /v1/agents` · `PATCH/DELETE /v1/agents/:id` | list · change permissions · revoke |
| `GET /v1/audit?limit&before&agent_id&project` | agent activity timeline |
| `POST /v1/projects/:p/reindex` | rebuild `index.md` |

## Develop
```bash
npm ci
npm run typecheck && npm test      # R2/D1 are faked in tests (D1 via node:sqlite)
cp .dev.vars.example .dev.vars     # then: npm run db:migrate:local && npm run dev
```

Docs: [`docs/ARCHITECTURE_DECISIONS.md`](docs/ARCHITECTURE_DECISIONS.md) (deviations from the overview and why) ·
[`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md) (deployment plan).
