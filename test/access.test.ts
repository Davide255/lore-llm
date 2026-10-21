import { beforeEach, describe, expect, it } from 'vitest';
import { canManage, canRead, canWrite, maxRole, minRole, resolveAccess, roleAtLeast } from '../src/permissions/access';
import { teamOwner, userOwner } from '../src/storage/owner';
import { upsertUser } from '../src/db/users';
import { makeFakeD1 } from './fakes';

let db: ReturnType<typeof makeFakeD1>;
const D = () => db as unknown as D1Database;

beforeEach(() => {
  db = makeFakeD1();
  db.raw.exec(`
    INSERT INTO teams (id, name, created_by, created_at) VALUES ('t1', 'Core', 'alice', 'x'), ('t2', 'Other', 'bob', 'x');
    INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES
      ('t1', 'alice', 'owner', 'x'), ('t1', 'ed', 'editor', 'x'), ('t1', 'vi', 'viewer', 'x'), ('t2', 'bob', 'owner', 'x');
  `);
});

describe('role helpers', () => {
  it('orders roles and exposes the capability checks', () => {
    expect(roleAtLeast('editor', 'viewer')).toBe(true);
    expect(roleAtLeast('viewer', 'editor')).toBe(false);
    expect([canRead('none'), canRead('viewer')]).toEqual([false, true]);
    expect([canWrite('viewer'), canWrite('editor')]).toEqual([false, true]);
    expect([canManage('editor'), canManage('owner')]).toEqual([false, true]);
    expect(maxRole('viewer', 'editor')).toBe('editor');
    expect(minRole('owner', 'viewer')).toBe('viewer');
  });
});

describe('resolveAccess', () => {
  it('gives users everything in their own space and nothing in another user\'s', async () => {
    expect(await resolveAccess(D(), 'alice', userOwner('alice'))).toBe('owner');
    expect(await resolveAccess(D(), 'alice', userOwner('bob'))).toBe('none');
  });

  it('follows team membership', async () => {
    const t1 = teamOwner('t1');
    expect(await resolveAccess(D(), 'alice', t1)).toBe('owner');
    expect(await resolveAccess(D(), 'ed', t1)).toBe('editor');
    expect(await resolveAccess(D(), 'vi', t1)).toBe('viewer');
  });

  it('isolates teams from each other and from outsiders', async () => {
    expect(await resolveAccess(D(), 'bob', teamOwner('t1'))).toBe('none');
    expect(await resolveAccess(D(), 'alice', teamOwner('t2'))).toBe('none');
    expect(await resolveAccess(D(), 'nobody', teamOwner('t1'))).toBe('none');
  });

  it('loses access when removed from the team', async () => {
    db.raw.exec("DELETE FROM team_members WHERE team_id = 't1' AND user_id = 'ed'");
    expect(await resolveAccess(D(), 'ed', teamOwner('t1'))).toBe('none');
  });
});

describe('user directory', () => {
  const row = (id: string) => db.raw.prepare('SELECT * FROM users WHERE id = ?').get(id) as any;

  it('stores a normalised email and name', async () => {
    await upsertUser(D(), { userId: 'u1', email: ' Ann@Example.COM ', name: 'Ann' });
    expect(row('u1')).toMatchObject({ email: 'ann@example.com', name: 'Ann' });
  });

  it('never blanks the profile when an access token has no email or name', async () => {
    await upsertUser(D(), { userId: 'u1', email: 'ann@example.com', name: 'Ann' });
    await upsertUser(D(), { userId: 'u1' });
    expect(row('u1')).toMatchObject({ email: 'ann@example.com', name: 'Ann' });
  });

  it('updates a changed email', async () => {
    await upsertUser(D(), { userId: 'u1', email: 'old@example.com' });
    await upsertUser(D(), { userId: 'u1', email: 'new@example.com' });
    expect(row('u1').email).toBe('new@example.com');
  });

  it('skips the write when nothing changed and the row is fresh', async () => {
    await upsertUser(D(), { userId: 'u1', email: 'ann@example.com' });
    db.raw.exec("UPDATE users SET updated_at = '2999-01-01T00:00:00.000Z' WHERE id = 'u1'");
    await upsertUser(D(), { userId: 'u1', email: 'ann@example.com' });
    expect(row('u1').updated_at).toBe('2999-01-01T00:00:00.000Z');
  });
});
