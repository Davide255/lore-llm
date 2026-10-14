import { signAgentToken } from '../auth/agentToken';
import { cognitoConfigFromEnv, verifyCognitoToken } from '../auth/cognito';
import { AuthError, b64urlEncode, nowSeconds } from '../auth/jwt';
import { createAgent, getAgent, listAgents } from '../db/permissions';
import type { Env } from '../env';
import { MAX_AGENTS_PER_USER, validateAccessLevel } from '../permissions/scope';
import { PathError } from '../storage/paths';

const ACCESS_TOKEN_SECONDS = 3600;
const REFRESH_TOKEN_SECONDS = 30 * 86400;
const CODE_SECONDS = 60;
const REQUEST_SECONDS = 600;
const MAX_CLIENTS = 5000;
const COOKIE = 'lore_oauth';
const enc = new TextEncoder();

export function oauthEnabled(env: Env): boolean {
  return Boolean(env.COGNITO_DOMAIN && env.OAUTH_COGNITO_CLIENT_ID);
}

export const protectedResourceMetadataUrl = (origin: string) => `${origin}/.well-known/oauth-protected-resource`;

// ---------- small helpers ----------

const randomToken = (bytes = 32) => b64urlEncode(crypto.getRandomValues(new Uint8Array(bytes)));
async function sha256(input: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(input)));
}
const sha256hex = async (input: string) => [...(await sha256(input))].map((b) => b.toString(16).padStart(2, '0')).join('');

function json(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
  });
}
const oauthError = (error: string, description: string, status = 400) => json({ error, error_description: description }, status);
const page = (html: string, status = 200, headers: HeadersInit = {}) =>
  new Response(html, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
      'x-frame-options': 'DENY',
      ...headers,
    },
  });
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const errorPage = (message: string, status = 400) =>
  page(shell('Lore LLM', `<h1>Something went wrong</h1><p class="lead">${esc(message)}</p>`), status);

function cookieValue(req: Request, name: string): string | null {
  for (const part of (req.headers.get('cookie') ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}
const setCookie = (value: string, maxAge: number) => `${COOKIE}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/oauth; Max-Age=${maxAge}`;

function validRedirectUri(raw: unknown): raw is string {
  if (typeof raw !== 'string' || raw.length > 2048) return false;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.hash) return false;
  if (u.protocol === 'https:') return true;
  return u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
}

async function purgeExpired(db: D1Database): Promise<void> {
  const now = nowSeconds();
  await db.prepare('DELETE FROM oauth_requests WHERE expires_at < ?').bind(now).run();
  await db.prepare('DELETE FROM oauth_codes WHERE expires_at < ?').bind(now).run();
  await db.prepare('DELETE FROM oauth_refresh_tokens WHERE expires_at < ?').bind(now).run();
}

interface ClientRow {
  client_id: string;
  client_name: string;
  redirect_uris: string;
}
const getClient = (db: D1Database, id: string) =>
  db.prepare('SELECT * FROM oauth_clients WHERE client_id = ?').bind(id).first<ClientRow>();

// ---------- routing ----------

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type, authorization', 'access-control-allow-methods': 'GET, POST, OPTIONS' };

/** Returns null when the path is not an OAuth route (or OAuth is not configured). */
export async function handleOAuth(req: Request, env: Env, url: URL): Promise<Response | null> {
  const p = url.pathname;
  const isWellKnown = p.startsWith('/.well-known/oauth-');
  if (!isWellKnown && !p.startsWith('/oauth/')) return null;
  if (!oauthEnabled(env)) return new Response('Not found', { status: 404 });

  // Public, credential-less endpoints that browser-based MCP clients call cross-origin.
  const cross = isWellKnown || p === '/oauth/register' || p === '/oauth/token';
  if (cross && req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  let res: Response;
  try {
    res = await route(req, env, url);
  } catch (err) {
    console.error('oauth error', String(err));
    res = oauthError('server_error', 'Internal error', 500);
  }
  if (cross) for (const [k, v] of Object.entries(CORS)) res.headers.set(k, v);
  return res;
}

async function route(req: Request, env: Env, url: URL): Promise<Response> {
  const p = url.pathname;
  const get = req.method === 'GET';
  const post = req.method === 'POST';
  if (get && (p === '/.well-known/oauth-protected-resource' || p === '/.well-known/oauth-protected-resource/mcp')) {
    return json({ resource: `${url.origin}/mcp`, authorization_servers: [url.origin], bearer_methods_supported: ['header'] });
  }
  if (get && (p === '/.well-known/oauth-authorization-server' || p === '/.well-known/oauth-authorization-server/mcp')) {
    return json({
      issuer: url.origin,
      authorization_endpoint: `${url.origin}/oauth/authorize`,
      token_endpoint: `${url.origin}/oauth/token`,
      registration_endpoint: `${url.origin}/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
    });
  }
  if (post && p === '/oauth/register') return register(req, env);
  if (get && p === '/oauth/authorize') return authorize(url, env);
  if (get && p === '/oauth/callback') return callback(req, env, url);
  if (post && p === '/oauth/consent') return consent(req, env, url);
  if (post && p === '/oauth/token') return token(req, env);
  return new Response('Not found', { status: 404 });
}

// ---------- dynamic client registration (RFC 7591), public clients only ----------

async function register(req: Request, env: Env): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new Error();
  } catch {
    return oauthError('invalid_client_metadata', 'Body must be a JSON object');
  }
  const uris = body.redirect_uris;
  if (!Array.isArray(uris) || uris.length < 1 || uris.length > 5 || !uris.every(validRedirectUri)) {
    return oauthError('invalid_redirect_uri', 'redirect_uris must be 1-5 https (or http loopback) URLs without a fragment');
  }
  const name = typeof body.client_name === 'string' && body.client_name.trim() ? body.client_name.trim().slice(0, 64) : 'MCP client';

  const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM oauth_clients').first<{ n: number }>();
  if ((count?.n ?? 0) >= MAX_CLIENTS) return oauthError('temporarily_unavailable', 'Client registry is full', 429);

  const clientId = crypto.randomUUID();
  const issuedAt = nowSeconds();
  await env.DB.prepare('INSERT INTO oauth_clients (client_id, client_name, redirect_uris, created_at) VALUES (?, ?, ?, ?)')
    .bind(clientId, name, JSON.stringify(uris), issuedAt)
    .run();
  return json(
    {
      client_id: clientId,
      client_id_issued_at: issuedAt,
      client_name: name,
      redirect_uris: uris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    },
    201,
  );
}

// ---------- /authorize -> Cognito hosted UI login ----------

async function authorize(url: URL, env: Env): Promise<Response> {
  const q = url.searchParams;
  // Until client and redirect_uri are proven valid we must not redirect anywhere: show the error instead.
  const client = await getClient(env.DB, q.get('client_id') ?? '');
  const redirectUri = q.get('redirect_uri') ?? '';
  if (!client || !(JSON.parse(client.redirect_uris) as string[]).includes(redirectUri)) {
    return errorPage('Unknown client or redirect URI.');
  }
  const state = q.get('state');
  const fail = (error: string) => redirectBack(redirectUri, { error, state });
  if (q.get('response_type') !== 'code') return fail('unsupported_response_type');
  const challenge = q.get('code_challenge') ?? '';
  if (q.get('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) return fail('invalid_request');
  const resource = q.get('resource');
  if (resource && resource.replace(/\/$/, '') !== `${url.origin}/mcp`) return fail('invalid_target');

  await purgeExpired(env.DB);
  const txn = randomToken();
  const verifier = randomToken(48);
  await env.DB.prepare(
    'INSERT INTO oauth_requests (txn_id, client_id, redirect_uri, code_challenge, state, cognito_verifier, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(txn, client.client_id, redirectUri, challenge, state, verifier, nowSeconds() + REQUEST_SECONDS)
    .run();

  const cognito = new URL(`https://${cognitoHost(env)}/oauth2/authorize`);
  cognito.search = new URLSearchParams({
    response_type: 'code',
    client_id: env.OAUTH_COGNITO_CLIENT_ID!,
    redirect_uri: `${url.origin}/oauth/callback`,
    scope: 'openid',
    state: txn,
    code_challenge: b64urlEncode(await sha256(verifier)),
    code_challenge_method: 'S256',
  }).toString();
  return new Response(null, { status: 302, headers: { location: cognito.toString(), 'set-cookie': setCookie(txn, REQUEST_SECONDS), 'cache-control': 'no-store' } });
}

const cognitoHost = (env: Env) => env.COGNITO_DOMAIN!.replace(/^https?:\/\//, '').replace(/\/+$/, '');

function redirectBack(redirectUri: string, params: Record<string, string | null | undefined>, headers: Record<string, string> = {}): Response {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v) u.searchParams.set(k, v);
  return new Response(null, { status: 302, headers: { location: u.toString(), 'cache-control': 'no-store', ...headers } });
}

interface RequestRow {
  txn_id: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  state: string | null;
  cognito_verifier: string;
  user_id: string | null;
  csrf: string | null;
  expires_at: number;
}
async function loadRequest(env: Env, txn: string | null): Promise<RequestRow | null> {
  if (!txn) return null;
  const row = await env.DB.prepare('SELECT * FROM oauth_requests WHERE txn_id = ?').bind(txn).first<RequestRow>();
  return row && row.expires_at > nowSeconds() ? row : null;
}

// ---------- Cognito callback -> consent page ----------

async function callback(req: Request, env: Env, url: URL): Promise<Response> {
  const txn = url.searchParams.get('state');
  const row = await loadRequest(env, txn);
  // The cookie ties the callback to the browser that started the flow (login CSRF).
  if (!row || cookieValue(req, COOKIE) !== txn || row.user_id) return errorPage('This sign-in link is invalid or has expired. Start again from your app.');
  if (url.searchParams.get('error') || !url.searchParams.get('code')) {
    await env.DB.prepare('DELETE FROM oauth_requests WHERE txn_id = ?').bind(row.txn_id).run();
    return redirectBack(row.redirect_uri, { error: 'access_denied', state: row.state });
  }

  const tokenRes = await fetch(`https://${cognitoHost(env)}/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: env.OAUTH_COGNITO_CLIENT_ID!,
      code: url.searchParams.get('code')!,
      redirect_uri: `${url.origin}/oauth/callback`,
      code_verifier: row.cognito_verifier,
    }),
  });
  if (!tokenRes.ok) return errorPage('Sign-in failed. Start again from your app.', 502);
  const { id_token: idToken } = (await tokenRes.json()) as { id_token?: string };
  let userId: string;
  try {
    if (!idToken) throw new AuthError('No id_token');
    ({ userId } = await verifyCognitoToken(idToken, { ...cognitoConfigFromEnv(env), clientIds: [env.OAUTH_COGNITO_CLIENT_ID!] }));
  } catch (err) {
    if (err instanceof AuthError) return errorPage('Sign-in could not be verified.', 401);
    throw err;
  }

  const csrf = randomToken();
  await env.DB.prepare('UPDATE oauth_requests SET user_id = ?, csrf = ? WHERE txn_id = ? AND user_id IS NULL').bind(userId, csrf, row.txn_id).run();
  const client = await getClient(env.DB, row.client_id);
  return page(consentHtml(client?.client_name ?? 'MCP client', new URL(row.redirect_uri).host, row.txn_id, csrf));
}

const LOGO =
  '<svg class="logo" viewBox="0 0 64 64" aria-hidden="true"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#8f5cff"/><stop offset="1" stop-color="#3a86ff"/></linearGradient></defs><rect width="64" height="64" rx="14" fill="url(#g)"/><path d="M22 16v32h22" fill="none" stroke="#faf9f5" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/><circle cx="44" cy="22" r="5" fill="#faf9f5"/></svg>';

// Mirrors the site's dark theme (site/index.html). Inline only: the CSP allows no external assets.
const STYLE = `:root{--purple:#8f5cff;--ink:#faf9f5;--ink2:rgba(250,249,245,.62);--ink3:rgba(250,249,245,.4);--hair:rgba(250,249,245,.1);--bg:#121211;--cell:#1c1b20;--cell2:#232129;--mono:ui-monospace,"SF Mono","Cascadia Code",Consolas,Menlo,monospace}
*{box-sizing:border-box}html{color-scheme:dark}
body{margin:0;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px 16px;background:radial-gradient(60rem 30rem at 50% -10%,rgba(143,92,255,.18),transparent 70%),var(--bg);color:var(--ink);font:16px/1.5 -apple-system,"SF Pro Text","Segoe UI Variable Text","Segoe UI","Helvetica Neue",system-ui,sans-serif;-webkit-font-smoothing:antialiased}
.brand{display:flex;align-items:center;gap:10px;font-weight:650;letter-spacing:-.01em;margin-bottom:20px}.logo{width:28px;height:28px}
.card{width:100%;max-width:30rem;background:var(--cell);border:1px solid var(--hair);border-radius:18px;padding:28px;box-shadow:0 20px 60px rgba(0,0,0,.35)}
h1{margin:0 0 8px;font-size:24px;line-height:1.2;letter-spacing:-.02em}
.lead{margin:0;color:var(--ink2)}.lead strong{color:var(--ink)}
code{font-family:var(--mono);font-size:.88em;background:var(--cell2);border:1px solid var(--hair);border-radius:6px;padding:1px 6px}
label{display:block;margin:18px 0 6px;font-size:14px;font-weight:600}
input,select{width:100%;padding:11px 12px;font:inherit;color:var(--ink);background:var(--cell2);border:1px solid var(--hair);border-radius:10px;outline:none}
input:focus,select:focus{border-color:var(--purple);box-shadow:0 0 0 3px rgba(143,92,255,.28)}
small{display:block;margin-top:6px;color:var(--ink3);font-size:13px}
.row{display:flex;gap:12px;margin-top:26px}
button{flex:1;padding:12px 16px;font:inherit;font-weight:600;color:var(--ink);background:rgba(250,249,245,.06);border:1px solid var(--hair);border-radius:12px;cursor:pointer}
button:hover{background:rgba(250,249,245,.1)}
button.primary{background:var(--purple);border-color:transparent;box-shadow:0 4px 14px rgba(143,92,255,.3)}
button.primary:hover{background:#7a46f0}
button:focus-visible{outline:2px solid var(--purple);outline-offset:2px}
@media(max-width:480px){.card{padding:22px}.row{flex-direction:column-reverse}}`;

const shell = (title: string, body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><title>${esc(title)}</title><style>${STYLE}</style></head><body><div class="brand">${LOGO}<span>Lore LLM</span></div><main class="card">${body}</main></body></html>`;

function consentHtml(clientName: string, redirectHost: string, txn: string, csrf: string): string {
  return shell(
    `Authorize ${clientName}`,
    `<h1>Authorize ${esc(clientName)}</h1>
<p class="lead"><strong>${esc(clientName)}</strong> (returns to <code>${esc(redirectHost)}</code>) wants to read and write your knowledge base. It will appear in your agents list and you can revoke it at any time.</p>
<form method="post" action="/oauth/consent">
<input type="hidden" name="txn" value="${esc(txn)}"><input type="hidden" name="csrf" value="${esc(csrf)}">
<label for="name">Agent name</label><input id="name" name="name" maxlength="64" required value="${esc(clientName)}">
<label for="access_level">Access</label><select id="access_level" name="access_level"><option value="read_write">Read &amp; write</option><option value="read_only">Read only</option></select>
<small>Which projects it can reach is managed later in the app.</small>
<div class="row"><button type="submit" name="decision" value="deny">Deny</button><button class="primary" type="submit" name="decision" value="allow">Allow</button></div>
</form>`,
  );
}

// ---------- consent: mint the agent + authorization code ----------

async function consent(req: Request, env: Env, url: URL): Promise<Response> {
  if (!(req.headers.get('content-type') ?? '').includes('application/x-www-form-urlencoded')) return errorPage('Unsupported form.', 415);
  const form = new URLSearchParams(await req.text());
  const txn = form.get('txn');
  const row = await loadRequest(env, txn);
  if (!row || !row.user_id || !row.csrf || cookieValue(req, COOKIE) !== txn || form.get('csrf') !== row.csrf) {
    return errorPage('This form is invalid or has expired. Start again from your app.', 403);
  }
  const clear = { 'set-cookie': setCookie('', 0) };

  let agent;
  if (form.get('decision') === 'allow') {
    try {
      const name = (form.get('name') ?? '').trim();
      if (!name || name.length > 64) throw new PathError('name must be 1-64 characters');
      agent = {
        agent_id: crypto.randomUUID(),
        user_id: row.user_id,
        name,
        // Fine-grained scope and type are edited later in the app (PATCH /v1/agents/:id).
        agent_type: 'claude' as const,
        project_scope: '*',
        access_level: validateAccessLevel(form.get('access_level')),
        created_at: new Date().toISOString(),
      };
    } catch (err) {
      if (err instanceof PathError) return errorPage(`${err.message}. Go back and fix the form.`);
      throw err;
    }
    if ((await listAgents(env.DB, row.user_id)).length >= MAX_AGENTS_PER_USER) {
      return errorPage(`Agent limit reached (${MAX_AGENTS_PER_USER}). Revoke an agent and try again.`, 409);
    }
  }

  // Single use: only the request that deletes the row proceeds.
  const consumed = await env.DB.prepare('DELETE FROM oauth_requests WHERE txn_id = ?').bind(row.txn_id).run();
  if ((consumed.meta.changes ?? 0) !== 1) return errorPage('This request was already used.', 409);
  if (!agent) return redirectBack(row.redirect_uri, { error: 'access_denied', state: row.state }, clear);

  await createAgent(env.DB, agent);
  const code = randomToken();
  await env.DB.prepare(
    'INSERT INTO oauth_codes (code_hash, client_id, redirect_uri, code_challenge, agent_id, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
  )
    .bind(await sha256hex(code), row.client_id, row.redirect_uri, row.code_challenge, agent.agent_id, nowSeconds() + CODE_SECONDS)
    .run();
  return redirectBack(row.redirect_uri, { code, state: row.state, iss: url.origin }, clear);
}

// ---------- /token ----------

async function token(req: Request, env: Env): Promise<Response> {
  const form = new URLSearchParams(await req.text());
  const clientId = form.get('client_id') ?? '';
  const client = await getClient(env.DB, clientId);
  if (!client) return oauthError('invalid_client', 'Unknown client_id', 401);

  switch (form.get('grant_type')) {
    case 'authorization_code':
      return codeGrant(env, form, clientId);
    case 'refresh_token':
      return refreshGrant(env, form, clientId);
    default:
      return oauthError('unsupported_grant_type', 'Use authorization_code or refresh_token');
  }
}

const invalidGrant = () => oauthError('invalid_grant', 'Invalid, expired or already used grant');

async function issueTokens(env: Env, agentId: string, userId: string, clientId: string): Promise<Response> {
  const now = nowSeconds();
  const accessToken = await signAgentToken(env.AGENT_TOKEN_SECRET, { agentId, userId }, now + ACCESS_TOKEN_SECONDS);
  const refresh = randomToken();
  await env.DB.prepare('INSERT INTO oauth_refresh_tokens (token_hash, agent_id, client_id, expires_at) VALUES (?, ?, ?, ?)')
    .bind(await sha256hex(refresh), agentId, clientId, now + REFRESH_TOKEN_SECONDS)
    .run();
  return json({ access_token: accessToken, token_type: 'Bearer', expires_in: ACCESS_TOKEN_SECONDS, refresh_token: refresh });
}

async function revokeRefreshTokens(env: Env, agentId: string): Promise<void> {
  await env.DB.prepare('DELETE FROM oauth_refresh_tokens WHERE agent_id = ?').bind(agentId).run();
}

async function codeGrant(env: Env, form: URLSearchParams, clientId: string): Promise<Response> {
  const code = form.get('code') ?? '';
  const verifier = form.get('code_verifier') ?? '';
  const hash = await sha256hex(code);
  const row = await env.DB.prepare('SELECT * FROM oauth_codes WHERE code_hash = ?').bind(hash).first<{
    client_id: string;
    redirect_uri: string;
    code_challenge: string;
    agent_id: string;
    expires_at: number;
    used_at: number | null;
  }>();
  if (!row) return invalidGrant();
  // Burn the code first so it can never be redeemed twice, whatever else fails below.
  const burned = await env.DB.prepare('UPDATE oauth_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL').bind(nowSeconds(), hash).run();
  if ((burned.meta.changes ?? 0) !== 1) {
    await revokeRefreshTokens(env, row.agent_id); // replay: whatever was issued from this code stops refreshing
    return invalidGrant();
  }
  if (row.expires_at <= nowSeconds() || row.client_id !== clientId || row.redirect_uri !== form.get('redirect_uri')) return invalidGrant();
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || b64urlEncode(await sha256(verifier)) !== row.code_challenge) return invalidGrant();

  const agent = await getAgent(env.DB, row.agent_id);
  if (!agent) return invalidGrant();
  return issueTokens(env, agent.agent_id, agent.user_id, clientId);
}

async function refreshGrant(env: Env, form: URLSearchParams, clientId: string): Promise<Response> {
  const hash = await sha256hex(form.get('refresh_token') ?? '');
  const row = await env.DB.prepare('SELECT * FROM oauth_refresh_tokens WHERE token_hash = ?').bind(hash).first<{
    agent_id: string;
    client_id: string;
    expires_at: number;
    consumed_at: number | null;
  }>();
  if (!row || row.client_id !== clientId) return invalidGrant();
  if (row.consumed_at !== null) {
    await revokeRefreshTokens(env, row.agent_id); // a rotated token came back: assume theft
    return invalidGrant();
  }
  if (row.expires_at <= nowSeconds()) return invalidGrant();
  const used = await env.DB.prepare('UPDATE oauth_refresh_tokens SET consumed_at = ? WHERE token_hash = ? AND consumed_at IS NULL').bind(nowSeconds(), hash).run();
  if ((used.meta.changes ?? 0) !== 1) return invalidGrant();

  const agent = await getAgent(env.DB, row.agent_id);
  if (!agent) return invalidGrant();
  return issueTokens(env, agent.agent_id, agent.user_id, clientId);
}
