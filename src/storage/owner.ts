/**
 * Who owns a set of files. A personal owner is the user's id (`sub`), so existing
 * R2 keys stay valid; a team owner is `t:<teamId>`. Cognito subs are UUIDs and
 * never start with `t:`, so the two namespaces cannot collide.
 */
export type Owner = string;

const TEAM_PREFIX = 't:';
const TEAM_ID_RE = /^[A-Za-z0-9-]{1,64}$/;

export function userOwner(userId: string): Owner {
  return userId;
}

export function teamOwner(teamId: string): Owner {
  if (!TEAM_ID_RE.test(teamId)) throw new Error('Invalid team id');
  return `${TEAM_PREFIX}${teamId}`;
}

export type ParsedOwner = { kind: 'user'; id: string } | { kind: 'team'; id: string };

export function parseOwner(owner: Owner): ParsedOwner {
  if (owner.startsWith(TEAM_PREFIX)) {
    const id = owner.slice(TEAM_PREFIX.length);
    if (!TEAM_ID_RE.test(id)) throw new Error('Invalid team owner');
    return { kind: 'team', id };
  }
  return { kind: 'user', id: owner };
}
