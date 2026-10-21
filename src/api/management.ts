import { signAgentToken } from '../auth/agentToken';
import { cognitoConfigFromEnv, verifyCognitoToken } from '../auth/cognito';
import { AuthError, nowSeconds } from '../auth/jwt';
import { listAudit } from '../db/audit';
import { upsertUser } from '../db/users';
import { handleFiles } from './files';
import { createAgent, deleteAgent, listAgents, updateAgent } from '../db/permissions';
import type { Env } from '../env';
import { bearerToken } from '../mcp/server';
import { MAX_AGENTS_PER_USER, validateAccessLevel, validateAgentType, validateScope } from '../permissions/scope';
import { PathError, parseProject } from '../storage/paths';
import { Store } from '../storage/store';

const DEFAULT_TOKEN_DAYS = 90;
const MAX_TOKEN_DAYS = 365;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const body = await req.json();
    if (typeof body === 'object' && body !== null && !Array.isArray(body)) return body as Record<string, unknown>;
  } catch {
    /* fall through */
  }
  throw new PathError('Body must be a JSON object');
}

function validName(v: unknown): string {
  if (typeof v !== 'string' || v.trim() === '' || v.length > 64) throw new PathError('name must be 1-64 characters');
  return v.trim();
}

/** Management API: authenticated with the human's Cognito token, always scoped to that user. */
export async function handleManagement(req: Request, env: Env, url: URL): Promise<Response> {
  const token = bearerToken(req);
  if (!token) return json({ error: 'Missing bearer token' }, 401);
  let userId: string;
  try {
    const user = await verifyCognitoToken(token, cognitoConfigFromEnv(env));
    userId = user.userId;
    // Best effort: the directory must never make a valid request fail.
    await upsertUser(env.DB, user).catch((err) => console.error('user upsert failed', String(err)));
  } catch (err) {
    if (err instanceof AuthError) return json({ error: err.message }, err.status);
    throw err;
  }

  try {
    const path = url.pathname;
    const m = req.method;

    const files = await handleFiles(req, env, url, userId);
    if (files) return files;

    if (path === '/v1/agents' && m === 'GET') {
      const rows = await listAgents(env.DB, userId);
      return json({ agents: rows.map(({ user_id: _u, ...rest }) => rest) });
    }

    if (path === '/v1/agents' && m === 'POST') {
      const body = await readJson(req);
      if ((await listAgents(env.DB, userId)).length >= MAX_AGENTS_PER_USER) {
        return json({ error: `Agent limit reached (${MAX_AGENTS_PER_USER})` }, 409);
      }
      const days = body.expires_in_days === undefined ? DEFAULT_TOKEN_DAYS : Number(body.expires_in_days);
      if (!Number.isInteger(days) || days < 1 || days > MAX_TOKEN_DAYS) {
        throw new PathError(`expires_in_days must be an integer between 1 and ${MAX_TOKEN_DAYS}`);
      }
      const row = {
        agent_id: crypto.randomUUID(),
        user_id: userId,
        name: validName(body.name),
        // Optional for older clients: they only ever created Claude agents.
        agent_type: body.agent_type === undefined ? 'claude' : validateAgentType(body.agent_type),
        project_scope: validateScope(body.project_scope),
        access_level: validateAccessLevel(body.access_level),
        created_at: new Date().toISOString(),
      };
      await createAgent(env.DB, row);
      const expiresAt = nowSeconds() + days * 86400;
      const agentToken = await signAgentToken(env.AGENT_TOKEN_SECRET, { agentId: row.agent_id, userId }, expiresAt);
      const { user_id: _u, ...agent } = row;
      // The token is shown exactly once: it is not stored anywhere.
      return json({ agent, token: agentToken, expires_at: new Date(expiresAt * 1000).toISOString() }, 201);
    }

    const agentMatch = /^\/v1\/agents\/([A-Za-z0-9-]{1,64})$/.exec(path);
    if (agentMatch && m === 'PATCH') {
      const body = await readJson(req);
      const patch = {
        ...(body.project_scope !== undefined ? { project_scope: validateScope(body.project_scope) } : {}),
        ...(body.access_level !== undefined ? { access_level: validateAccessLevel(body.access_level) } : {}),
        ...(body.name !== undefined ? { name: validName(body.name) } : {}),
        ...(body.agent_type !== undefined ? { agent_type: validateAgentType(body.agent_type) } : {}),
      };
      if (Object.keys(patch).length === 0) throw new PathError('Nothing to update');
      return (await updateAgent(env.DB, userId, agentMatch[1]!, patch)) ? json({ ok: true }) : json({ error: 'Not found' }, 404);
    }
    if (agentMatch && m === 'DELETE') {
      return (await deleteAgent(env.DB, userId, agentMatch[1]!)) ? json({ ok: true }) : json({ error: 'Not found' }, 404);
    }

    if (path === '/v1/audit' && m === 'GET') {
      const q = url.searchParams;
      const limit = Math.min(Math.max(Number(q.get('limit') ?? 50) || 50, 1), 200);
      const before = q.get('before') ? Number(q.get('before')) : undefined;
      if (before !== undefined && !Number.isInteger(before)) throw new PathError('before must be an integer');
      const items = await listAudit(env.DB, userId, {
        limit,
        before,
        agentId: q.get('agent_id') ?? undefined,
        project: q.get('project') ? parseProject(q.get('project')) : undefined,
      });
      const last = items[items.length - 1];
      return json({ items, next_before: items.length === limit && last ? last.log_id : null });
    }

    const reindex = /^\/v1\/projects\/([^/]+)\/reindex$/.exec(path);
    if (reindex && m === 'POST') {
      await new Store(env.BUCKET).compileIndex(userId, parseProject(decodeURIComponent(reindex[1]!)));
      return json({ ok: true });
    }

    return json({ error: 'Not found' }, 404);
  } catch (err) {
    if (err instanceof PathError) return json({ error: err.message }, 400);
    console.error('management error', String(err));
    return json({ error: 'Internal error' }, 500);
  }
}
