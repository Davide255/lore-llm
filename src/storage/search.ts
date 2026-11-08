/** Query parsing and result shaping for global search (the index itself lives in src/db/searchIndex.ts). */

export interface SearchSnippet {
  /** 1-based line number. */
  line: number;
  text: string;
}

export interface SearchHit {
  /** Path inside the user's root: `Project/folder/file.md`. */
  path: string;
  /** Relevance, higher is better. */
  score: number;
  pathMatch: boolean;
  snippets: SearchSnippet[];
}

export const MAX_QUERY_LENGTH = 200;
export const MAX_TERMS = 8;
const MAX_SNIPPETS = 3;
const SNIPPET_WIDTH = 160;

export function parseQuery(input: unknown): string[] {
  if (typeof input !== 'string') return [];
  const terms = input
    .normalize('NFC')
    .toLowerCase()
    .slice(0, MAX_QUERY_LENGTH)
    .split(/\s+/)
    .filter(Boolean);
  return [...new Set(terms)].slice(0, MAX_TERMS);
}

/** FTS5 expression: every term is a quoted prefix token, so user input can never inject FTS syntax. */
export function ftsTerms(terms: string[]): string {
  return terms.map((t) => `"${t.replace(/"/g, '""')}"*`).join(' AND ');
}

/** First `# heading`, else the file name without extension. */
export function titleOf(path: string, content: string): string {
  const m = /^#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/m.exec(content.slice(0, 4096));
  if (m?.[1]) return m[1];
  const name = path.slice(path.lastIndexOf('/') + 1);
  return name.replace(/\.md$/i, '');
}

function clip(line: string, at: number): string {
  const trimmed = line.trim();
  if (trimmed.length <= SNIPPET_WIDTH) return trimmed;
  const offset = at - (line.length - line.trimStart().length);
  const start = Math.max(0, Math.min(offset - 40, trimmed.length - SNIPPET_WIDTH));
  const end = Math.min(trimmed.length, start + SNIPPET_WIDTH);
  return `${start > 0 ? '…' : ''}${trimmed.slice(start, end)}${end < trimmed.length ? '…' : ''}`;
}

/** Up to 3 lines containing a term; falls back to the first non-empty line (e.g. a path-only match). */
export function snippetsFor(content: string, terms: string[]): SearchSnippet[] {
  const out: SearchSnippet[] = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length && out.length < MAX_SNIPPETS; i++) {
    const line = lines[i] ?? '';
    const lower = line.toLowerCase();
    const at = Math.min(...terms.map((t) => lower.indexOf(t)).filter((x) => x !== -1));
    if (Number.isFinite(at)) out.push({ line: i + 1, text: clip(line, at) });
  }
  if (out.length === 0) {
    const i = lines.findIndex((l) => l.trim() !== '');
    if (i !== -1) out.push({ line: i + 1, text: clip(lines[i] ?? '', 0) });
  }
  return out;
}
