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

describe('teams', () => {
  it('creates a team owned by the caller and lists only the caller\'s teams', async () => {
    const id = await newTeam('alice', '  Core  ');
    expect((await api('alice', 'GET', '/v1/teams')).body.teams).toMatchObject([{ id, name: 'Core', role: 'owner' }]);
    expect((await api('bob', 'GET', '/v1/teams')).body.teams).toEqual([]);
    expect((await api('alice', 'POST', '/v1/teams', { name: '' })).status).toBe(400);
  });

  it('hides teams from outsiders (404) and lets owners rename', async () => {
    const id = await newTeam();
    expect((await api('bob', 'GET', `/v1/teams/${id}`)).status).toBe(404);
    expect((await api('bob', 'PATCH', `/v1/teams/${id}`, { name: 'x' })).status).toBe(404);
    expect((await api('alice', 'PATCH', `/v1/teams/${id}`, { name: 'Renamed' })).status).toBe(200);
    expect((await api('alice', 'GET', `/v1/teams/${id}`)).body.team).toMatchObject({ name: 'Renamed', role: 'owner' });
  });

  it('refuses to delete a team that still has files, and deletes an empty one', async () => {
    const id = await newTeam();
    await put('alice', `t:${id}`, 'Proj/a.md', 'x');
    expect((await api('alice', 'DELETE', `/v1/teams/${id}`)).status).toBe(409);
    await api('alice', 'DELETE', `/v1/file?owner=t:${id}&path=Proj/a.md`);
    expect((await api('alice', 'DELETE', `/v1/teams/${id}`)).status).toBe(200);
    expect((await api('alice', 'GET', '/v1/teams')).body.teams).toEqual([]);
  });

  it('only owners can rename or delete', async () => {
    const id = await newTeam();
    await join(id, 'ed', 'editor');
    expect((await api('ed', 'PATCH', `/v1/teams/${id}`, { name: 'x' })).status).toBe(403);
    expect((await api('ed', 'DELETE', `/v1/teams/${id}`)).status).toBe(403);
  });
});

describe('members', () => {
  it('lists members with profile, changes roles and removes people', async () => {
    const id = await newTeam();
    await join(id, 'ed', 'editor');
    await join(id, 'vi', 'viewer');
    const list = (await api('vi', 'GET', `/v1/teams/${id}/members`)).body.members;
    expect(list.map((x: any) => [x.user_id, x.role, x.email])).toEqual([
      ['alice', 'owner', 'alice@example.com'],
      ['ed', 'editor', 'ed@example.com'],
      ['vi', 'viewer', 'vi@example.com'],
    ]);
    expect((await api('alice', 'PATCH', `/v1/teams/${id}/members/vi`, { role: 'editor' })).status).toBe(200);
    expect((await api('alice', 'PATCH', `/v1/teams/${id}/members/vi`, { role: 'god' })).status).toBe(400);
    expect((await api('alice', 'PATCH', `/v1/teams/${id}/members/nobody`, { role: 'viewer' })).status).toBe(404);
    expect((await api('ed', 'PATCH', `/v1/teams/${id}/members/vi`, { role: 'viewer' })).status).toBe(403);
    expect((await api('alice', 'DELETE', `/v1/teams/${id}/members/vi`)).status).toBe(200);
    expect((await api('vi', 'GET', `/v1/teams/${id}`)).status).toBe(404);
  });

  it('lets members leave but never removes the last owner', async () => {
    const id = await newTeam();
    await join(id, 'ed', 'editor');
    expect((await api('ed', 'DELETE', `/v1/teams/${id}/members/alice`)).status).toBe(403); // not an owner
    expect((await api('alice', 'DELETE', `/v1/teams/${id}/members/alice`)).status).toBe(409); // last owner
    expect((await api('alice', 'PATCH', `/v1/teams/${id}/members/alice`, { role: 'editor' })).status).toBe(409);
    expect((await api('ed', 'DELETE', `/v1/teams/${id}/members/ed`)).status).toBe(200); // leaves

    await join(id, 'bo', 'editor');
    await api('alice', 'PATCH', `/v1/teams/${id}/members/bo`, { role: 'owner' });
    expect((await api('alice', 'DELETE', `/v1/teams/${id}/members/alice`)).status).toBe(200); // another owner exists
    expect((await api('bo', 'GET', `/v1/teams/${id}`)).body.team.role).toBe('owner');
  });
});

describe('invites', () => {
  it('runs the full lifecycle: invite, list, accept', async () => {
    const id = await newTeam();
    await api('bob', 'GET', '/v1/teams'); // bob's profile is recorded
    const inv = await api('alice', 'POST', `/v1/teams/${id}/invites`, { email: ' Bob@Example.com ', role: 'viewer' });
    expect(inv.status).toBe(201);
    expect(inv.body.invite).toMatchObject({ email: 'bob@example.com', role: 'viewer', status: 'pending' });
    expect((await api('alice', 'GET', `/v1/teams/${id}/invites`)).body.invites).toHaveLength(1);

    const mine = (await api('bob', 'GET', '/v1/invites')).body.invites;
    expect(mine).toMatchObject([{ id: inv.body.invite.id, team_name: 'Core', role: 'viewer', invited_by: { name: 'ALICE' } }]);
    expect((await api('carol', 'GET', '/v1/invites')).body.invites).toEqual([]);

    const ok = await api('bob', 'POST', `/v1/invites/${inv.body.invite.id}/accept`);
    expect(ok.body).toMatchObject({ ok: true, team_id: id, role: 'viewer' });
    expect((await api('bob', 'GET', '/v1/invites')).body.invites).toEqual([]);
    expect((await api('bob', 'GET', '/v1/teams')).body.teams).toMatchObject([{ id, role: 'viewer' }]);
    expect((await api('bob', 'POST', `/v1/invites/${inv.body.invite.id}/accept`)).status).toBe(404); // already used
  });

  it('only the invited email can answer, and nobody can probe invite ids', async () => {
    const id = await newTeam();
    const inv = (await api('alice', 'POST', `/v1/teams/${id}/invites`, { email: 'bob@example.com', role: 'editor' })).body.invite;
    expect((await api('carol', 'POST', `/v1/invites/${inv.id}/accept`)).status).toBe(404);
    expect((await api('carol', 'POST', `/v1/invites/${inv.id}/decline`)).status).toBe(404);
    expect((await api('carol', 'GET', '/v1/teams')).body.teams).toEqual([]);
  });

  it('declines, revokes and expires', async () => {
    const id = await newTeam();
    const mk = async (email: string) => (await api('alice', 'POST', `/v1/teams/${id}/invites`, { email, role: 'viewer' })).body.invite.id as string;

    const a = await mk('bob@example.com');
    await api('bob', 'GET', '/v1/teams');
    expect((await api('bob', 'POST', `/v1/invites/${a}/decline`)).status).toBe(200);
    expect((await api('bob', 'POST', `/v1/invites/${a}/accept`)).status).toBe(404);

    const b = await mk('bob@example.com'); // a declined invite no longer blocks a new one
    expect((await api('bob', 'GET', '/v1/teams')).body.teams).toEqual([]);
    expect((await api('alice', 'DELETE', `/v1/teams/${id}/invites/${b}`)).status).toBe(200);
    expect((await api('bob', 'POST', `/v1/invites/${b}/accept`)).status).toBe(404);

    const c = await mk('bob@example.com');
    d1.raw.exec(`UPDATE invites SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = '${c}'`);
    expect((await api('bob', 'GET', '/v1/invites')).body.invites).toEqual([]);
    expect((await api('bob', 'POST', `/v1/invites/${c}/accept`)).status).toBe(404);
  });

  it('validates input and prevents duplicates', async () => {
    const id = await newTeam();
    const post = (b: unknown) => api('alice', 'POST', `/v1/teams/${id}/invites`, b);
    expect((await post({ email: 'not-an-email', role: 'viewer' })).status).toBe(400);
    expect((await post({ email: 'bob@example.com', role: 'owner' })).status).toBe(400);
    expect((await post({ email: 'bob@example.com', role: 'viewer' })).status).toBe(201);
    expect((await post({ email: 'BOB@example.com', role: 'editor' })).status).toBe(409); // already pending
    await join(id, 'ed', 'editor');
    expect((await post({ email: 'ed@example.com', role: 'viewer' })).status).toBe(409); // already a member
  });

  it('is manageable by owners only and capped per team', async () => {
    const id = await newTeam();
    await join(id, 'ed', 'editor');
    expect((await api('ed', 'POST', `/v1/teams/${id}/invites`, { email: 'x@example.com', role: 'viewer' })).status).toBe(403);
    expect((await api('ed', 'GET', `/v1/teams/${id}/invites`)).status).toBe(403);
    expect((await api('bob', 'GET', `/v1/teams/${id}/invites`)).status).toBe(404);
    for (let i = 0; i < 50; i++) {
      d1.raw.exec(
        `INSERT INTO invites (id, team_id, email, role, invited_by, status, created_at, expires_at) VALUES ('i${i}', '${id}', 'p${i}@example.com', 'viewer', 'alice', 'pending', 'x', '2999-01-01T00:00:00.000Z')`,
      );
    }
    expect((await api('alice', 'POST', `/v1/teams/${id}/invites`, { email: 'late@example.com', role: 'viewer' })).status).toBe(429);
  });
});

describe('team files', () => {
  it('applies roles: editors write, viewers read, outsiders are refused', async () => {
    const id = await newTeam();
    const owner = `t:${id}`;
    await join(id, 'ed', 'editor');
    await join(id, 'vi', 'viewer');

    expect((await put('ed', owner, 'Proj/a.md', '# A')).status).toBe(201);
    expect(bucket.objects.has(`${owner}/Proj/a.md`)).toBe(true);
    expect(bucket.objects.has(`${owner}/Proj/index.md`)).toBe(true);
    expect((await api('vi', 'GET', `/v1/file?owner=${owner}&path=Proj/a.md`)).body.content).toBe('# A');
    expect((await api('vi', 'GET', `/v1/files?owner=${owner}`)).body.files.map((f: any) => f.path)).toEqual(['Proj/a.md', 'Proj/index.md']);

    expect((await put('vi', owner, 'Proj/b.md', 'x')).status).toBe(403);
    expect((await api('vi', 'DELETE', `/v1/file?owner=${owner}&path=Proj/a.md`)).status).toBe(403);
    expect((await api('vi', 'POST', '/v1/files/move?owner=' + owner, { from: 'Proj/a.md', to: 'Proj/z.md' })).status).toBe(403);
    expect((await api('vi', 'DELETE', `/v1/folder?owner=${owner}&path=Proj`)).status).toBe(403);

    for (const who of ['bob']) {
      expect((await api(who, 'GET', `/v1/file?owner=${owner}&path=Proj/a.md`)).status).toBe(403);
      expect((await api(who, 'GET', `/v1/files?owner=${owner}`)).status).toBe(403);
      expect((await put(who, owner, 'Proj/b.md', 'x')).status).toBe(403);
    }
    expect((await api('ed', 'DELETE', `/v1/file?owner=${owner}&path=Proj/a.md`)).status).toBe(200);
  });

  it('keeps personal and team spaces apart and rejects foreign or malformed owners', async () => {
    const id = await newTeam();
    await put('alice', `t:${id}`, 'Proj/a.md', 'team');
    await put('alice', 'alice', 'Proj/a.md', 'mine');
    expect((await api('alice', 'GET', '/v1/file?path=Proj/a.md')).body.content).toBe('mine');
    expect((await api('alice', 'GET', `/v1/file?owner=t:${id}&path=Proj/a.md`)).body.content).toBe('team');
    expect((await api('alice', 'GET', '/v1/files')).body.files.map((f: any) => f.path)).toEqual(['Proj/a.md', 'Proj/index.md']);

    expect((await api('alice', 'GET', '/v1/files?owner=bob')).status).toBe(403); // another user's space
    expect((await api('alice', 'GET', '/v1/files?owner=t:../x')).status).toBe(400);
    expect((await api('alice', 'GET', '/v1/files?owner=t:nope')).status).toBe(403); // unknown team
    expect((await api('alice', 'GET', '/v1/files?owner=')).status).toBe(403);
  });

  it('detects concurrent team edits with etags', async () => {
    const id = await newTeam();
    const owner = `t:${id}`;
    await join(id, 'ed', 'editor');
    const created = (await put('alice', owner, 'Proj/a.md', 'v1')).body.file;
    const edit = (who: string, content: string, if_match: string) =>
      api(who, 'PUT', `/v1/file?owner=${owner}&path=Proj/a.md`, { content, overwrite: true, if_match });
    expect((await edit('ed', 'ed was here', created.etag)).status).toBe(200);
    expect((await edit('alice', 'alice too', created.etag)).status).toBe(409);
  });

  it('removed members lose access immediately', async () => {
    const id = await newTeam();
    await join(id, 'ed', 'editor');
    await put('ed', `t:${id}`, 'Proj/a.md', 'x');
    await api('alice', 'DELETE', `/v1/teams/${id}/members/ed`);
    expect((await api('ed', 'GET', `/v1/file?owner=t:${id}&path=Proj/a.md`)).status).toBe(403);
  });
});

describe('versions', () => {
  it('bumps the team cursor, not the personal one, and reports every scope', async () => {
    const id = await newTeam();
    const owner = `t:${id}`;
    await join(id, 'vi', 'viewer');
    expect((await api('vi', 'GET', '/v1/version')).body).toMatchObject({ version: 0, scopes: { [owner]: { version: 0 } } });

    await put('alice', owner, 'Proj/a.md', 'x');
    await put('alice', owner, 'Proj/b.md', 'x');
    const seen = (await api('vi', 'GET', '/v1/version')).body;
    expect(seen.version).toBe(0);
    expect(seen.scopes[owner].version).toBe(2);
    expect((await api('vi', 'GET', `/v1/version?owner=${owner}`)).body).toMatchObject({ version: 2 });
    expect((await api('vi', 'GET', `/v1/version?owner=${owner}`)).body.scopes).toBeUndefined();

    await put('vi', 'vi', 'Mine/a.md', 'x');
    expect((await api('vi', 'GET', '/v1/version')).body).toMatchObject({ version: 1, scopes: { [owner]: { version: 2 } } });
    expect((await api('bob', 'GET', `/v1/version?owner=${owner}`)).status).toBe(403);
    expect((await api('bob', 'GET', '/v1/version')).body.scopes).toEqual({});
  });
});

describe('move to team', () => {
  it('moves a personal project into a team and rebuilds both indexes', async () => {
    const id = await newTeam();
    await put('alice', 'alice', 'Plans/a.md', 'a');
    await put('alice', 'alice', 'Plans/sub/b.md', 'b');
    const res = await api('alice', 'POST', '/v1/projects/Plans/move-to-team', { team_id: id });
    expect(res).toMatchObject({ status: 200, body: { ok: true, moved: 2 } });

    expect([...bucket.objects.keys()].filter((k) => k.startsWith('alice/'))).toEqual([]);
    expect([...bucket.objects.keys()].sort()).toEqual([`t:${id}/Plans/a.md`, `t:${id}/Plans/index.md`, `t:${id}/Plans/sub/b.md`]);
    expect((await api('alice', 'GET', '/v1/version')).body).toMatchObject({ version: 3, scopes: { [`t:${id}`]: { version: 1 } } });
  });

  it('needs write access in the team and an existing, non-clashing project', async () => {
    const id = await newTeam();
    await join(id, 'vi', 'viewer');
    await join(id, 'ed', 'editor');
    await put('vi', 'vi', 'Plans/a.md', 'a');
    await put('ed', 'ed', 'Plans/a.md', 'a');
    expect((await api('vi', 'POST', '/v1/projects/Plans/move-to-team', { team_id: id })).status).toBe(403);
    expect((await api('bob', 'POST', '/v1/projects/Plans/move-to-team', { team_id: id })).status).toBe(404);
    expect((await api('ed', 'POST', '/v1/projects/Missing/move-to-team', { team_id: id })).status).toBe(400);
    expect((await api('ed', 'POST', '/v1/projects/Plans/move-to-team', { team_id: id })).status).toBe(200);
    await put('ed', 'ed', 'Plans/c.md', 'c');
    expect((await api('ed', 'POST', '/v1/projects/Plans/move-to-team', { team_id: id })).status).toBe(400); // already there
    expect(bucket.objects.has('ed/Plans/c.md')).toBe(true); // nothing was lost
    expect((await api('ed', 'POST', '/v1/projects/Plans/move-to-team', {})).status).toBe(400);
  });
});

describe('lazy loading endpoints', () => {
  it('lists projects with counts and the checklist version, without reading any file', async () => {
    await put('alice', 'alice', 'Alpha/a.md', 'a');
    await put('alice', 'alice', 'Alpha/sub/b.md', 'bb');
    const checklist = (await put('alice', 'alice', 'Alpha/checklist.md', '- [ ] x')).body.file;
    await put('alice', 'alice', 'Beta/x.md', 'x');
    await api('alice', 'PUT', '/v1/blob?path=Alpha/pic.png', undefined); // attachments are not counted

    const { status, body } = await api('alice', 'GET', '/v1/projects');
    expect(status).toBe(200);
    expect(body.projects.map((p: any) => [p.name, p.file_count])).toEqual([['Alpha', 3], ['Beta', 1]]);
    expect(body.projects[0]).toMatchObject({
      checklist: { path: 'Alpha/checklist.md', etag: checklist.etag, size: 7 },
      updated_at: '2026-01-02T00:00:00.000Z',
    });
    expect(body.projects[1].checklist).toBeNull();
    // size covers every note, index included
    const total = [...bucket.objects.entries()].filter(([k]) => k.startsWith('alice/Alpha/') && k.endsWith('.md')).reduce((n, [, o]) => n + o.bytes.length, 0);
    expect(body.projects[0].size).toBe(total);
  });

  it('is scoped to the owner: other users, teams and roles', async () => {
    const id = await newTeam();
    await join(id, 'vi', 'viewer');
    await put('alice', `t:${id}`, 'Shared/a.md', 'a');
    await put('alice', 'alice', 'Mine/a.md', 'a');
    expect((await api('alice', 'GET', '/v1/projects')).body.projects.map((p: any) => p.name)).toEqual(['Mine']);
    expect((await api('vi', 'GET', `/v1/projects?owner=t:${id}`)).body.projects.map((p: any) => p.name)).toEqual(['Shared']);
    expect((await api('bob', 'GET', '/v1/projects')).body.projects).toEqual([]);
    expect((await api('bob', 'GET', `/v1/projects?owner=t:${id}`)).status).toBe(403);
  });

  it('lists the files of a single project', async () => {
    await put('alice', 'alice', 'Alpha/a.md', 'a');
    await put('alice', 'alice', 'Alpha/sub/b.md', 'b');
    await put('alice', 'alice', 'Alphabet/c.md', 'c');
    await put('alice', 'alice', 'Beta/x.md', 'x');
    const paths = async (q: string) => (await api('alice', 'GET', `/v1/files?${q}`)).body.files.map((f: any) => f.path);
    expect(await paths('project=Alpha')).toEqual(['Alpha/a.md', 'Alpha/index.md', 'Alpha/sub/b.md']); // not Alphabet
    expect(await paths('project=Missing')).toEqual([]);
    expect(await paths('')).toHaveLength(7); // 3 + 2 + 2, indexes included
    expect((await api('alice', 'GET', '/v1/files?project=..%2Fx')).status).toBe(400);
  });
});
