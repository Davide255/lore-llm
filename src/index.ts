import { handleManagement } from './api/management';
import type { Env } from './env';
import { handleMcp } from './mcp/server';
import { handleOAuth } from './oauth/oauth';

function corsHeaders(req: Request, env: Env): Record<string, string> {
  const origin = req.headers.get('origin');
  const allowed = (env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!origin || !allowed.includes(origin)) return {};
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-headers': 'authorization, content-type, if-match',
    'access-control-expose-headers': 'x-lore-etag',
    'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    vary: 'Origin',
  };
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === '/health') return new Response('ok');

    const oauth = await handleOAuth(req, env, url);
    if (oauth) return oauth;

    if (url.pathname === '/mcp') return handleMcp(req, env, ctx);

    if (url.pathname.startsWith('/v1/')) {
      const cors = corsHeaders(req, env);
      if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
      const res = await handleManagement(req, env, url);
      const out = new Response(res.body, res);
      for (const [k, v] of Object.entries(cors)) out.headers.set(k, v);
      return out;
    }

    return new Response('Not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
