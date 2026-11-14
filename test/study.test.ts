import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { _resetJwksCache } from '../src/auth/cognito';
import { b64urlEncode, nowSeconds } from '../src/auth/jwt';
import type { Env } from '../src/env';
import { makeCtx, makeEnv } from './fakes';

const enc = new TextEncoder();
const ISS = 'https://cognito-idp.eu-north-1.amazonaws.com/eu-north-1_TEST';
const LAMBDA = 'https://abc.lambda-url.eu-north-1.on.aws/';
let env: Env;
let pair: CryptoKeyPair;
let upstream: { url: string; init: RequestInit }[];

async function cognito(userId: string) {
  const h = b64urlEncode(enc.encode(JSON.stringify({ alg: 'RS256', kid: 'k1' })));
  const p = b64urlEncode(enc.encode(JSON.stringify({ iss: ISS, sub: userId, token_use: 'id', aud: 'client-1', exp: nowSeconds() + 60 })));
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, enc.encode(`${h}.${p}`));
  return `${h}.${p}.${b64urlEncode(new Uint8Array(sig))}`;
}

async function call(path: string, init: { method?: string; token?: string; body?: string } = {}) {
  const { ctx } = makeCtx();
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  return worker.fetch(new Request(`https://x.test${path}`, { method: init.method ?? 'POST', headers, body: init.body }), env, ctx);
}

beforeEach(async () => {
  ({ env } = makeEnv({ STUDY_LAMBDA_URL: LAMBDA }));
  _resetJwksCache();
  upstream = [];
  pair = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const jwk = { ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid: 'k1' };
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes('jwks.json')) return new Response(JSON.stringify({ keys: [jwk] }));
    upstream.push({ url, init: init ?? {} });
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(enc.encode('event: question\ndata: {"index":1}\n\n'));
        c.enqueue(enc.encode('event: done\ndata: {}\n\n'));
        c.close();
      },
    });
    return new Response(stream, { headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('/v1/study-mode', () => {
  it('forwards the body and the caller token to the Lambda and streams its events back', async () => {
    const token = await cognito('u1');
    const res = await call('/v1/study-mode/generate', { token, body: '{"sources":[]}' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(await res.text()).toBe('event: question\ndata: {"index":1}\n\nevent: done\ndata: {}\n\n');
    expect(upstream).toHaveLength(1);
    expect(upstream[0]!.url).toBe('https://abc.lambda-url.eu-north-1.on.aws/generate');
    expect((upstream[0]!.init.headers as Record<string, string>).authorization).toBe(`Bearer ${token}`);
    expect(new TextDecoder().decode(upstream[0]!.init.body as ArrayBuffer)).toBe('{"sources":[]}');

    await call('/v1/study-mode/grade', { token, body: '{}' });
    expect(upstream[1]!.url).toBe('https://abc.lambda-url.eu-north-1.on.aws/grade');
  });

  it('needs a valid token and never calls the Lambda without one', async () => {
    expect((await call('/v1/study-mode/generate', { body: '{}' })).status).toBe(401);
    expect((await call('/v1/study-mode/generate', { token: 'nope', body: '{}' })).status).toBe(401);
    expect(upstream).toHaveLength(0);
  });

  it('rejects unknown operations, other methods, large bodies, and answers 503 when not configured', async () => {
    const token = await cognito('u1');
    expect((await call('/v1/study-mode/other', { token, body: '{}' })).status).toBe(404);
    expect((await call('/v1/study-mode/generate', { token, method: 'GET' })).status).toBe(405);
    expect((await call('/v1/study-mode/generate', { token, body: 'x'.repeat(1024 * 1024 + 1) })).status).toBe(413);
    ({ env } = makeEnv());
    expect((await call('/v1/study-mode/generate', { token: await cognito('u1'), body: '{}' })).status).toBe(503);
    expect(upstream).toHaveLength(0);
  });
});
