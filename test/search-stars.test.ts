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
let d1: ReturnType<typeof makeEnv>['d1'];
let pair: CryptoKeyPair;

/** An ID token carrying the profile, like the ones the apps send. */
async function token(sub: string, email = `${sub}@example.com`) {
  const h = b64urlEncode(enc.encode(JSON.stringify({ alg: 'RS256', kid: 'k1' })));
  const p = b64urlEncode(
    enc.encode(JSON.stringify({ iss: ISS, sub, email, name: sub.toUpperCase(), token_use: 'id', aud: 'client-1', exp: nowSeconds() + 60 })),
  );
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, enc.encode(`${h}.${p}`));
  return `${h}.${p}.${b64urlEncode(new Uint8Array(sig))}`;
}

const tokens = new Map<string, string>();
async function as(sub: string) {
  if (!tokens.has(sub)) tokens.set(sub, await token(sub));
  return tokens.get(sub)!;
}

async function api(who: string, method: string, path: string, body?: unknown) {
  const { ctx, flush } = makeCtx();
  const res = await worker.fetch(
    new Request(`https://x.test${path}`, {
      method,
      headers: { authorization: `Bearer ${await as(who)}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    env,
    ctx,
  );
  await flush();
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

async function newTeam(who = 'alice', name = 'Core') {
  const res = await api(who, 'POST', '/v1/teams', { name });
  expect(res.status).toBe(201);
  return res.body.team.id as string;
}

/** Invites `who` into the team with `role` and has them accept. */
async function join(teamId: string, who: string, role: 'editor' | 'viewer', inviter = 'alice') {
  const inv = await api(inviter, 'POST', `/v1/teams/${teamId}/invites`, { email: `${who}@example.com`, role });
  expect(inv.status).toBe(201);
  await api(who, 'GET', '/v1/teams'); // first request records the profile
  const ok = await api(who, 'POST', `/v1/invites/${inv.body.invite.id}/accept`);
  expect(ok.status).toBe(200);
}

const put = (who: string, owner: string, path: string, content: string) =>
  api(who, 'PUT', `/v1/file?owner=${encodeURIComponent(owner)}&path=${encodeURIComponent(path)}`, { content });

beforeEach(async () => {
  ({ env, bucket, d1 } = makeEnv());
  tokens.clear();
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



async function newAgent(who: string, scope: string, level: string) {
  const res = await api(who, 'POST', '/v1/agents', { name: 'bot', project_scope: scope, access_level: level });
  expect(res.status).toBe(201);
  return res.body as { token: string };
}
async function tool(token: string, name: string, args: unknown) {
  const res = await worker.fetch(
    new Request('https://x.test/mcp', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    }),
    env,
    makeCtx().ctx,
  );
  return (await res.json()) as any;
}

const q = (who: string, qs: string) => api(who, 'GET', `/v1/search?${qs}`);
const star = (who: string, owner: string, path: string, method = 'PUT') =>
  api(who, method, `/v1/stars?owner=${encodeURIComponent(owner)}&path=${encodeURIComponent(path)}`);
const stars = async (who: string) => (await api(who, 'GET', '/v1/stars')).body.stars.map((s: any) => `${s.owner}|${s.path}`).sort();
const paths = (res: { body: any }) => res.body.hits.map((h: any) => h.path).sort();

describe('search', () => {
  it('searches across projects: all terms, prefix, ranking, snippets, project filter', async () => {
    await put('alice', 'alice', 'Alpha/a.md', '# Alpha\nThe Dragon sleeps\nnothing here');
    await put('alice', 'alice', 'Alpha/dragon-notes.md', 'unrelated body');
    await put('alice', 'alice', 'Beta/b.md', 'dragon and treasure');
    await put('alice', 'alice', 'Beta/c.md', 'just treasure');

    const all = await q('alice', 'q=dragon');
    expect(all.body.hits[0].path).toBe('Alpha/dragon-notes.md'); // path match ranks first
    expect(paths(all)).toEqual(['Alpha/a.md', 'Alpha/dragon-notes.md', 'Beta/b.md']);
    expect(all.body.hits.find((h: any) => h.path === 'Alpha/a.md').snippets).toEqual([{ line: 2, text: 'The Dragon sleeps' }]);
    expect(all.body.truncated).toBe(false);
    expect(paths(await q('alice', 'q=dragon+treasure'))).toEqual(['Beta/b.md']);
    expect(paths(await q('alice', 'q=drag'))).toHaveLength(3);
    expect(paths(await q('alice', 'q=dragon&project=Alpha'))).toEqual(['Alpha/a.md', 'Alpha/dragon-notes.md']);
    expect((await q('alice', 'q=')).status).toBe(400);
    expect((await q('alice', 'q=x&project=..')).status).toBe(400);
    expect((await q('alice', 'q=%22%20OR%20tok:%22')).status).toBe(200); // FTS syntax in the query is just text
  });

  it('follows edits, deletes and moves without any hook', async () => {
    await put('alice', 'alice', 'A/a.md', 'dragon');
    await put('alice', 'alice', 'B/b.md', 'dragon');
    await put('alice', 'alice', 'B/c.md', 'treasure');
    expect(paths(await q('alice', 'q=dragon'))).toEqual(['A/a.md', 'B/b.md']);
    await api('alice', 'PUT', '/v1/file?path=B/c.md', { content: 'a dragon too', overwrite: true });
    await api('alice', 'DELETE', '/v1/file?path=B/b.md');
    await api('alice', 'POST', '/v1/files/move', { from: 'A/a.md', to: 'G/moved.md' });
    expect(paths(await q('alice', 'q=dragon'))).toEqual(['B/c.md', 'G/moved.md']);
  });

  it('indexes a large unindexed space progressively', async () => {
    for (let i = 0; i < 105; i++) bucket.objects.set(`alice/Big/n${i}.md`, { bytes: enc.encode('needle'), etag: `e${i}`, uploaded: new Date() });
    expect((await q('alice', 'q=needle&limit=100')).body).toMatchObject({ truncated: true, scanned: 100 });
    const second = await q('alice', 'q=needle&limit=100');
    expect(second.body).toMatchObject({ truncated: false, scanned: 105 });
    expect(second.body.hits).toHaveLength(100);
  });

  it('keeps personal and team spaces apart and applies team roles', async () => {
    const id = await newTeam('alice');
    await join(id, 'ed', 'editor');
    await join(id, 'vw', 'viewer');
    await put('alice', 'alice', 'Mine/p.md', 'secret dragon');
    await put('alice', `t:${id}`, 'Shared/t.md', 'team dragon');

    expect(paths(await q('alice', 'q=dragon'))).toEqual(['Mine/p.md']); // personal space only
    expect(paths(await q('alice', `q=dragon&owner=t:${id}`))).toEqual(['Shared/t.md']);
    for (const who of ['ed', 'vw']) expect(paths(await q(who, `q=dragon&owner=t:${id}`))).toEqual(['Shared/t.md']);
    expect(paths(await q('ed', 'q=dragon'))).toEqual([]); // not alice's personal notes
    expect((await q('bob', `q=dragon&owner=t:${id}`)).status).toBe(403); // outsider
    expect((await q('bob', 'q=dragon&owner=alice')).status).toBe(403);

    await api('alice', 'DELETE', `/v1/teams/${id}/members/vw`);
    expect((await q('vw', `q=dragon&owner=t:${id}`)).status).toBe(403); // removed members lose search at once
  });
});

describe('stars', () => {
  it('stars, lists, follows moves, and prunes deleted notes', async () => {
    for (const f of ['Alpha/a.md', 'Alpha/sub/b.md', 'Beta/c.md', 'Beta/d.md']) await put('alice', 'alice', f, 'x');
    expect((await star('alice', 'alice', 'Alpha/missing.md')).status).toBe(404);
    expect((await star('alice', 'alice', 'Alpha/index.md')).status).toBe(400);
    for (const f of ['Alpha/a.md', 'Alpha/sub/b.md', 'Beta/c.md', 'Beta/d.md']) expect((await star('alice', 'alice', f)).status).toBe(200);
    expect((await star('alice', 'alice', 'Alpha/a.md')).status).toBe(200); // idempotent
    expect(await stars('alice')).toEqual(['alice|Alpha/a.md', 'alice|Alpha/sub/b.md', 'alice|Beta/c.md', 'alice|Beta/d.md']);
    expect(await stars('bob')).toEqual([]);

    await api('alice', 'POST', '/v1/files/move', { from: 'Alpha/a.md', to: 'Alpha/renamed.md' });
    await api('alice', 'POST', '/v1/files/move', { from: 'Alpha/sub', to: 'Alpha/moved' });
    expect(await stars('alice')).toEqual(['alice|Alpha/moved/b.md', 'alice|Alpha/renamed.md', 'alice|Beta/c.md', 'alice|Beta/d.md']);

    await api('alice', 'DELETE', '/v1/file?path=Beta/c.md');
    await api('alice', 'DELETE', '/v1/folder?path=Beta');
    expect(await stars('alice')).toEqual(['alice|Alpha/moved/b.md', 'alice|Alpha/renamed.md']);
    bucket.objects.delete('alice/Alpha/renamed.md'); // gone by any other route (agent, project delete...)
    expect(await stars('alice')).toEqual(['alice|Alpha/moved/b.md']);

    const v1 = (await api('alice', 'GET', '/v1/version')).body.version;
    await star('alice', 'alice', 'Alpha/moved/b.md', 'DELETE');
    expect(await stars('alice')).toEqual([]);
    expect((await api('alice', 'GET', '/v1/version')).body.version).toBeGreaterThan(v1); // devices resync
  });

  it('stars whole projects: kind, validation, renames, pruning, team viewers', async () => {
    const id = await newTeam('alice');
    await join(id, 'vw', 'viewer');
    await put('alice', 'alice', 'Alpha/a.md', 'x');
    await put('alice', 'alice', 'Beta/b.md', 'x');
    await put('alice', `t:${id}`, 'Shared/t.md', 'x');

    expect((await star('alice', 'alice', 'Nope')).status).toBe(404);
    expect((await star('alice', 'alice', 'Alpha/sub')).status).toBe(400); // neither a note nor a project name
    expect((await star('alice', 'alice', '../x')).status).toBe(400);
    expect((await api('alice', 'PUT', '/v1/stars')).status).toBe(400);
    expect((await star('alice', 'alice', 'Alpha')).status).toBe(200);
    expect((await star('alice', 'alice', 'Alpha')).status).toBe(200); // idempotent
    expect((await star('alice', 'alice', 'Beta')).status).toBe(200);
    expect((await star('alice', 'alice', 'Beta/b.md')).status).toBe(200); // a project and its note are separate stars
    const list = (await api('alice', 'GET', '/v1/stars')).body.stars;
    expect(list.map((x: any) => `${x.path}:${x.kind}`).sort()).toEqual(['Alpha:project', 'Beta/b.md:note', 'Beta:project']);

    // Renaming a project (files API) moves its own star and its notes' stars.
    await api('alice', 'POST', '/v1/files/move', { from: 'Beta', to: 'Gamma' });
    expect(await stars('alice')).toEqual(['alice|Alpha', 'alice|Gamma', 'alice|Gamma/b.md']);
    // Moving it inside another project drops the project star (it is no longer a project).
    await api('alice', 'POST', '/v1/files/move', { from: 'Gamma', to: 'Alpha/gamma' });
    expect(await stars('alice')).toEqual(['alice|Alpha', 'alice|Alpha/gamma/b.md']);

    // Renaming through the MCP tool keeps the star too.
    const { token } = await newAgent('alice', '*', 'read_write');
    await tool(token, 'rename_project', { project: 'Alpha', newName: 'Omega' });
    expect(await stars('alice')).toEqual(['alice|Omega', 'alice|Omega/gamma/b.md']);

    // Deleting the project (any route) prunes its star.
    await api('alice', 'DELETE', '/v1/folder?path=Omega');
    expect(await stars('alice')).toEqual([]);

    // A viewer can star a team project; losing membership hides it.
    expect((await star('vw', `t:${id}`, 'Shared')).status).toBe(200);
    expect(await stars('vw')).toEqual([`t:${id}|Shared`]);
    expect((await star('bob', `t:${id}`, 'Shared')).status).toBe(403);
    await api('alice', 'DELETE', `/v1/teams/${id}/members/vw`);
    expect(await stars('vw')).toEqual([]);
  });

  it('lets a viewer star team notes without touching the team cursor, per user', async () => {
    const id = await newTeam('alice');
    await join(id, 'vw', 'viewer');
    await put('alice', `t:${id}`, 'Shared/t.md', 'x');
    await put('alice', 'alice', 'Mine/p.md', 'x');
    const teamBefore = (await api('alice', 'GET', `/v1/version?owner=t:${id}`)).body.version;

    expect((await star('vw', `t:${id}`, 'Shared/t.md')).status).toBe(200); // read access is enough
    expect((await star('bob', `t:${id}`, 'Shared/t.md')).status).toBe(403);
    expect((await star('vw', 'alice', 'Mine/p.md')).status).toBe(403);
    expect((await api('alice', 'GET', `/v1/version?owner=t:${id}`)).body.version).toBe(teamBefore);
    await star('alice', 'alice', 'Mine/p.md');
    expect(await stars('vw')).toEqual([`t:${id}|Shared/t.md`]);
    expect(await stars('alice')).toEqual(['alice|Mine/p.md']); // stars are not shared

    // A team move keeps everyone's stars; losing membership hides them.
    await api('alice', 'POST', `/v1/files/move?owner=t:${id}`, { from: 'Shared/t.md', to: 'Shared/u.md' });
    expect(await stars('vw')).toEqual([`t:${id}|Shared/u.md`]);
    await api('alice', 'DELETE', `/v1/teams/${id}/members/vw`);
    expect(await stars('vw')).toEqual([]);
  });

  it('is cleared with the account and the team', async () => {
    const id = await newTeam('alice');
    await put('alice', 'alice', 'Mine/p.md', 'dragon');
    await put('alice', `t:${id}`, 'Shared/t.md', 'dragon');
    await star('alice', 'alice', 'Mine/p.md');
    await star('alice', `t:${id}`, 'Shared/t.md');
    await q('alice', 'q=dragon');
    await q('alice', `q=dragon&owner=t:${id}`);
    const count = (sql: string) => (d1.raw.prepare(sql).get() as any).n as number;
    expect(count('SELECT COUNT(*) n FROM note_index')).toBe(2);

    await api('alice', 'DELETE', `/v1/file?owner=t:${id}&path=Shared/t.md`);
    expect((await api('alice', 'DELETE', `/v1/teams/${id}`)).status).toBe(200);
    expect(count(`SELECT COUNT(*) n FROM note_index WHERE owner = 't:${id}'`)).toBe(0);
    expect(count(`SELECT COUNT(*) n FROM starred WHERE owner = 't:${id}'`)).toBe(0);

    expect((await api('alice', 'DELETE', '/v1/account')).status).toBe(200);
    expect(count('SELECT COUNT(*) n FROM note_index')).toBe(0);
    expect(count('SELECT COUNT(*) n FROM starred')).toBe(0);
  });
});
