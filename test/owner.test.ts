import { describe, expect, it } from 'vitest';
import { objectKey } from '../src/storage/paths';
import { parseOwner, teamOwner, userOwner } from '../src/storage/owner';

describe('owner', () => {
  it('keeps the personal prefix equal to the user id (existing keys stay valid)', () => {
    expect(userOwner('3f2a-uuid')).toBe('3f2a-uuid');
    expect(objectKey(userOwner('u1'), 'P/a.md')).toBe('u1/P/a.md');
  });

  it('prefixes team owners so they cannot collide with user ids', () => {
    expect(teamOwner('team-1')).toBe('t:team-1');
    expect(objectKey(teamOwner('team-1'), 'P/a.md')).toBe('t:team-1/P/a.md');
    expect(parseOwner('t:team-1')).toEqual({ kind: 'team', id: 'team-1' });
    expect(parseOwner('0b9c4f1e-7a52-4d0e-9c1a-1f3b8d2e6a40')).toEqual({ kind: 'user', id: '0b9c4f1e-7a52-4d0e-9c1a-1f3b8d2e6a40' });
  });

  it('rejects malformed team ids', () => {
    expect(() => teamOwner('a/b')).toThrow();
    expect(() => teamOwner('')).toThrow();
    expect(() => parseOwner('t:../x')).toThrow();
  });
});
