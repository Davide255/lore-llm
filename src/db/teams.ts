export type TeamRole = 'owner' | 'editor' | 'viewer';
export type InviteStatus = 'pending' | 'accepted' | 'declined' | 'revoked';

export const MAX_TEAMS_PER_USER = 20;
export const MAX_PENDING_INVITES = 50;
export const INVITE_DAYS = 14;

export interface TeamRow {
  id: string;
  name: string;
  created_by: string;
  created_at: string;
}

export interface MemberRow {
  user_id: string;
  role: TeamRole;
  joined_at: string;
  email: string | null;
  name: string | null;
}

export interface InviteRow {
  id: string;
  team_id: string;
  email: string;
  role: TeamRole;
  invited_by: string;
  status: InviteStatus;
  created_at: string;
  expires_at: string;
}

const changed = (res: { meta: { changes?: number } }) => (res.meta.changes ?? 0) > 0;
const now = () => new Date().toISOString();

/** The caller becomes the team's first owner. */
export async function createTeam(db: D1Database, id: string, name: string, userId: string): Promise<TeamRow> {
  const row: TeamRow = { id, name, created_by: userId, created_at: now() };
  await db.prepare('INSERT INTO teams (id, name, created_by, created_at) VALUES (?, ?, ?, ?)').bind(row.id, row.name, row.created_by, row.created_at).run();
  try {
    await addMember(db, id, userId, 'owner');
  } catch (err) {
    await db.prepare('DELETE FROM teams WHERE id = ?').bind(id).run();
    throw err;
  }
  return row;
}

export async function listUserTeams(db: D1Database, userId: string): Promise<Array<TeamRow & { role: TeamRole }>> {
  const res = await db
    .prepare(
      'SELECT t.id, t.name, t.created_by, t.created_at, m.role FROM team_members m JOIN teams t ON t.id = m.team_id ' +
        'WHERE m.user_id = ? ORDER BY t.name COLLATE NOCASE, t.id',
    )
    .bind(userId)
    .all<TeamRow & { role: TeamRole }>();
  return res.results;
}

export async function getTeam(db: D1Database, teamId: string): Promise<TeamRow | null> {
  return db.prepare('SELECT * FROM teams WHERE id = ?').bind(teamId).first<TeamRow>();
}

export async function renameTeam(db: D1Database, teamId: string, name: string): Promise<boolean> {
  return changed(await db.prepare('UPDATE teams SET name = ? WHERE id = ?').bind(name, teamId).run());
}

/** Members, invites and the change cursor go with the team. The caller makes sure no files are left. */
export async function deleteTeam(db: D1Database, teamId: string): Promise<boolean> {
  await db.prepare('DELETE FROM team_members WHERE team_id = ?').bind(teamId).run();
  await db.prepare('DELETE FROM invites WHERE team_id = ?').bind(teamId).run();
  await db.prepare('DELETE FROM space_versions WHERE user_id = ?').bind(`t:${teamId}`).run();
  return changed(await db.prepare('DELETE FROM teams WHERE id = ?').bind(teamId).run());
}

export async function listMembers(db: D1Database, teamId: string): Promise<MemberRow[]> {
  const res = await db
    .prepare(
      'SELECT m.user_id, m.role, m.joined_at, u.email, u.name FROM team_members m LEFT JOIN users u ON u.id = m.user_id ' +
        "WHERE m.team_id = ? ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'editor' THEN 1 ELSE 2 END, m.joined_at, m.user_id",
    )
    .bind(teamId)
    .all<MemberRow>();
  return res.results;
}

export async function getMember(db: D1Database, teamId: string, userId: string): Promise<TeamRole | null> {
  const row = await db.prepare('SELECT role FROM team_members WHERE team_id = ? AND user_id = ?').bind(teamId, userId).first<{ role: TeamRole }>();
  return row?.role ?? null;
}

export async function countUserTeams(db: D1Database, userId: string): Promise<number> {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM team_members WHERE user_id = ?').bind(userId).first<{ n: number }>();
  return row?.n ?? 0;
}

/** Keeps the existing role when the person is already a member. Returns whether a row was added. */
export async function addMember(db: D1Database, teamId: string, userId: string, role: TeamRole): Promise<boolean> {
  return changed(
    await db
      .prepare('INSERT OR IGNORE INTO team_members (team_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)')
      .bind(teamId, userId, role, now())
      .run(),
  );
}

// A team always keeps at least one owner: the guard lives in the statement so two
// concurrent requests cannot both remove the last two owners.
const NOT_LAST_OWNER = "(SELECT COUNT(*) FROM team_members WHERE team_id = ? AND role = 'owner') > 1";

/** False when the member does not exist or is the team's last owner being demoted. */
export async function setMemberRole(db: D1Database, teamId: string, userId: string, role: TeamRole): Promise<boolean> {
  return changed(
    await db
      .prepare(`UPDATE team_members SET role = ? WHERE team_id = ? AND user_id = ? AND (? = 'owner' OR role != 'owner' OR ${NOT_LAST_OWNER})`)
      .bind(role, teamId, userId, role, teamId)
      .run(),
  );
}

/** False when the member does not exist or is the team's last owner. */
export async function removeMember(db: D1Database, teamId: string, userId: string): Promise<boolean> {
  return changed(
    await db
      .prepare(`DELETE FROM team_members WHERE team_id = ? AND user_id = ? AND (role != 'owner' OR ${NOT_LAST_OWNER})`)
      .bind(teamId, userId, teamId)
      .run(),
  );
}

export async function createInvite(db: D1Database, row: InviteRow): Promise<void> {
  await db
    .prepare('INSERT INTO invites (id, team_id, email, role, invited_by, status, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(row.id, row.team_id, row.email, row.role, row.invited_by, row.status, row.created_at, row.expires_at)
    .run();
}

export async function getInvite(db: D1Database, id: string): Promise<InviteRow | null> {
  return db.prepare('SELECT * FROM invites WHERE id = ? AND team_id IS NOT NULL AND path IS NULL').bind(id).first<InviteRow>();
}

export async function findPendingInvite(db: D1Database, teamId: string, email: string): Promise<InviteRow | null> {
  return db
    .prepare("SELECT * FROM invites WHERE team_id = ? AND email = ? AND status = 'pending' AND path IS NULL AND expires_at > ?")
    .bind(teamId, email, now())
    .first<InviteRow>();
}

export async function countPendingInvites(db: D1Database, teamId: string): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM invites WHERE team_id = ? AND status = 'pending' AND path IS NULL AND expires_at > ?")
    .bind(teamId, now())
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function listTeamInvites(db: D1Database, teamId: string): Promise<InviteRow[]> {
  const res = await db
    .prepare("SELECT * FROM invites WHERE team_id = ? AND status = 'pending' AND path IS NULL AND expires_at > ? ORDER BY created_at DESC")
    .bind(teamId, now())
    .all<InviteRow>();
  return res.results;
}

export interface MyInviteRow extends InviteRow {
  team_name: string;
  invited_by_name: string | null;
  invited_by_email: string | null;
}

export async function listInvitesForEmail(db: D1Database, email: string): Promise<MyInviteRow[]> {
  const res = await db
    .prepare(
      'SELECT i.*, t.name AS team_name, u.name AS invited_by_name, u.email AS invited_by_email FROM invites i ' +
        'JOIN teams t ON t.id = i.team_id LEFT JOIN users u ON u.id = i.invited_by ' +
        "WHERE i.email = ? AND i.status = 'pending' AND i.path IS NULL AND i.expires_at > ? ORDER BY i.created_at DESC",
    )
    .bind(email, now())
    .all<MyInviteRow>();
  return res.results;
}

/** Moves a pending invite to a final status. False when it was no longer pending (e.g. a concurrent accept). */
export async function closeInvite(db: D1Database, id: string, status: Exclude<InviteStatus, 'pending'>): Promise<boolean> {
  return changed(await db.prepare("UPDATE invites SET status = ? WHERE id = ? AND status = 'pending'").bind(status, id).run());
}

export async function findUserIdByEmail(db: D1Database, email: string): Promise<string | null> {
  const row = await db.prepare('SELECT id FROM users WHERE email = ?').bind(email).first<{ id: string }>();
  return row?.id ?? null;
}

export async function getUserEmail(db: D1Database, userId: string): Promise<string | null> {
  const row = await db.prepare('SELECT email FROM users WHERE id = ?').bind(userId).first<{ email: string | null }>();
  return row?.email ?? null;
}
