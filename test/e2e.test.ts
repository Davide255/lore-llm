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
      'read_file_lines', 'search_files', 'patch_file',
      'get_checklist', 'add_checklist_item', 'check_item', 'edit_checklist_item', 'delete_checklist_item', 'move_checklist_item',
      'create_project', 'rename_project', 'delete_project',
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

describe('lines, search and patch tools', () => {
  it('reads line ranges, searches and patches', async () => {
    const { token } = await newAgent('u1', '*', 'read_write');
    await tool(token, 'write_file', { path: 'Alpha/a.md', content: 'one\ntwo\nthree' });
    expect((await tool(token, 'read_file_lines', { path: 'Alpha/a.md', startLine: 2, endLine: 3 })).text).toContain('2: two\n3: three');
    expect((await tool(token, 'read_file_lines', { path: 'Alpha/a.md', startLine: 9 })).isError).toBe(true);
    expect(JSON.parse((await tool(token, 'search_files', { query: 'TWO' })).text)[0].path).toBe('Alpha/a.md');
    expect((await tool(token, 'search_files', { query: 'zzz' })).text).toContain('No results');
    await tool(token, 'patch_file', { path: 'Alpha/a.md', startLine: 2, endLine: 2, newContent: 'x\ny' });
    expect((await tool(token, 'read_file', { path: 'Alpha/a.md' })).text).toBe('one\nx\ny\nthree');
    expect((await tool(token, 'patch_file', { path: 'Alpha/index.md', startLine: 1, endLine: 1, newContent: 'h' })).isError).toBe(true);
    expect((await tool(token, 'patch_file', { path: 'Alpha/none.md', startLine: 1, endLine: 1, newContent: 'h' })).isError).toBe(true);
  });
});

describe('checklist tools', () => {
  it('adds, checks, edits, moves and deletes items', async () => {
    const { token } = await newAgent('u1', '*', 'read_write');
    expect((await tool(token, 'get_checklist', { project: 'Alpha' })).isError).toBe(true);
    await tool(token, 'add_checklist_item', { project: 'Alpha', item: 'Login page', version: 'v1.0.0' });
    await tool(token, 'add_checklist_item', { project: 'Alpha', item: 'Logout', version: 'v1.0.0' });
    await tool(token, 'check_item', { project: 'Alpha', item: 'login' });
    expect((await tool(token, 'get_checklist', { project: 'Alpha' })).text).toContain('1/2 completed');
    await tool(token, 'edit_checklist_item', { project: 'Alpha', item: 'logout', newText: 'Sign out' });
    await tool(token, 'move_checklist_item', { project: 'Alpha', item: 'sign out', fromVersion: 'v1.0.0', toVersion: 'v1.1.0' });
    const text = (await tool(token, 'get_checklist', { project: 'Alpha' })).text;
    expect(text).toContain('## v1.1.0\n\n- [ ] Sign out');
    expect(text).toContain('- [x] Login page');
    expect((await tool(token, 'check_item', { project: 'Alpha', item: 'nothing' })).isError).toBe(true);
    await tool(token, 'delete_checklist_item', { project: 'Alpha', item: 'sign out' });
    expect((await tool(token, 'get_checklist', { project: 'Alpha' })).text).not.toContain('Sign out');
    expect((await tool(token, 'add_checklist_item', { project: 'Alpha', item: 'a\nb' })).isError).toBe(true);
  });
});

describe('project tools', () => {
  it('creates, renames and deletes projects', async () => {
    const { token } = await newAgent('u1', '*', 'read_write');
    expect((await tool(token, 'create_project', { project: 'Alpha' })).text).toBe('Created project Alpha');
    expect((await tool(token, 'create_project', { project: 'Alpha' })).isError).toBe(true);
    await tool(token, 'write_file', { path: 'Alpha/sub/a.md', content: 'hi' });
    await tool(token, 'create_project', { project: 'Taken' });
    expect((await tool(token, 'rename_project', { project: 'Alpha', newName: 'Taken' })).isError).toBe(true);
    expect((await tool(token, 'rename_project', { project: 'Alpha', newName: 'Beta' })).isError).toBe(false);
    expect(JSON.parse((await tool(token, 'list_projects', {})).text)).toEqual(['Beta', 'Taken']);
    expect((await tool(token, 'read_file', { path: 'Beta/sub/a.md' })).text).toBe('hi');
    expect((await tool(token, 'read_file', { path: 'Beta/index.md' })).text).toContain('sub/');
    expect((await tool(token, 'delete_project', { project: 'Beta' })).isError).toBe(true); // needs confirm
    expect((await tool(token, 'delete_project', { project: 'Beta', confirm: true })).isError).toBe(false);
    expect((await tool(token, 'delete_project', { project: 'Beta', confirm: true })).isError).toBe(true);
    expect(JSON.parse((await tool(token, 'list_projects', {})).text)).toEqual(['Taken']);
  });

  it('respects scope and read-only agents', async () => {
    const scoped = await newAgent('u1', 'Alpha/*', 'read_write');
    expect((await tool(scoped.token, 'create_project', { project: 'Alpha' })).isError).toBe(false);
    expect((await tool(scoped.token, 'create_project', { project: 'Other' })).isError).toBe(true);
    expect((await tool(scoped.token, 'rename_project', { project: 'Alpha', newName: 'Other' })).isError).toBe(true);
    const ro = await newAgent('u1', '*', 'read_only');
    for (const [n, a] of [['create_project', { project: 'Z' }], ['rename_project', { project: 'Alpha', newName: 'Z' }], ['delete_project', { project: 'Alpha', confirm: true }], ['patch_file', { path: 'Alpha/a.md', startLine: 1, endLine: 1, newContent: 'x' }], ['add_checklist_item', { project: 'Alpha', item: 'x' }]] as const) {
      expect((await tool(ro.token, n, a)).isError).toBe(true);
    }
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

  it('stores the agent type, defaults it for older clients, and validates it', async () => {
    const owner = await cognito('u1');
    const create = (b: object) => call('/v1/agents', { method: 'POST', token: owner, body: JSON.stringify({ project_scope: '*', access_level: 'read_write', ...b }) });
    const codex = (await (await create({ name: 'My Codex', agent_type: 'codex' })).json()) as any;
    expect(codex.agent).toMatchObject({ name: 'My Codex', agent_type: 'codex' });
    expect(((await (await create({ name: 'Old client' })).json()) as any).agent.agent_type).toBe('claude');
    expect((await create({ name: 'x', agent_type: 'gemini' })).status).toBe(400);

    const id = codex.agent.agent_id;
    expect((await call(`/v1/agents/${id}`, { method: 'PATCH', token: owner, body: '{"agent_type":"claude"}' })).status).toBe(200);
    expect((await call(`/v1/agents/${id}`, { method: 'PATCH', token: owner, body: '{"agent_type":"nope"}' })).status).toBe(400);
    const list = (await (await call('/v1/agents', { method: 'GET', token: owner })).json()) as any;
    expect(list.agents.find((a: any) => a.agent_id === id).agent_type).toBe('claude');
  });

  it('validates input and requires a Cognito token', async () => {
    const owner = await cognito('u1');
    const bad = await call('/v1/agents', { method: 'POST', token: owner, body: JSON.stringify({ name: 'x', project_scope: 'Alpha', access_level: 'read_write' }) });
    expect(bad.status).toBe(400);
    expect((await call('/v1/agents', { method: 'GET', token: 'nope' })).status).toBe(401);
  });

  it('files API: user CRUD, conflicts, index protection, tenant isolation', async () => {
    const owner = await cognito('u1');
    const put = (path: string, b: unknown) => call(`/v1/file?path=${encodeURIComponent(path)}`, { method: 'PUT', token: owner, body: JSON.stringify(b) });

    const created = await put('Alpha/notes/a.md', { content: '# A' });
    expect(created.status).toBe(201);
    const { file } = (await created.json()) as any;
    expect((await put('Alpha/notes/a.md', { content: 'x' })).status).toBe(400); // no silent overwrite

    const list = (await (await call('/v1/files', { method: 'GET', token: owner })).json()) as any;
    expect(list.files.map((f: any) => f.path)).toEqual(['Alpha/index.md', 'Alpha/notes/a.md']);

    const read = (await (await call('/v1/file?path=Alpha/notes/a.md', { method: 'GET', token: owner })).json()) as any;
    expect(read).toMatchObject({ path: 'Alpha/notes/a.md', content: '# A', etag: file.etag });

    expect((await put('Alpha/notes/a.md', { content: 'v2', overwrite: true, if_match: file.etag })).status).toBe(200);
    expect((await put('Alpha/notes/a.md', { content: 'v3', overwrite: true, if_match: file.etag })).status).toBe(409); // stale etag
    expect((await put('Alpha/index.md', { content: 'hack', overwrite: true })).status).toBe(400);
    expect((await call('/v1/file?path=Alpha/index.md', { method: 'DELETE', token: owner })).status).toBe(400);
    expect((await call('/v1/file?path=../u2/Alpha/a.md', { method: 'GET', token: owner })).status).toBe(400);

    // An agent sees what the user wrote, and vice versa.
    const { token } = await newAgent('u1', '*', 'read_write');
    expect((await tool(token, 'read_file', { path: 'Alpha/notes/a.md' })).text).toBe('v2');

    const other = await cognito('u2');
    expect(((await (await call('/v1/files', { method: 'GET', token: other })).json()) as any).files).toEqual([]);
    expect((await call('/v1/file?path=Alpha/notes/a.md', { method: 'GET', token: other })).status).toBe(404);

    expect((await call('/v1/file?path=Alpha/notes/a.md', { method: 'DELETE', token: owner })).status).toBe(200);
    expect(bucket.objects.has('u1/Alpha/index.md')).toBe(false);
  });

  it('files API: moves files and folders, deletes folders', async () => {
    const owner = await cognito('u1');
    const put = (path: string, content: string) => call(`/v1/file?path=${encodeURIComponent(path)}`, { method: 'PUT', token: owner, body: JSON.stringify({ content }) });
    const move = (from: string, to: string) => call('/v1/files/move', { method: 'POST', token: owner, body: JSON.stringify({ from, to }) });
    await put('Alpha/a.md', 'a');
    await put('Alpha/sub/b.md', 'b');

    expect((await move('Alpha/a.md', 'Alpha/sub/b.md')).status).toBe(400); // destination exists
    expect((await move('Alpha/a.md', 'Alpha/renamed.md')).status).toBe(200);
    expect((await move('Alpha', 'Alpha/sub')).status).toBe(400); // into itself
    expect((await move('Alpha', 'Beta')).status).toBe(200);
    expect([...bucket.objects.keys()].sort()).toEqual(['u1/Beta/index.md', 'u1/Beta/renamed.md', 'u1/Beta/sub/b.md']);
    expect(bucket.text('u1/Beta/index.md')).toContain('[renamed.md](renamed.md)');

    const del = await call('/v1/folder?path=Beta/sub', { method: 'DELETE', token: owner });
    expect(((await del.json()) as any).deleted).toBe(1);
    expect(bucket.text('u1/Beta/index.md')).not.toContain('sub/');
    expect((await call('/v1/folder?path=Beta', { method: 'DELETE', token: owner })).status).toBe(200);
    expect(bucket.objects.size).toBe(0);
  });

  it('attachments: blob round-trip, conflicts, size limit, opt-in listing, index excludes them', async () => {
    const owner = await cognito('u1');
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255, 254]);
    const putBlob = (path: string, bytes: Uint8Array, q = '', headers: Record<string, string> = {}) =>
      worker.fetch(
        new Request(`https://x.test/v1/blob?path=${encodeURIComponent(path)}${q}`, {
          method: 'PUT',
          headers: { authorization: `Bearer ${owner}`, ...headers },
          body: bytes,
        }),
        env,
        makeCtx().ctx,
      );

    await call('/v1/file?path=Alpha/a.md', { method: 'PUT', token: owner, body: JSON.stringify({ content: '![[pic.png]]' }) });
    const created = await putBlob('Alpha/img/pic.png', png);
    expect(created.status).toBe(201);
    const { file } = (await created.json()) as any;
    expect(bucket.objects.get('u1/Alpha/img/pic.png')!.contentType).toBe('image/png');

    const got = await call('/v1/blob?path=Alpha/img/pic.png', { method: 'GET', token: owner });
    expect(got.headers.get('content-type')).toBe('image/png');
    expect(got.headers.get('x-lore-etag')).toBe(file.etag);
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(png);

    expect((await putBlob('Alpha/img/pic.png', png)).status).toBe(400); // no silent overwrite
    expect((await putBlob('Alpha/img/pic.png', new Uint8Array([1]), '&overwrite=1', { 'if-match': file.etag })).status).toBe(200);
    expect((await putBlob('Alpha/img/pic.png', new Uint8Array([2]), '&overwrite=1', { 'if-match': file.etag })).status).toBe(409);
    expect((await putBlob('Alpha/big.pdf', new Uint8Array(10 * 1024 * 1024 + 1))).status).toBe(400);
    expect((await putBlob('Alpha/x.exe', png)).status).toBe(400);
    expect((await putBlob('Alpha/a.md', png)).status).toBe(400); // notes go through /v1/file
    expect((await call('/v1/file?path=Alpha/img/pic.png', { method: 'GET', token: owner })).status).toBe(400);

    const plain = (await (await call('/v1/files', { method: 'GET', token: owner })).json()) as any;
    expect(plain.files.map((f: any) => f.path)).toEqual(['Alpha/a.md', 'Alpha/index.md']);
    const all = (await (await call('/v1/files?attachments=1', { method: 'GET', token: owner })).json()) as any;
    expect(all.files.map((f: any) => f.path)).toEqual(['Alpha/a.md', 'Alpha/img/pic.png', 'Alpha/index.md']);
    expect(bucket.text('u1/Alpha/index.md')).not.toContain('pic.png');

    expect((await call('/v1/file?path=Alpha/img/pic.png', { method: 'DELETE', token: owner })).status).toBe(200);
    expect(bucket.objects.has('u1/Alpha/img/pic.png')).toBe(false);
  });

  it('attachments: moves keep bytes and etag; agents cannot read or write them', async () => {
    const owner = await cognito('u1');
    const bytes = new Uint8Array(256).map((_, i) => i);
    await call('/v1/file?path=Alpha/a.md', { method: 'PUT', token: owner, body: JSON.stringify({ content: 'a' }) });
    await worker.fetch(
      new Request('https://x.test/v1/blob?path=Alpha/img/p.png', { method: 'PUT', headers: { authorization: `Bearer ${owner}` }, body: bytes }),
      env,
      makeCtx().ctx,
    );
    const etag = bucket.objects.get('u1/Alpha/img/p.png')!.etag;
    const move = (from: string, to: string) => call('/v1/files/move', { method: 'POST', token: owner, body: JSON.stringify({ from, to }) });

    expect((await move('Alpha/img/p.png', 'Alpha/img/p.md')).status).toBe(400); // no type change
    expect((await move('Alpha/img/p.png', 'Alpha/img/q.png')).status).toBe(200);
    expect((await move('Alpha', 'Beta')).status).toBe(200);
    const moved = bucket.objects.get('u1/Beta/img/q.png')!;
    expect(moved.bytes).toEqual(bytes);
    expect(moved.etag).toBe(etag);
    expect(moved.contentType).toBe('image/png');

    const { token } = await newAgent('u1', '*', 'read_write');
    const files = JSON.parse((await tool(token, 'list_files', { project: 'Beta' })).text);
    expect(files.find((f: any) => f.path === 'img/q.png').attachment).toBe(true);
    const read = await tool(token, 'read_file', { path: 'Beta/img/q.png' });
    expect(read.isError).toBe(true);
    expect(read.text).toContain('binary attachment');
    expect((await tool(token, 'write_file', { path: 'Beta/img/x.png', content: 'x' })).isError).toBe(true);
    expect((await tool(token, 'delete_file', { path: 'Beta/img/q.png' })).isError).toBe(true);
  });

  it('change cursor: bumped by user writes and agent writes, per user', async () => {
    const owner = await cognito('u1');
    const version = async (t: string) => ((await (await call('/v1/version', { method: 'GET', token: t })).json()) as any).version;
    expect(await version(owner)).toBe(0);
    await call('/v1/file?path=Alpha/a.md', { method: 'PUT', token: owner, body: JSON.stringify({ content: 'a' }) });
    expect(await version(owner)).toBe(1);
    await call('/v1/file?path=Alpha/a.md', { method: 'PUT', token: owner, body: JSON.stringify({ content: 'dup' }) }); // 400: no bump
    expect(await version(owner)).toBe(1);
    const { token } = await newAgent('u1', '*', 'read_write');
    await tool(token, 'write_file', { path: 'Alpha/b.md', content: 'b' });
    expect(await version(owner)).toBe(2);
    expect(await version(await cognito('u2'))).toBe(0);
  });

  it('reindex rebuilds a stale index', async () => {
    const owner = await cognito('u1');
    const { token } = await newAgent('u1', '*', 'read_write');
    await tool(token, 'write_file', { path: 'Alpha/a.md', content: 'x' });
    bucket.objects.get('u1/Alpha/index.md')!.bytes = new TextEncoder().encode('stale');
    expect((await call('/v1/projects/Alpha/reindex', { method: 'POST', token: owner })).status).toBe(200);
    expect(bucket.text('u1/Alpha/index.md')).toContain('[a.md](a.md)');
  });
});
