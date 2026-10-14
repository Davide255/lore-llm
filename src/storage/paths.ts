/**
 * Path handling. Everything an agent sends is untrusted. A path is accepted
 * only if it is project-relative, free of traversal, and ends in `.md`
 * (or, where the caller opts in, an allowed attachment extension).
 * The tenant prefix is added exclusively by `objectKey`.
 */
export class PathError extends Error {}

const MAX_PATH = 512;
const MAX_SEGMENT = 128;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const PROJECT_RE = /^[\p{L}\p{N}][\p{L}\p{N} _.\-]{0,63}$/u;

/** Binary files the user's own clients may store next to notes (images, PDFs). Agents only see markdown. */
export const ATTACHMENT_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
};

export const MARKDOWN_TYPE = 'text/markdown; charset=utf-8';

/** Content type of an allowed attachment file name, or null. */
export function attachmentType(name: string): string | null {
  const i = name.lastIndexOf('.');
  if (i <= 0) return null;
  return ATTACHMENT_TYPES[name.slice(i + 1).toLowerCase()] ?? null;
}

/** True for paths/keys of markdown notes (what agents, index.md and older clients see). */
export function isMarkdown(name: string): boolean {
  return name.toLowerCase().endsWith('.md');
}

/** A file name the store accepts: a note or an allowed attachment. */
export function isStorableFile(name: string): boolean {
  return isMarkdown(name) || attachmentType(name) !== null;
}

export interface ParsedPath {
  project: string;
  /** Path inside the user's root: `Project/folder/file.md`. */
  rel: string;
  /** Project-relative path: `folder/file.md`. */
  inProject: string;
  /** `Project/index.md` in any letter case: backend-owned. */
  isIndex: boolean;
  kind: 'markdown' | 'attachment';
  contentType: string;
}

export function parseProject(input: unknown): string {
  if (typeof input !== 'string') throw new PathError('project must be a string');
  const project = input.normalize('NFC');
  if (!PROJECT_RE.test(project) || project.includes('..')) throw new PathError(`Invalid project name: ${input}`);
  return project;
}

function segments(input: unknown, what: string): string[] {
  if (typeof input !== 'string' || input === '') throw new PathError(`${what} must be a non-empty string`);
  if (input.length > MAX_PATH) throw new PathError(`${what} is too long`);
  if (CONTROL_RE.test(input) || input.includes('\\')) throw new PathError(`${what} contains forbidden characters`);
  const segs = input.normalize('NFC').replace(/^\/+/, '').split('/');
  for (const s of segs) {
    if (s === '' || s === '.' || s === '..') throw new PathError(`${what} contains an invalid segment`);
    if (s.length > MAX_SEGMENT) throw new PathError(`${what} contains a segment that is too long`);
  }
  return segs;
}

/**
 * Parse `Project/path/to/file.md`. With `attachments: true` an allowed
 * attachment (`Project/img/photo.png`) is accepted too; the default stays
 * markdown-only so agent tools and the text file API are unchanged.
 */
export function parsePath(input: unknown, opts: { attachments?: boolean } = {}): ParsedPath {
  const segs = segments(input, 'path');
  if (segs.length < 2) throw new PathError('path must be "<project>/<file>.md"');
  const project = parseProject(segs[0]);
  const last = segs[segs.length - 1]!;
  const inProject = segs.slice(1).join('/');
  const base = { project, rel: `${project}/${inProject}`, inProject };
  if (last.endsWith('.md') && last !== '.md') {
    return { ...base, isIndex: segs.length === 2 && last.toLowerCase() === 'index.md', kind: 'markdown', contentType: MARKDOWN_TYPE };
  }
  const type = opts.attachments && !last.startsWith('.') ? attachmentType(last) : null;
  if (!type) {
    throw new PathError(
      opts.attachments
        ? `only .md files and attachments (${Object.keys(ATTACHMENT_TYPES).join(', ')}) are allowed`
        : 'only .md files are allowed',
    );
  }
  return { ...base, isIndex: false, kind: 'attachment', contentType: type };
}

/** Optional folder inside a project (for listings). */
export function parseFolder(input: unknown): string {
  if (input === undefined || input === null || input === '') return '';
  return segments(input, 'folder').join('/');
}

/** The one place where the tenant prefix is applied. */
export function objectKey(userId: string, rel: string): string {
  return `${userId}/${rel}`;
}
