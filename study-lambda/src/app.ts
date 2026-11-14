/**
 * Request handling, independent of the Lambda runtime so tests can drive it:
 * authenticate, validate, then run a pipeline that streams SSE events.
 *
 *   POST /generate   GenerateRequest → file*, topics, question*, done
 *   POST /grade      GradeRequest    → graded*, result, saved | save_failed, done
 *
 * Errors before the stream opens are plain JSON with a 4xx status; once it is
 * open, a failure is an `error` event and the stream ends.
 */
import type { ZodType } from 'zod';
import { generate } from './generate';
import { grade } from './grade';
import type { Model } from './model';
import { sseWriter, type Sink } from './sse';
import { generateRequestSchema, gradeRequestSchema, StudyError } from './types';
import type { WorkerClient } from './worker-client';

export interface Request {
  method: string;
  path: string;
  headers: Record<string, string | undefined>;
  body: string;
}

export interface Response {
  /** Opens the response with a status and headers; returns where the body goes. */
  open(status: number, headers: Record<string, string>): Sink;
}

export interface AppDeps {
  /** Verifies a Cognito token; throws when it is not valid. */
  verify(token: string): Promise<{ userId: string }>;
  model: Model;
  kb(token: string): WorkerClient;
  today(): string;
  heartbeatMs?: number;
  log?: (msg: string, extra?: unknown) => void;
}

const JSON_HEADERS = { 'content-type': 'application/json' };
const SSE_HEADERS = { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', 'x-accel-buffering': 'no' };

function reply(res: Response, status: number, body: unknown): void {
  const sink = res.open(status, JSON_HEADERS);
  sink.write(JSON.stringify(body));
  sink.end();
}

function parse<T>(schema: ZodType<T>, raw: string): T | string {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return 'Body must be JSON';
  }
  const r = schema.safeParse(json);
  return r.success ? r.data : r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ');
}

export async function handle(req: Request, res: Response, deps: AppDeps): Promise<void> {
  const route = req.path.replace(/\/+$/, '');
  if (route !== '/generate' && route !== '/grade') return reply(res, 404, { error: 'Not found' });
  if (req.method !== 'POST') return reply(res, 405, { error: 'Method not allowed' });

  const auth = req.headers.authorization ?? req.headers.Authorization ?? '';
  const token = auth.match(/^Bearer\s+(\S+)$/i)?.[1];
  if (!token) return reply(res, 401, { error: 'Missing bearer token' });
  try {
    await deps.verify(token);
  } catch {
    return reply(res, 401, { error: 'Invalid or expired token' });
  }

  const body = route === '/generate' ? parse(generateRequestSchema, req.body) : parse(gradeRequestSchema, req.body);
  if (typeof body === 'string') return reply(res, 400, { error: body });

  const stream = sseWriter(res.open(200, SSE_HEADERS), deps.heartbeatMs);
  const kb = deps.kb(token);
  try {
    if (route === '/generate') {
      await generate(body as Parameters<typeof generate>[0], { model: deps.model, kb, emit: stream.emit });
    } else {
      await grade(body as Parameters<typeof grade>[0], { model: deps.model, kb, emit: stream.emit, today: deps.today });
    }
  } catch (err) {
    const known = err instanceof StudyError;
    deps.log?.('study request failed', { route, code: known ? err.code : 'internal', error: String(err) });
    stream.emit({
      event: 'error',
      data: known ? { code: err.code, message: err.message } : { code: modelCode(err), message: 'Something went wrong, try again' },
    });
  } finally {
    stream.close();
  }
}

/** Anthropic SDK errors carry a numeric status; anything else is ours. */
function modelCode(err: unknown): 'model' | 'internal' {
  return typeof (err as { status?: unknown })?.status === 'number' ? 'model' : 'internal';
}
