import { AuthError } from '../auth/jwt';
import { verifyAgentToken } from '../auth/agentToken';
import { getAgent } from '../db/permissions';
import type { AgentContext, Env } from '../env';
import { oauthEnabled, protectedResourceMetadataUrl } from '../oauth/oauth';
import { Store } from '../storage/store';
import { callTool, toolDescriptors } from './tools';

const SUPPORTED_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_BATCH = 20;

type Id = string | number | null;
interface RpcRequest {
  jsonrpc: '2.0';
  id?: Id;
  method: string;
  params?: unknown;
}

const rpcError = (id: Id, code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } });
const json = (body: unknown, status = 200, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

export function bearerToken(req: Request): string | null {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.get('authorization') ?? '');
  return m ? m[1]!.trim() : null;
}

/** Token proves identity; the permissions row (D1) decides what the agent may do. */
export async function authenticateAgent(req: Request, env: Env): Promise<AgentContext> {
  const token = bearerToken(req);
  if (!token) throw new AuthError('Missing bearer token');
  const claims = await verifyAgentToken(env.AGENT_TOKEN_SECRET, token);
  const row = await getAgent(env.DB, claims.agentId);
  if (!row || row.user_id !== claims.userId) throw new AuthError('Agent revoked or unknown');
  return {
    agentId: row.agent_id,
    userId: row.user_id,
    projectScope: row.project_scope,
    accessLevel: row.access_level,
  };
}

function originAllowed(req: Request, env: Env): boolean {
  const origin = req.headers.get('origin');
  if (!origin) return true; // non-browser MCP clients send no Origin
  return (env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .includes(origin);
}

/** MCP Streamable HTTP, stateless: every POST is self-contained, no sessions, no SSE stream. */
export async function handleMcp(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (!originAllowed(req, env)) return json({ error: 'Origin not allowed' }, 403);
  if (req.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } });

  let agent: AgentContext;
  try {
    agent = await authenticateAgent(req, env);
  } catch (err) {
    if (err instanceof AuthError) {
      const challenge = oauthEnabled(env)
        ? `Bearer realm="lore-llm", resource_metadata="${protectedResourceMetadataUrl(new URL(req.url).origin)}"`
        : 'Bearer realm="lore-llm"';
      return json({ error: err.message }, err.status, { 'www-authenticate': challenge });
    }
    throw err;
  }

  if (Number(req.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) return json(rpcError(null, -32600, 'Request too large'), 413);
  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return json(rpcError(null, -32600, 'Request too large'), 413);

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return json(rpcError(null, -32700, 'Parse error'), 400);
  }

  const store = new Store(env.BUCKET);
  const toolCtx = { agent, store, db: env.DB, waitUntil: (p: Promise<unknown>) => ctx.waitUntil(p) };
  const batch = Array.isArray(body);
  const items: unknown[] = Array.isArray(body) ? body : [body];
  if (items.length === 0 || items.length > MAX_BATCH) return json(rpcError(null, -32600, 'Invalid batch size'), 400);

  const responses: unknown[] = [];
  for (const item of items) {
    const res = await dispatch(item as RpcRequest, toolCtx);
    if (res) responses.push(res);
  }
  if (responses.length === 0) return new Response(null, { status: 202 }); // only notifications/responses
  return json(batch ? responses : responses[0]);
}

async function dispatch(msg: RpcRequest, toolCtx: Parameters<typeof callTool>[2]): Promise<unknown | null> {
  if (typeof msg !== 'object' || msg === null || msg.jsonrpc !== '2.0') return rpcError(null, -32600, 'Invalid request');
  const isNotification = !('id' in msg) || msg.id === undefined;
  if (typeof msg.method !== 'string') return isNotification ? null : rpcError(msg.id ?? null, -32600, 'Invalid request');
  if (isNotification) return null; // e.g. notifications/initialized: nothing to do, stateless
  const id = msg.id as Id;
  const params = (msg.params ?? {}) as Record<string, unknown>;

  switch (msg.method) {
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'lore-llm', version: '0.1.0' },
          instructions:
            'Markdown knowledge base. Call list_projects, then read "<project>/index.md" for the project map. ' +
            'index.md is generated and read-only.',
        },
      };
    }
    case 'ping':
      return { jsonrpc: '2.0', id, result: {} };
    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools: toolDescriptors() } };
    case 'tools/call': {
      if (typeof params.name !== 'string') return rpcError(id, -32602, 'Missing tool name');
      const result = await callTool(params.name, params.arguments ?? {}, toolCtx);
      return result ? { jsonrpc: '2.0', id, result } : rpcError(id, -32602, `Unknown tool: ${params.name}`);
    }
    default:
      return rpcError(id, -32601, `Method not found: ${msg.method}`);
  }
}
