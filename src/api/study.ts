import type { Env } from '../env';

/**
 * Study mode ("Modalità studio") behind the same base URL as every other app
 * call. The work runs on the study Lambda (study-lambda/, docs/STUDY_API.md):
 * this route only forwards the request and passes the Lambda's server-sent
 * event stream through untouched — piping a body costs no Worker CPU, which is
 * the point of keeping the model calls off the free plan's 10 ms budget.
 *
 *   POST /v1/study-mode/generate   → Lambda POST /generate
 *   POST /v1/study-mode/grade      → Lambda POST /grade
 *
 * The caller's Cognito token is forwarded: the Lambda verifies it again (its
 * Function URL is public) and uses it to read the notes and save the report
 * through this Worker's /v1/file and /v1/blob, under the usual access rules.
 */

const PREFIX = '/v1/study-mode';
/** A graded session with 30 long answers stays well under this. */
const MAX_BODY = 1024 * 1024;

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export async function handleStudy(req: Request, env: Env, url: URL, token: string): Promise<Response | null> {
  if (url.pathname !== PREFIX && !url.pathname.startsWith(`${PREFIX}/`)) return null;
  const op = url.pathname.slice(PREFIX.length + 1);
  if (op !== 'generate' && op !== 'grade') return json({ error: 'Not found' }, 404);
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  if (!env.STUDY_LAMBDA_URL) return json({ error: 'Study mode is not configured on this server' }, 503);

  const declared = Number(req.headers.get('content-length') ?? 0);
  if (declared > MAX_BODY) return json({ error: 'Request too large' }, 413);
  const body = await req.arrayBuffer();
  if (body.byteLength > MAX_BODY) return json({ error: 'Request too large' }, 413);

  let upstream: Response;
  try {
    upstream = await fetch(`${env.STUDY_LAMBDA_URL.replace(/\/+$/, '')}/${op}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'text/event-stream' },
      body,
    });
  } catch (err) {
    console.error('study lambda unreachable', String(err));
    return json({ error: 'Study service unreachable' }, 502);
  }
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      'content-type': upstream.headers.get('content-type') ?? 'application/json',
      'cache-control': 'no-cache',
    },
  });
}
