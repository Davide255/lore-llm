import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import type { Env } from '../src/env';

/** Minimal in-memory R2 with the subset of semantics the code relies on (etag preconditions, delimiter, cursor). */
export class FakeR2 {
  objects = new Map<string, { body: string; etag: string; uploaded: Date; customMetadata?: Record<string, string> }>();
  private n = 0;

  private view(key: string) {
    const o = this.objects.get(key);
    if (!o) return null;
    return { key, size: new TextEncoder().encode(o.body).byteLength, etag: o.etag, uploaded: o.uploaded, text: async () => o.body };
  }
  async get(key: string) {
    return this.view(key);
  }
  async head(key: string) {
    return this.view(key);
  }
  async put(key: string, value: string, opts?: { onlyIf?: { etagMatches?: string }; customMetadata?: Record<string, string> }) {
    const cur = this.objects.get(key);
    if (opts?.onlyIf?.etagMatches !== undefined && cur?.etag !== opts.onlyIf.etagMatches) return null;
    await Promise.resolve(); // yield, so concurrent callers really interleave
    this.objects.set(key, { body: value, etag: `e${++this.n}`, uploaded: new Date('2026-01-02T00:00:00Z'), customMetadata: opts?.customMetadata });
    return this.view(key);
  }
  async delete(key: string) {
    this.objects.delete(key);
  }
  async list(opts: { prefix?: string; delimiter?: string; cursor?: string; limit?: number }) {
    const prefix = opts.prefix ?? '';
    const keys = [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
    const delimited = new Set<string>();
    const direct: string[] = [];
    for (const k of keys) {
      const rest = k.slice(prefix.length);
      const i = opts.delimiter ? rest.indexOf(opts.delimiter) : -1;
      if (i === -1) direct.push(k);
      else delimited.add(prefix + rest.slice(0, i + 1));
    }
    const start = Number(opts.cursor ?? 0);
    const limit = opts.limit ?? 1000;
    const page = direct.slice(start, start + limit);
    const truncated = start + limit < direct.length;
    return {
      objects: page.map((k) => this.view(k)!),
      delimitedPrefixes: start === 0 ? [...delimited] : [],
      truncated,
      cursor: truncated ? String(start + limit) : undefined,
    };
  }
}

/** D1 look-alike over node:sqlite so the real SQL (and the real migration) is exercised. */
export function makeFakeD1() {
  const db = new DatabaseSync(':memory:');
  // Every migration in order, like `wrangler d1 migrations apply`.
  const dir = new URL('../migrations/', import.meta.url);
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(f, dir), 'utf8'));
  class Stmt {
    constructor(
      private sql: string,
      private args: unknown[] = [],
    ) {}
    bind(...a: unknown[]) {
      return new Stmt(this.sql, a);
    }
    async first() {
      const r = db.prepare(this.sql).get(...(this.args as never[]));
      return r ? { ...r } : null;
    }
    async all() {
      return { results: db.prepare(this.sql).all(...(this.args as never[])).map((r) => ({ ...r })) };
    }
    async run() {
      const r = db.prepare(this.sql).run(...(this.args as never[]));
      return { meta: { changes: Number(r.changes) } };
    }
  }
  return { prepare: (sql: string) => new Stmt(sql), raw: db };
}

export function makeEnv(overrides: Partial<Env> = {}) {
  const bucket = new FakeR2();
  const d1 = makeFakeD1();
  const env = {
    BUCKET: bucket,
    DB: d1,
    COGNITO_REGION: 'eu-north-1',
    COGNITO_USER_POOL_ID: 'eu-north-1_TEST',
    COGNITO_CLIENT_IDS: 'client-1',
    AGENT_TOKEN_SECRET: 'x'.repeat(48),
    ALLOWED_ORIGINS: '',
    ...overrides,
  } as unknown as Env;
  return { env, bucket, d1 };
}

/** ExecutionContext that lets tests await the waitUntil work (audit writes). */
export function makeCtx() {
  const pending: Promise<unknown>[] = [];
  return {
    ctx: { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException() {} } as unknown as ExecutionContext,
    flush: () => Promise.all(pending),
  };
}
