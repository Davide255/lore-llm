import { parseOwner, type Owner } from '../storage/owner';

/** What a person may do with an owner's files. `none` = no access at all. */
export type Role = 'none' | 'viewer' | 'editor' | 'owner';

const RANK: Record<Role, number> = { none: 0, viewer: 1, editor: 2, owner: 3 };

export function roleAtLeast(role: Role, min: Exclude<Role, 'none'>): boolean {
  return RANK[role] >= RANK[min];
}

export const canRead = (role: Role) => roleAtLeast(role, 'viewer');
export const canWrite = (role: Role) => roleAtLeast(role, 'editor');
export const canManage = (role: Role) => roleAtLeast(role, 'owner');

/** The more permissive of two roles. */
export function maxRole(a: Role, b: Role): Role {
  return RANK[a] >= RANK[b] ? a : b;
}

/** The less permissive of two roles (e.g. an agent capped by its user's role). */
export function minRole(a: Role, b: Role): Role {
  return RANK[a] <= RANK[b] ? a : b;
}

function asRole(value: unknown): Role {
  return value === 'owner' || value === 'editor' || value === 'viewer' ? value : 'none';
}

/**
 * The caller's role on an owner's files. A personal space belongs to its user and
 * nobody else; a team space follows team membership. (Per-item shares are added
 * with the sharing feature.)
 */
export async function resolveAccess(db: D1Database, userId: string, owner: Owner): Promise<Role> {
  const parsed = parseOwner(owner);
  if (parsed.kind === 'user') return parsed.id === userId ? 'owner' : 'none';
  const row = await db
    .prepare('SELECT role FROM team_members WHERE team_id = ? AND user_id = ?')
    .bind(parsed.id, userId)
    .first<{ role: string }>();
  return asRole(row?.role);
}
