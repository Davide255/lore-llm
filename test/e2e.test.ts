import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { _resetJwksCache } from '../src/auth/cognito';
import { b64urlEncode, nowSeconds } from '../src/auth/jwt';
import type { Env } from '../src/env';
import { makeCtx, makeEnv } from './fakes';

const enc = new TextEncoder();
const ISS = 'https://cognito-idp.eu-north-1.amazonaws.com/eu-north-1_TEST';

let env: Env;
let bucket: ReturnType<typeof makeEnv>['bucket'];
let pair: CryptoKeyPair;
let seq = 0;

async function cognito(userId: string) {
  const h = b64urlEncode(enc.encode(JSON.stringify({ alg: 'RS256', kid: 'k1' })));
  const p = b64urlEncode(
    enc.encode(JSON.stringify({ iss: ISS, sub: userId, token_use: 'id', aud: 'client-1', exp: nowSeconds() + 60 })),
  );
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, enc.encode(`${h}.${p}`));
  return `${h}.${p}.${b64urlEncode(new Uint8Array(sig))}`;
}

async function call(path: string, init: RequestInit & { token: string }) {
  const { ctx, flush } = makeCtx();
  const { token, ...rest } = init;
  const res = await worker.fetch(
    new Request(`https://x.test${path}`, { ...rest, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } }),
    env,
    ctx,
  );
  await flush();
  return res;
}

async function mcp(token: string, method: string, params?: unknown) {
  const res = await call('/mcp', { method: 'POST', token, body: JSON.stringify({ jsonrpc: '2.0', id: ++seq, method, params }) });
  return { status: res.status, body: (res.status === 202 ? null : await res.json()) as any };
}
async function tool(token: string, name: string, args: unknown) {
  const { body } = await mcp(token, 'tools/call', { name, arguments: args });
  return { text: body.result.content[0].text as string, isError: body.result.isError === true };
}

async function newAgent(user: string, scope: string, level: string) {
  const res = await call('/v1/agents', {
    method: 'POST',
    token: await cognito(user),
    body: JSON.stringify({ name: 'bot', project_scope: scope, access_level: level }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { agent: { agent_id: string }; token: string };
}

beforeEach(async () => {
  ({ env, bucket } = makeEnv());
  _resetJwksCache();
  pair = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const jwk = { ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid: 'k1' };
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ keys: [jwk] })));
});
afterEach(() => vi.unstubAllGlobals());

describe('MCP protocol', () => {
  it('handles initialize, notifications, ping, tools/list and unknown methods', async () => {
    const { token } = await newAgent('u1', '*', 'read_write');
    const init = await mcp(token, 'initialize', { protocolVersion: '2025-03-26' });
    expect(init.body.result.protocolVersion).toBe('2025-03-26');
    const note = await call('/mcp', { method: 'POST', token, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
    expect(note.status).toBe(202);
    expect((await mcp(token, 'ping')).body.result).toEqual({});
    const list = await mcp(token, 'tools/list');
    expect(list.body.result.tools.map((t: any) => t.name)).toEqual([
      'list_projects', 'list_files', 'read_file', 'write_file', 'append_file', 'delete_file',
    ]);
    expect((await mcp(token, 'nope')).body.error.code).toBe(-32601);
  });

  it('requires a valid agent token and returns 405 on GET', async () => {
    expect((await call('/mcp', { method: 'POST', token: 'garbage', body: '{}' })).status).toBe(401);
    const { token } = await newAgent('u1', '*', 'read_write');
    expect((await call('/mcp', { method: 'GET', token })).status).toBe(405);
  });

  it('rejects browser origins that are not allowed', async () => {
    const { token } = await newAgent('u1', '*', 'read_write');
    const { ctx } = makeCtx();
    const res = await worker.fetch(
      new Request('https://x.test/mcp', { method: 'POST', headers: { authorization: `Bearer ${token}`, origin: 'https://evil.test' }, body: '{}' }),
      env,
      ctx,
    );
    expect(res.status).toBe(403);
  });
});

describe('file tools', () => {
  it('creates, reads, updates and deletes; keeps index.md in sync', async () => {
    const { token } = await newAgent('u1', '*', 'read_write');
    expect((await tool(token, 'write_file', { path: 'Alpha/notes/a.md', content: '# A' })).text).toBe('Created Alpha/notes/a.md');
    expect((await tool(token, 'read_file', { path: 'Alpha/notes/a.md' })).text).toBe('# A');
    expect((await tool(token, 'write_file', { path: 'Alpha/notes/a.md', content: 'x' })).isError).toBe(true); // no silent overwrite
    expect((await tool(token, 'write_file', { path: 'Alpha/notes/a.md', content: 'v2', overwrite: true })).text).toBe('Updated Alpha/notes/a.md');

    const index = (await tool(token, 'read_file', { path: 'Alpha/index.md' })).text;
    expect(index).toContain('## notes/');
    expect(index).toContain('[a.md](notes/a.md)');
    expect(index).not.toContain('index.md');

    expect(JSON.parse((await tool(token, 'list_projects', {})).text)).toEqual(['Alpha']);
    expect((await tool(token, 'delete_file', { path: 'Alpha/notes/a.md' })).text).toBe('Deleted Alpha/notes/a.md');
    expect(bucket.objects.has('u1/Alpha/index.md')).toBe(false); // empty project: index removed
    expect((await tool(token, 'read_file', { path: 'Alpha/notes/a.md' })).isError).toBe(true);
  });

  it('protects index.md from agents', async () => {
    const { token } = await newAgent('u1', '*', 'read_write');
    await tool(token, 'write_file', { path: 'Alpha/a.md', content: 'x' });
    for (const [name, extra] of [['write_file', { content: 'hack' }], ['append_file', { content: 'hack' }], ['delete_file', {}]] as const) {
      expect((await tool(token, name, { path: 'Alpha/INDEX.md', ...extra })).isError).toBe(true);
    }
  });

  it('blocks traversal and non-markdown paths as tool errors', async () => {
    const { token } = await newAgent('u1', '*', 'read_write');
    for (const path of ['../u2/Alpha/a.md', 'Alpha/../../u2/a.md', 'Alpha/a.txt']) {
      expect((await tool(token, 'read_file', { path })).isError).toBe(true);
    }
  });

  it('enforces read_only and project scope', async () => {
    const rw = await newAgent('u1', '*', 'read_write');
    await tool(rw.token, 'write_file', { path: 'Alpha/a.md', content: 'x' });
    await tool(rw.token, 'write_file', { path: 'Beta/b.md', content: 'y' });

    const ro = await newAgent('u1', '*', 'read_only');
    expect((await tool(ro.token, 'read_file', { path: 'Alpha/a.md' })).text).toBe('x');
    expect((await tool(ro.token, 'write_file', { path: 'Alpha/z.md', content: 'n' })).isError).toBe(true);

    const scoped = await newAgent('u1', 'Alpha/*', 'read_write');
    expect(JSON.parse((await tool(scoped.token, 'list_projects', {})).text)).toEqual(['Alpha']);
    expect((await tool(scoped.token, 'read_file', { path: 'Beta/b.md' })).isError).toBe(true);
    expect((await tool(scoped.token, 'write_file', { path: 'Beta/c.md', content: 'n' })).isError).toBe(true);
  });

  it('isolates tenants: same path, different user', async () => {
    const a = await newAgent('u1', '*', 'read_write');
    const b = await newAgent('u2', '*', 'read_write');
    await tool(a.token, 'write_file', { path: 'Alpha/secret.md', content: 'u1-only' });
    expect((await tool(b.token, 'read_file', { path: 'Alpha/secret.md' })).isError).toBe(true);
    expect(JSON.parse((await tool(b.token, 'list_projects', {})).text)).toEqual([]);
  });

  it('does not lose concurrent appends', async () => {
    const { token } = await newAgent('u1', '*', 'read_write');
    await Promise.all([1, 2, 3, 4].map((i) => tool(token, 'append_file', { path: 'Alpha/checklist.md', content: `- [ ] task ${i}\n` })));
    const text = (await tool(token, 'read_file', { path: 'Alpha/checklist.md' })).text;
    for (const i of [1, 2, 3, 4]) expect(text).toContain(`task ${i}`);
  });

  it('rejects oversized files', async () => {
    const { token } = await newAgent('u1', '*', 'read_write');
    expect((await tool(token, 'write_file', { path: 'Alpha/big.md', content: 'a'.repeat(1024 * 1024 + 1) })).isError).toBe(true);
  });
});

describe('management API', () => {
  it('lists agents without leaking other users, revokes immediately, and audits modifications', async () => {
    const owner = await cognito('u1');
    const other = await cognito('u2');
    const { agent, token } = await newAgent('u1', '*', 'read_write');

    await tool(token, 'write_file', { path: 'Alpha/a.md', content: 'x' });
    await tool(token, 'write_file', { path: 'Alpha/a.md', content: 'y', overwrite: true });
    await tool(token, 'delete_file', { path: 'Alpha/a.md' });

    const audit = (await (await call('/v1/audit', { method: 'GET', token: owner })).json()) as any;
    expect(audit.items.map((i: any) => [i.action, i.target_path, i.agent_id])).toEqual([
      ['DELETE', 'Alpha/a.md', agent.agent_id],
      ['UPDATE', 'Alpha/a.md', agent.agent_id],
      ['CREATE', 'Alpha/a.md', agent.agent_id],
    ]);
    expect(((await (await call('/v1/audit', { method: 'GET', token: other })).json()) as any).items).toEqual([]);
    expect(((await (await call('/v1/audit?limit=1', { method: 'GET', token: owner })).json()) as any).next_before).not.toBeNull();

    expect((await call(`/v1/agents/${agent.agent_id}`, { method: 'DELETE', token: other })).status).toBe(404);
    expect((await call(`/v1/agents/${agent.agent_id}`, { method: 'PATCH', token: other, body: '{"access_level":"read_only"}' })).status).toBe(404);

    expect((await call(`/v1/agents/${agent.agent_id}`, { method: 'PATCH', token: owner, body: '{"access_level":"read_only"}' })).status).toBe(200);
    expect((await tool(token, 'write_file', { path: 'Alpha/n.md', content: 'x' })).isError).toBe(true);

    expect((await call(`/v1/agents/${agent.agent_id}`, { method: 'DELETE', token: owner })).status).toBe(200);
    expect((await call('/mcp', { method: 'POST', token, body: '{}' })).status).toBe(401);
    // logs outlive the revoked agent
    expect(((await (await call('/v1/audit', { method: 'GET', token: owner })).json()) as any).items).toHaveLength(3);
  });

  it('validates input and requires a Cognito token', async () => {
    const owner = await cognito('u1');
    const bad = await call('/v1/agents', { method: 'POST', token: owner, body: JSON.stringify({ name: 'x', project_scope: 'Alpha', access_level: 'read_write' }) });
    expect(bad.status).toBe(400);
    expect((await call('/v1/agents', { method: 'GET', token: 'nope' })).status).toBe(401);
  });

  it('reindex rebuilds a stale index', async () => {
    const owner = await cognito('u1');
    const { token } = await newAgent('u1', '*', 'read_write');
    await tool(token, 'write_file', { path: 'Alpha/a.md', content: 'x' });
    bucket.objects.get('u1/Alpha/index.md')!.body = 'stale';
    expect((await call('/v1/projects/Alpha/reindex', { method: 'POST', token: owner })).status).toBe(200);
    expect(bucket.objects.get('u1/Alpha/index.md')!.body).toContain('[a.md](a.md)');
  });
});
