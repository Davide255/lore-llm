# Lore LLM — Implementation & Deployment Plan

Status: the backend (Worker, MCP server, management API, D1 schema, tests, CI) is **implemented and tested locally**
(41 tests, typecheck clean, `wrangler deploy --dry-run` bundles). **Nothing is deployed yet**: every step below that
touches Cloudflare/AWS must be run by someone with account access.

## 0. Prerequisites (you)

- Cloudflare account, `wrangler login` (or an API token, see §5). R2 may require a payment method on file even within the free allowance — check at activation.
- AWS account with a Cognito User Pool (+ app client, Google IdP if wanted).
- Node 22, `npm ci`.

## 1. Phase 1 — Cognito (AWS), ~½ day

1. Create the User Pool in the region you want (default in `wrangler.toml`: `eu-north-1`). Sign-in by email; add Google as federated IdP.
2. Create one app client **without secret** for the mobile app (Authorization code + PKCE). Note the pool id and client id(s).
3. Put them in `wrangler.toml` → `COGNITO_USER_POOL_ID`, `COGNITO_CLIENT_IDS` (comma-separated if web + mobile).
4. Nothing else on AWS: the Worker only reads the public JWKS (`.../.well-known/jwks.json`). No AWS credentials ever go to Cloudflare.

## 2. Phase 2 — Cloudflare resources, ~1 hour (dev first, then prod)

```bash
npx wrangler r2 bucket create lore-llm-kb-dev
npx wrangler d1 create lore-llm-db-dev          # copy database_id into [env.dev.d1_databases]
npx wrangler d1 migrations apply lore-llm-db-dev --env dev --remote
openssl rand -base64 48 | npx wrangler secret put AGENT_TOKEN_SECRET --env dev
npx wrangler deploy --env dev
curl https://lore-llm-dev.<subdomain>.workers.dev/health   # -> ok
```
Repeat without `--env dev` for prod (`lore-llm-kb`, `lore-llm-db`). Keep **separate secrets per environment**: a dev token must not work in prod.

## 3. Phase 3 — Smoke test end to end, ~½ day

1. Log in with the mobile app (or the Cognito hosted UI) and get an ID token.
2. `POST /v1/agents` `{"name":"claude","project_scope":"*","access_level":"read_write"}` → save the returned `token` (shown once).
3. Connect an MCP client over Streamable HTTP to `https://<worker>/mcp` with `Authorization: Bearer <token>`
   (e.g. `claude mcp add --transport http lore https://<worker>/mcp --header "Authorization: Bearer <token>"`).
4. Create a file, read `index.md`, check `GET /v1/audit`, then `DELETE /v1/agents/:id` and confirm the next MCP call is 401.

## 4. Phase 4 — Hardening before real users, ~1–2 days

| Item | Why | How |
|---|---|---|
| Rate limiting | one leaked token can hammer R2/D1 and burn the free quota | Cloudflare Rate Limiting binding or WAF rule on `/mcp` and `/v1/agents`, keyed by agent/user |
| Custom domain | stable URL for MCP clients | `routes` in `wrangler.toml` |
| Secret rotation | HMAC key compromise = forge any agent | rotate `AGENT_TOKEN_SECRET` (invalidates all tokens → users re-issue); document the runbook |
| Audit retention | D1 grows forever | scheduled Worker (cron trigger) deleting rows older than N months |
| Backups | R2 has no versioning; an agent with `read_write` can delete files | periodic copy to a second bucket (cron Worker) and/or per-project soft delete (see decisions §6) |
| Observability | silent audit failures | enable Workers Logs; alert on `audit insert failed` |
| Token UX | token shown once | mobile app screen: create/revoke agents, copy token, audit timeline |

## 5. CI/CD (`.github/workflows/ci.yml`)

- Every push/PR: `npm ci` → `typecheck` → `test` → `wrangler deploy --dry-run`.
- Push to `main`: migrations + deploy to **dev** automatically.
- Prod: manual `workflow_dispatch` (GitHub Environment `production` with required reviewer).
- GitHub secrets: `CLOUDFLARE_API_TOKEN` (permissions: Workers Scripts:Edit, D1:Edit, R2:Edit), `CLOUDFLARE_ACCOUNT_ID`.
  `AGENT_TOKEN_SECRET` is set once with `wrangler secret put`, never in CI.
- D1 migrations run **before** the code deploy and must be backward compatible (add-only) so a failed deploy does not break the running version.

## 6. Open items not covered by the architecture document

1. **File access for the mobile app/user.** The architecture only exposes an audit endpoint to the app. If users must browse/edit files from the app, a `/v1/files` REST layer reusing `Store` is needed (small: ~1 day).
2. ~~**MCP OAuth for hosted connectors.**~~ Done: the Worker is its own authorization server with Cognito as login (see decisions §7 and README). Needs a Cognito public app client + hosted UI domain to be enabled.
3. **Legacy SSE-only clients** (see decisions §1).
4. **Search.** Agents can only list/read. Full-text/semantic search (Vectorize/AI Search) is the natural next feature.
