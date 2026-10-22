# Lore LLM — backend

Multi-tenant markdown knowledge base shared by users and their delegated AI agents.
Serverless: **Cloudflare Workers** (MCP server + API), **R2** (files), **D1** (permissions, audit), **AWS Cognito** (user identity).

**Quick links:** [Website](https://davide255.github.io/lore-llm/) ·
[Web app](https://davide255.github.io/lore-llm-desktop/) ·
[Getting started](#getting-started) ·
[Privacy policy](https://davide255.github.io/lore-llm/privacy-policy/) ·
[Terms of service](https://davide255.github.io/lore-llm/terms-of-service/)

**Client apps**
- Mobile: [Davide255/lore-llm-mobile](https://github.com/Davide255/lore-llm-mobile)
- Desktop: [Davide255/lore-llm-desktop](https://github.com/Davide255/lore-llm-desktop)

```
Mobile app ──Cognito JWT──▶ /v1/*  (agents, permissions, audit, reindex)   ┐
                                                                            ├─ Worker ─▶ R2  {user_id}/{project}/…
AI agent ───Agent token───▶ /mcp   (MCP Streamable HTTP, stateless)         ┘            └▶ D1  permissions, audit_logs
```

## Getting started

### Prerequisites
- **Node.js 22+** and npm.
- A free **Cloudflare** account (Workers, R2, D1) — only needed to deploy.
- An **AWS Cognito** user pool (sign-in for the apps; the Worker verifies its tokens) — only needed to deploy.

### 1. Run it locally
```bash
git clone https://github.com/Davide255/lore-llm.git && cd lore-llm
npm ci
npm run typecheck && npm test      # R2/D1 are faked in tests, no account needed

cp .dev.vars.example .dev.vars     # local secrets (AGENT_TOKEN_SECRET), never committed
npm run db:migrate:local           # creates the local D1 schema (migrations/*.sql)
npm run dev                        # wrangler dev, Worker on http://localhost:8787
```
`wrangler dev` simulates R2 and D1 on disk (`.wrangler/`). Sign-in tokens are still verified against the Cognito
pool in `wrangler.toml`, so to use the local Worker with a client you need either that pool or your own (step 2).

### 2. Deploy your own
1. `npx wrangler login`, then create the storage:
   ```bash
   npx wrangler r2 bucket create <your-bucket>
   npx wrangler d1 create <your-db>        # prints the database_id
   ```
2. In `wrangler.toml` set `name`, `bucket_name`, `database_name` and `database_id` to your own values.
3. **Cognito**: create a user pool and a public app client (no secret), then set `COGNITO_REGION`,
   `COGNITO_USER_POOL_ID` and `COGNITO_CLIENT_IDS` (comma-separated client ids allowed on `/v1/*`) in `wrangler.toml`.
   Add Google as federated identity provider if you want "Sign in with Google" like the apps.
4. Set the secret that signs agent tokens (≥ 32 random characters):
   ```bash
   openssl rand -base64 48 | npx wrangler secret put AGENT_TOKEN_SECRET
   ```
5. Apply the migrations and deploy:
   ```bash
   npx wrangler d1 migrations apply DB --remote
   npm run deploy                          # prints https://<name>.<account>.workers.dev
   ```
6. Optional: `ALLOWED_ORIGINS` for browser clients (e.g. the [web app](https://davide255.github.io/lore-llm-desktop/)),
   and OAuth for hosted MCP connectors (see [OAuth for MCP clients](#oauth-for-mcp-clients)).

The repo's CI (`.github/workflows/ci.yml`) runs typecheck + tests on every push and deploys the dev environment from
`main`; it needs the `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` secrets. Production is a manual run with
*Deploy to production* checked.

### 3. Point a client at it
- **Desktop / web app**: run it with `LORE_API_URL=https://<your-worker>.workers.dev` and your Cognito values
  (see [lore-llm-desktop](https://github.com/Davide255/lore-llm-desktop#getting-started)).
- **AI agent**: sign in to an app, *Settings → Agents*, create an agent (projects + read / read-write) and copy its token, then:
  ```bash
  claude mcp add --transport http lore https://<your-worker>.workers.dev/mcp \
    --header "Authorization: Bearer $LORE_TOKEN"
  ```
  Codex, raw HTTP and the OAuth flow for Claude.ai / ChatGPT connectors are shown on the [project site](https://davide255.github.io/lore-llm/#connect).

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
| `GET /v1/projects` | one row per project `{name, file_count, size, updated_at, checklist: {path, etag, size, uploaded}\|null}` from a single listing: the home screen needs nothing more |
| `GET /v1/files[?attachments=1&project=P]` | every note (and attachment, on request) with its etag; `project` limits it to one project, loaded when the user opens it |
| `GET/PUT /v1/file?path=` · `DELETE /v1/file?path=` | read/write a note (`{content, overwrite?, if_match?}`) · delete a note or attachment |
| `GET/PUT /v1/blob?path=` | raw attachment bytes (png, jpg, gif, webp, svg, pdf; ≤ 10 MiB); `?overwrite=1`, `If-Match`, `x-lore-etag` |
| `DELETE /v1/folder?path=` · `POST /v1/files/move` | delete a folder · move a file or folder (byte-exact) |
| `GET /v1/version` | change cursor, bumped on every file change by anyone (clients poll it); without `?owner`, `scopes` holds the cursor of each of the caller's teams |
| `?owner=t:<teamId>` on any file route | act on a team's files instead of your own; viewers read, editors and owners write, others get 403 |
| `GET/POST /v1/teams` · `GET/PATCH/DELETE /v1/teams/:id` | your teams (role included) · create (you become owner) · team details · rename · delete (only when it has no files) |
| `GET /v1/teams/:id/members` · `PATCH/DELETE /v1/teams/:id/members/:userId` | members with email and name · change role (owner) · remove (owner) or leave (yourself); a team keeps at least one owner |
| `GET/POST /v1/teams/:id/invites` · `DELETE /v1/teams/:id/invites/:inviteId` | pending invitations · invite by email `{email, role: editor\|viewer}` (expires after 14 days) · revoke (owners only) |
| `GET /v1/invites` · `POST /v1/invites/:id/accept\|decline` | invitations addressed to your email · answer one |
| `POST /v1/projects/:p/move-to-team` | `{team_id}`: move a personal project into a team you can write to |
| `DELETE /v1/account` | permanently delete the caller's files, agents, audit log, memberships, invites and shares, and (if `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` secrets allow `cognito-idp:AdminDeleteUser`) their Cognito user; refused with 409 while they are the only owner of a team |

## Develop
Setup and local run: see [Getting started](#getting-started). Tests fake R2 and D1 (D1 via `node:sqlite`).

Docs: [`docs/ARCHITECTURE_DECISIONS.md`](docs/ARCHITECTURE_DECISIONS.md) (deviations from the overview and why) ·
[`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md) (deployment plan).
