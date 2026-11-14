import { describe, expect, it, vi } from 'vitest';
import { handle, type AppDeps } from '../src/app';
import { parseReport, slugify } from '../src/report';
import { formatEvent, sseWriter } from '../src/sse';
import { workerClient } from '../src/worker-client';
import { memoryKb, scriptedModel } from './fakes';

function response() {
  const out = { status: 0, headers: {} as Record<string, string>, body: '', ended: false };
  return {
    out,
    res: {
      open(status: number, headers: Record<string, string>) {
        out.status = status;
        out.headers = headers;
        return { write: (c: string) => (out.body += c), end: () => (out.ended = true) };
      },
    },
  };
}
const deps = (over: Partial<AppDeps> = {}): AppDeps => ({
  verify: async (t) => {
    if (t !== 'good') throw new Error('bad');
    return { userId: 'u' };
  },
  model: scriptedModel([]),
  kb: () => memoryKb({ 'P/a.md': 'testo' }),
  today: () => '2026-11-14',
  heartbeatMs: 0,
  ...over,
});
const post = (path: string, body: unknown, token = 'good') => ({ method: 'POST', path, headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) });

describe('handler', () => {
  it('answers 401 without a valid token, 404 and 405 for unknown routes, 400 for a bad body', async () => {
    for (const [req, status] of [
      [{ ...post('/generate', {}), headers: {} }, 401],
      [post('/generate', {}, 'bad'), 401],
      [post('/nope', {}), 404],
      [{ ...post('/grade', {}), method: 'GET' }, 405],
      [post('/generate', { sources: [] }), 400],
    ] as const) {
      const { out, res } = response();
      await handle(req, res, deps());
      expect(out.status).toBe(status);
      expect(out.headers['content-type']).toBe('application/json');
    }
  });

  it('streams SSE and turns a failure into an error event', async () => {
    const { out, res } = response();
    await handle(post('/generate', { sources: [{ path: 'P/missing.md' }], mix: { mc: 1, tf: 0, open: 0 } }), res, deps());
    expect(out.status).toBe(200);
    expect(out.headers['content-type']).toContain('text/event-stream');
    expect(out.body).toContain('event: file');
    expect(out.body).toContain('event: error');
    expect(out.ended).toBe(true);
  });
});

describe('sse', () => {
  it('formats events and stops writing after close', () => {
    expect(formatEvent({ event: 'done', data: { count: 2 } })).toBe('event: done\ndata: {"count":2}\n\n');
    const chunks: string[] = [];
    const w = sseWriter({ write: (c) => chunks.push(c), end: () => chunks.push('END') }, 0);
    w.emit({ event: 'done', data: {} });
    w.close();
    w.emit({ event: 'done', data: {} });
    w.close();
    expect(chunks).toEqual(['event: done\ndata: {}\n\n', 'END']);
  });
});

describe('report', () => {
  it('slugifies topics and ignores notes without the data block', () => {
    expect(slugify('Criterio del rapporto — L = 1!')).toBe('criterio-del-rapporto-l-1');
    expect(slugify('Città è perché')).toBe('citta-e-perche');
    expect(slugify('***')).toBe('sessione');
    expect(parseReport('# Nota\nniente')).toBeNull();
    expect(parseReport('```lore-study\n{not json}\n```')).toBeNull();
  });
});

describe('worker client', () => {
  it('passes the token and owner, maps errors, and finds a free report name', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const taken = new Set(['P/studio/r.md', 'P/studio/r-2.md']);
    const fetcher = vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      const path = new URL(url).searchParams.get('path')!;
      if (init.method === 'PUT') {
        return taken.has(path)
          ? new Response(JSON.stringify({ error: `File already exists: ${path}` }), { status: 400 })
          : new Response('{}', { status: 201 });
      }
      if (path === 'P/no.md') return new Response('{"error":"Not found"}', { status: 404 });
      if (path === 'P/team.md') return new Response('{"error":"Forbidden"}', { status: 403 });
      return new Response(JSON.stringify({ content: 'ciao' }));
    });
    const kb = workerClient('https://w.example/', 'tok', fetcher as unknown as typeof fetch);

    expect(await kb.readNote('P/a.md', 't:abc')).toBe('ciao');
    expect(calls[0]!.url).toBe('https://w.example/v1/file?path=P%2Fa.md&owner=t%3Aabc');
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer tok');
    await expect(kb.readNote('P/no.md')).rejects.toMatchObject({ code: 'not_found' });
    await expect(kb.readNote('P/team.md')).rejects.toMatchObject({ code: 'forbidden' });
    expect(await kb.createNote('P/studio/r.md', '# r')).toBe('P/studio/r-3.md');
  });
});
