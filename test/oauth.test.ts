import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { _resetJwksCache } from '../src/auth/cognito';
import { b64urlEncode, nowSeconds } from '../src/auth/jwt';
import type { Env } from '../src/env';
import { makeCtx, makeEnv } from './fakes';

const enc = new TextEncoder();
const ISS = 'https://cognito-idp.eu-north-1.amazonaws.com/eu-north-1_TEST';
const ORIGIN = 'https://x.test';
const REDIRECT = 'https://client.test/cb';
const OAUTH_CLIENT = 'oauth-cognito-client';

let env: Env;
let pair: CryptoKeyPair;
let cognitoUser = 'user-1';
let cognitoTokenCalls = 0;

async function idToken(userId: string) {
  const h = b64urlEncode(enc.encode(JSON.stringify({ alg: 'RS256', kid: 'k1' })));
  const p = b64urlEncode(
    enc.encode(JSON.stringify({ iss: ISS, sub: userId, token_use: 'id', aud: OAUTH_CLIENT, exp: nowSeconds() + 60 })),
  );
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, enc.encode(`${h}.${p}`));
  return `${h}.${p}.${b64urlEncode(new Uint8Array(sig))}`;
}

async function req(path: string, init: RequestInit = {}) {
  const { ctx, flush } = makeCtx();
  const res = await worker.fetch(new Request(`${ORIGIN}${path}`, { redirect: 'manual', ...init }), env, ctx);
  await flush();
  return res;
}
const form = (o: Record<string, string>) => ({
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(o).toString(),
});

async function pkce() {
  const verifier = b64urlEncode(crypto.getRandomValues(new Uint8Array(48)));
  const challenge = b64urlEncode(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(verifier))));
  return { verifier, challenge };
}

async function registerClient(redirect = REDIRECT) {
  const res = await req('/oauth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'Test <b>Client</b>', redirect_uris: [redirect] }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { client_id: string }).client_id;
}

/** Drives authorize -> Cognito callback; returns what the consent form needs. */
async function startFlow(clientId: string, challenge: string, extra: Record<string, string> = {}) {
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'st8',
    ...extra,
  });
  const auth = await req(`/oauth/authorize?${q}`);
  expect(auth.status).toBe(302);
  const loc = new URL(auth.headers.get('location')!);
  expect(loc.host).toBe('login.test');
  const cookie = auth.headers.get('set-cookie')!.split(';')[0]!;
  const txn = loc.searchParams.get('state')!;
  const cb = await req(`/oauth/callback?code=cog-code&state=${txn}`, { headers: { cookie } });
  expect(cb.status).toBe(200);
  const html = await cb.text();
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)![1]!;
  return { txn, csrf, cookie, html };
}

async function fullFlow(opts: { level?: string } = {}) {
  const clientId = await registerClient();
  const { verifier, challenge } = await pkce();
  const { txn, csrf, cookie } = await startFlow(clientId, challenge);
  const consent = await req('/oauth/consent', {
    ...form({ txn, csrf, decision: 'allow', name: 'My agent', access_level: opts.level ?? 'read_write' }),
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
  });
  expect(consent.status).toBe(302);
  const back = new URL(consent.headers.get('location')!);
  expect(back.origin + back.pathname).toBe(REDIRECT);
  expect(back.searchParams.get('state')).toBe('st8');
  return { clientId, verifier, code: back.searchParams.get('code')! };
}

const tokenReq = (o: Record<string, string>) => req('/oauth/token', form(o));
async function exchange(f: { clientId: string; verifier: string; code: string }) {
  return tokenReq({ grant_type: 'authorization_code', client_id: f.clientId, code: f.code, redirect_uri: REDIRECT, code_verifier: f.verifier });
}
async function mcpList(accessToken: string) {
  return req('/mcp', {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
}

beforeEach(async () => {
  ({ env } = makeEnv({ COGNITO_DOMAIN: 'login.test', OAUTH_COGNITO_CLIENT_ID: OAUTH_CLIENT }));
  cognitoUser = 'user-1';
  cognitoTokenCalls = 0;
  _resetJwksCache();
  pair = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const jwk = { ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid: 'k1' };
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = String(input instanceof Request ? input.url : input);
    if (u === 'https://login.test/oauth2/token') {
      cognitoTokenCalls++;
      expect(String(init?.body)).toContain('code_verifier=');
      return new Response(JSON.stringify({ id_token: await idToken(cognitoUser) }));
    }
    return new Response(JSON.stringify({ keys: [jwk] }));
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('discovery', () => {
  it('serves protected-resource and authorization-server metadata', async () => {
    const pr = (await (await req('/.well-known/oauth-protected-resource')).json()) as any;
    expect(pr).toMatchObject({ resource: `${ORIGIN}/mcp`, authorization_servers: [ORIGIN] });
    const asm = (await (await req('/.well-known/oauth-authorization-server')).json()) as any;
    expect(asm.code_challenge_methods_supported).toEqual(['S256']);
    expect(asm.registration_endpoint).toBe(`${ORIGIN}/oauth/register`);
  });

  it('adds resource_metadata to the 401 challenge', async () => {
    const res = await req('/mcp', { method: 'POST', body: '{}' });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain(`resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource"`);
  });

  it('is invisible when OAuth is not configured', async () => {
    ({ env } = makeEnv());
    expect((await req('/.well-known/oauth-protected-resource')).status).toBe(404);
    expect((await req('/oauth/register', { method: 'POST' })).status).toBe(404);
    const res = await req('/mcp', { method: 'POST', body: '{}' });
    expect(res.headers.get('www-authenticate')).toBe('Bearer realm="lore-llm"');
  });
});

describe('client registration', () => {
  it('rejects bad redirect URIs', async () => {
    for (const bad of ['http://evil.test/cb', 'javascript:alert(1)', 'https://a.test/cb#frag', 'nope']) {
      const res = await req('/oauth/register', { method: 'POST', body: JSON.stringify({ redirect_uris: [bad] }) });
      expect(res.status).toBe(400);
    }
    expect((await registerClient('http://localhost:3000/cb')).length).toBeGreaterThan(0);
  });
});

describe('authorize', () => {
  it('never redirects to an unregistered redirect_uri', async () => {
    const clientId = await registerClient();
    const { challenge } = await pkce();
    const q = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: 'https://evil.test/cb', code_challenge: challenge, code_challenge_method: 'S256' });
    const res = await req(`/oauth/authorize?${q}`);
    expect(res.status).toBe(400);
    expect(res.headers.get('location')).toBeNull();
  });

  it('requires S256 PKCE', async () => {
    const clientId = await registerClient();
    const q = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, state: 's' });
    const res = await req(`/oauth/authorize?${q}`);
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get('location')!).searchParams.get('error')).toBe('invalid_request');
  });

  it('rejects a callback without the browser cookie', async () => {
    const clientId = await registerClient();
    const { challenge } = await pkce();
    const q = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256' });
    const auth = await req(`/oauth/authorize?${q}`);
    const txn = new URL(auth.headers.get('location')!).searchParams.get('state')!;
    expect((await req(`/oauth/callback?code=c&state=${txn}`)).status).toBe(400);
    expect(cognitoTokenCalls).toBe(0);
  });

  it('escapes the client name on the consent page', async () => {
    const clientId = await registerClient();
    const { challenge } = await pkce();
    const { html } = await startFlow(clientId, challenge);
    expect(html).not.toContain('<b>Client</b>');
    expect(html).toContain('&lt;b&gt;Client&lt;/b&gt;');
  });
});

describe('consent', () => {
  it('rejects a post without the cookie or with a wrong csrf token', async () => {
    const clientId = await registerClient();
    const { challenge } = await pkce();
    const { txn, csrf, cookie } = await startFlow(clientId, challenge);
    const body = { txn, csrf, decision: 'allow', name: 'a', access_level: 'read_only' };
    expect((await req('/oauth/consent', form(body))).status).toBe(403);
    const bad = await req('/oauth/consent', { ...form({ ...body, csrf: 'nope' }), headers: { 'content-type': 'application/x-www-form-urlencoded', cookie } });
    expect(bad.status).toBe(403);
  });

  it('deny redirects with access_denied and creates no agent', async () => {
    const clientId = await registerClient();
    const { challenge } = await pkce();
    const { txn, csrf, cookie } = await startFlow(clientId, challenge);
    const res = await req('/oauth/consent', { ...form({ txn, csrf, decision: 'deny' }), headers: { 'content-type': 'application/x-www-form-urlencoded', cookie } });
    expect(new URL(res.headers.get('location')!).searchParams.get('error')).toBe('access_denied');
    expect((env.DB as any).raw.prepare('SELECT COUNT(*) AS n FROM permissions').get().n).toBe(0);
  });

  it('is single use', async () => {
    const clientId = await registerClient();
    const { challenge } = await pkce();
    const { txn, csrf, cookie } = await startFlow(clientId, challenge);
    const init = { ...form({ txn, csrf, decision: 'allow', name: 'a', access_level: 'read_only' }), headers: { 'content-type': 'application/x-www-form-urlencoded', cookie } };
    expect((await req('/oauth/consent', init)).status).toBe(302);
    expect((await req('/oauth/consent', init)).status).toBe(403);
  });

  it('rejects an invalid form without burning the request, and grants full scope by default', async () => {
    const clientId = await registerClient();
    const { challenge } = await pkce();
    const { txn, csrf, cookie } = await startFlow(clientId, challenge);
    const headers = { 'content-type': 'application/x-www-form-urlencoded', cookie };
    const base = { txn, csrf, decision: 'allow', name: 'a' };
    expect((await req('/oauth/consent', { ...form({ ...base, access_level: 'root' }), headers })).status).toBe(400);
    expect((await req('/oauth/consent', { ...form({ ...base, access_level: 'read_only' }), headers })).status).toBe(302);
    const row = (env.DB as any).raw.prepare('SELECT project_scope, agent_type, access_level FROM permissions').get();
    expect({ ...row }).toEqual({ project_scope: '*', agent_type: 'claude', access_level: 'read_only' });
  });
});

describe('token endpoint', () => {
  it('completes the flow and the access token works on /mcp', async () => {
    const f = await fullFlow();
    const res = await exchange(f);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body).toMatchObject({ token_type: 'Bearer', expires_in: 3600 });
    const list = await mcpList(body.access_token);
    expect(list.status).toBe(200);
    expect(((await list.json()) as any).result.tools.length).toBeGreaterThan(0);
  });

  it('enforces the consented access level', async () => {
    const f = await fullFlow({ level: 'read_only' });
    const { access_token } = (await (await exchange(f)).json()) as any;
    const res = await req('/mcp', {
      method: 'POST',
      headers: { authorization: `Bearer ${access_token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'write_file', arguments: { path: 'P/a.md', content: 'x' } } }),
    });
    expect(((await res.json()) as any).result.isError).toBe(true);
  });

  it('rejects a wrong PKCE verifier', async () => {
    const f = await fullFlow();
    const res = await exchange({ ...f, verifier: (await pkce()).verifier });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toBe('invalid_grant');
  });

  it('rejects code replay and revokes refresh tokens', async () => {
    const f = await fullFlow();
    const first = (await (await exchange(f)).json()) as any;
    expect((await exchange(f)).status).toBe(400);
    const refresh = await tokenReq({ grant_type: 'refresh_token', client_id: f.clientId, refresh_token: first.refresh_token });
    expect(refresh.status).toBe(400);
  });

  it('rejects a mismatched redirect_uri or client', async () => {
    const f = await fullFlow();
    const other = await registerClient();
    expect((await tokenReq({ grant_type: 'authorization_code', client_id: other, code: f.code, redirect_uri: REDIRECT, code_verifier: f.verifier })).status).toBe(400);
  });

  it('rotates refresh tokens and detects reuse', async () => {
    const f = await fullFlow();
    const first = (await (await exchange(f)).json()) as any;
    const r = (rt: string) => tokenReq({ grant_type: 'refresh_token', client_id: f.clientId, refresh_token: rt });
    const second = await r(first.refresh_token);
    expect(second.status).toBe(200);
    const next = (await second.json()) as any;
    expect(next.refresh_token).not.toBe(first.refresh_token);
    expect((await mcpList(next.access_token)).status).toBe(200);
    expect((await r(first.refresh_token)).status).toBe(400); // reuse
    expect((await r(next.refresh_token)).status).toBe(400); // family revoked
  });

  it('stops working when the agent is revoked', async () => {
    const f = await fullFlow();
    const tokens = (await (await exchange(f)).json()) as any;
    const agentId = (env.DB as any).raw.prepare('SELECT agent_id FROM permissions').get().agent_id as string;
    const del = await req(`/v1/agents/${agentId}`, { method: 'DELETE', headers: { authorization: `Bearer ${await mgmtToken()}` } });
    expect(del.status).toBe(200);
    expect((await mcpList(tokens.access_token)).status).toBe(401);
    const refresh = await tokenReq({ grant_type: 'refresh_token', client_id: f.clientId, refresh_token: tokens.refresh_token });
    expect(refresh.status).toBe(400);
  });

  it('still accepts legacy static agent tokens', async () => {
    const created = await req('/v1/agents', {
      method: 'POST',
      headers: { authorization: `Bearer ${await mgmtToken()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'bot', project_scope: '*', access_level: 'read_write' }),
    });
    const { token } = (await created.json()) as any;
    expect((await mcpList(token)).status).toBe(200);
  });
});

/** Management API tokens use the regular client id configured in makeEnv. */
async function mgmtToken() {
  const h = b64urlEncode(enc.encode(JSON.stringify({ alg: 'RS256', kid: 'k1' })));
  const p = b64urlEncode(enc.encode(JSON.stringify({ iss: ISS, sub: 'user-1', token_use: 'id', aud: 'client-1', exp: nowSeconds() + 60 })));
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, enc.encode(`${h}.${p}`));
  return `${h}.${p}.${b64urlEncode(new Uint8Array(sig))}`;
}
