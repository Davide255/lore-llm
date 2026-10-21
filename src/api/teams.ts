import {
  INVITE_DAYS,
  MAX_PENDING_INVITES,
  MAX_TEAMS_PER_USER,
  addMember,
  closeInvite,
  countPendingInvites,
  countUserTeams,
  createInvite,
  createTeam,
  deleteTeam,
  findPendingInvite,
  findUserIdByEmail,
  getInvite,
  getMember,
  getTeam,
  getUserEmail,
  listInvitesForEmail,
  listMembers,
  listTeamInvites,
  listUserTeams,
  removeMember,
  renameTeam,
  setMemberRole,
  type TeamRole,
} from '../db/teams';
import { bumpVersion } from '../db/version';
import type { Env } from '../env';
import { canManage, canWrite, resolveAccess } from '../permissions/access';
import { teamOwner, userOwner } from '../storage/owner';
import { PathError, parseProject } from '../storage/paths';
import { Store } from '../storage/store';

/**
 * Teams, members and invitations, for the user's own clients (Cognito token).
 *
 *   GET    /v1/teams                              the caller's teams, with their role
 *   POST   /v1/teams                              {name}: the caller becomes its owner
 *   GET    /v1/teams/:id                          team + caller's role (members only)
 *   PATCH  /v1/teams/:id                          {name} (owner)
 *   DELETE /v1/teams/:id                          only when the team has no files left (owner)
 *   GET    /v1/teams/:id/members                  members with email and name
 *   PATCH  /v1/teams/:id/members/:userId          {role} (owner)
 *   DELETE /v1/teams/:id/members/:userId          remove a member (owner) or leave (yourself)
 *   GET    /v1/teams/:id/invites                  pending invitations (owner)
 *   POST   /v1/teams/:id/invites                  {email, role: editor|viewer} (owner)
 *   DELETE /v1/teams/:id/invites/:inviteId        revoke (owner)
 *   GET    /v1/invites                            pending invitations addressed to the caller's email
 *   POST   /v1/invites/:id/accept | /decline
 *   POST   /v1/projects/:name/move-to-team        {team_id}: moves a personal project into a team
 *
 * A team's files are reached with the file routes and `?owner=t:<teamId>`.
 * A team always keeps at least one owner. Outsiders get 404, never a hint that a team exists.
 */

const ROLES: TeamRole[] = ['owner', 'editor', 'viewer'];
const INVITE_ROLES: TeamRole[] = ['editor', 'viewer'];
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,63}$/;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const notFound = () => json({ error: 'Not found' }, 404);
const forbidden = () => json({ error: 'Forbidden' }, 403);

async function body(req: Request): Promise<Record<string, unknown>> {
  try {
    const b = await req.json();
    if (typeof b === 'object' && b !== null && !Array.isArray(b)) return b as Record<string, unknown>;
  } catch {
    /* fall through */
  }
  throw new PathError('Body must be a JSON object');
}

function teamName(v: unknown): string {
  if (typeof v !== 'string' || v.trim() === '' || v.trim().length > 64) throw new PathError('name must be 1-64 characters');
  return v.trim();
}

function roleOf(v: unknown, allowed: TeamRole[]): TeamRole {
  if (!allowed.includes(v as TeamRole)) throw new PathError(`role must be one of: ${allowed.join(', ')}`);
  return v as TeamRole;
}

function emailOf(v: unknown): string {
  const email = typeof v === 'string' ? v.trim().toLowerCase() : '';
  if (email.length > 254 || !EMAIL_RE.test(email)) throw new PathError('A valid email is required');
  return email;
}

/** Returns null when the route is not a teams route. */
export async function handleTeams(req: Request, env: Env, url: URL, userId: string): Promise<Response | null> {
  const path = url.pathname;
  const m = req.method;
  const db = env.DB;

  if (path === '/v1/teams') {
    if (m === 'GET') return json({ teams: await listUserTeams(db, userId) });
    if (m === 'POST') {
      const name = teamName((await body(req)).name);
      if ((await countUserTeams(db, userId)) >= MAX_TEAMS_PER_USER) return json({ error: `Team limit reached (${MAX_TEAMS_PER_USER})` }, 409);
      const team = await createTeam(db, crypto.randomUUID(), name, userId);
      return json({ team: { ...team, role: 'owner' } }, 201);
    }
    return null;
  }

  const sub = /^\/v1\/teams\/([A-Za-z0-9-]{1,64})(?:\/(members|invites)(?:\/([A-Za-z0-9-]{1,64}))?)?$/.exec(path);
  if (sub) return teamRoute(req, env, userId, sub[1]!, sub[2], sub[3]);

  if (path === '/v1/invites' && m === 'GET') {
    const email = await getUserEmail(db, userId);
    if (!email) return json({ invites: [] });
    const rows = await listInvitesForEmail(db, email);
    return json({
      invites: rows.map((r) => ({
        id: r.id,
        team_id: r.team_id,
        team_name: r.team_name,
        role: r.role,
        invited_by: { name: r.invited_by_name, email: r.invited_by_email },
        created_at: r.created_at,
        expires_at: r.expires_at,
      })),
    });
  }

  const answer = /^\/v1\/invites\/([A-Za-z0-9-]{1,64})\/(accept|decline)$/.exec(path);
  if (answer && m === 'POST') return answerInvite(env, userId, answer[1]!, answer[2] === 'accept');

  const move = /^\/v1\/projects\/([^/]+)\/move-to-team$/.exec(path);
  if (move && m === 'POST') return moveToTeam(req, env, userId, parseProject(decodeURIComponent(move[1]!)));

  return null;
}

async function teamRoute(
  req: Request,
  env: Env,
  userId: string,
  teamId: string,
  section: string | undefined,
  itemId: string | undefined,
): Promise<Response | null> {
  const db = env.DB;
  const m = req.method;
  const role = await resolveAccess(db, userId, teamOwner(teamId));
  if (role === 'none') return notFound();
  const manage = canManage(role);

  if (!section) {
    if (m === 'GET') {
      const team = await getTeam(db, teamId);
      return team ? json({ team: { ...team, role } }) : notFound();
    }
    if (!manage) return forbidden();
    if (m === 'PATCH') {
      await renameTeam(db, teamId, teamName((await body(req)).name));
      return json({ ok: true });
    }
    if (m === 'DELETE') {
      if ((await new Store(env.BUCKET).listAllFiles(teamOwner(teamId), { attachments: true })).length > 0) {
        return json({ error: 'The team still has files: move or delete them first' }, 409);
      }
      await deleteTeam(db, teamId);
      return json({ ok: true });
    }
    return null;
  }

  if (section === 'members') {
    if (!itemId && m === 'GET') return json({ members: await listMembers(db, teamId) });
    if (!itemId) return null;
    if (m === 'PATCH') {
      if (!manage) return forbidden();
      const next = roleOf((await body(req)).role, ROLES);
      if ((await getMember(db, teamId, itemId)) === null) return notFound();
      if (!(await setMemberRole(db, teamId, itemId, next))) return json({ error: 'A team needs at least one owner' }, 409);
      return json({ ok: true });
    }
    if (m === 'DELETE') {
      if (itemId !== userId && !manage) return forbidden();
      if ((await getMember(db, teamId, itemId)) === null) return notFound();
      if (!(await removeMember(db, teamId, itemId))) return json({ error: 'A team needs at least one owner: make someone else owner first' }, 409);
      return json({ ok: true });
    }
    return null;
  }

  // invites
  if (!manage) return forbidden();
  if (!itemId && m === 'GET') {
    return json({ invites: (await listTeamInvites(db, teamId)).map(({ team_id: _t, ...rest }) => rest) });
  }
  if (!itemId && m === 'POST') {
    const b = await body(req);
    const email = emailOf(b.email);
    const inviteRole = roleOf(b.role, INVITE_ROLES);
    const existingUser = await findUserIdByEmail(db, email);
    if (existingUser && (await getMember(db, teamId, existingUser)) !== null) return json({ error: 'Already a member of the team' }, 409);
    if (await findPendingInvite(db, teamId, email)) return json({ error: 'An invitation is already pending for this email' }, 409);
    if ((await countPendingInvites(db, teamId)) >= MAX_PENDING_INVITES) return json({ error: `Too many pending invitations (${MAX_PENDING_INVITES})` }, 429);
    const created = new Date();
    const invite = {
      id: crypto.randomUUID(),
      team_id: teamId,
      email,
      role: inviteRole,
      invited_by: userId,
      status: 'pending' as const,
      created_at: created.toISOString(),
      expires_at: new Date(created.getTime() + INVITE_DAYS * 86_400_000).toISOString(),
    };
    await createInvite(db, invite);
    const { team_id: _t, ...out } = invite;
    return json({ invite: out }, 201);
  }
  if (itemId && m === 'DELETE') {
    const invite = await getInvite(db, itemId);
    if (!invite || invite.team_id !== teamId) return notFound();
    return (await closeInvite(db, itemId, 'revoked')) ? json({ ok: true }) : notFound();
  }
  return null;
}

/** Only the person the invitation was sent to (matched on the verified email) can answer it. */
async function answerInvite(env: Env, userId: string, inviteId: string, accept: boolean): Promise<Response> {
  const db = env.DB;
  const invite = await getInvite(db, inviteId);
  const email = await getUserEmail(db, userId);
  // Same answer for "no such invite" and "not yours": invite ids must not be probeable.
  if (!invite || !email || invite.email !== email || invite.status !== 'pending' || invite.expires_at <= new Date().toISOString()) return notFound();

  if (!accept) return (await closeInvite(db, inviteId, 'declined')) ? json({ ok: true }) : notFound();

  if ((await countUserTeams(db, userId)) >= MAX_TEAMS_PER_USER) return json({ error: `Team limit reached (${MAX_TEAMS_PER_USER})` }, 409);
  if (!(await closeInvite(db, inviteId, 'accepted'))) return notFound(); // answered concurrently
  await addMember(db, invite.team_id, userId, invite.role);
  return json({ ok: true, team_id: invite.team_id, role: (await getMember(db, invite.team_id, userId)) ?? invite.role });
}

/** Personal project -> team. The caller must be able to write in the team. */
async function moveToTeam(req: Request, env: Env, userId: string, project: string): Promise<Response> {
  const b = await body(req);
  if (typeof b.team_id !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(b.team_id)) throw new PathError('team_id is required');
  const to = teamOwner(b.team_id);
  const role = await resolveAccess(env.DB, userId, to);
  if (role === 'none') return notFound();
  if (!canWrite(role)) return forbidden();

  const from = userOwner(userId);
  const moved = await new Store(env.BUCKET).transferProject(from, to, project);
  // The move already happened: a failed bump must not turn it into an error.
  for (const owner of [from, to]) await bumpVersion(env.DB, owner).catch((err) => console.error('version bump failed', String(err)));
  return json({ ok: true, moved });
}
