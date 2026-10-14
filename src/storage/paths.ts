/**
 * Path handling. Everything an agent sends is untrusted. A path is accepted
 * only if it is project-relative, free of traversal, and ends in `.md`.
 * The tenant prefix is added exclusively by `objectKey`.
 */
export class PathError extends Error {}

const MAX_PATH = 512;
const MAX_SEGMENT = 128;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const PROJECT_RE = /^[\p{L}\p{N}][\p{L}\p{N} _.\-]{0,63}$/u;

export interface ParsedPath {
  project: string;
  /** Path inside the user's root: `Project/folder/file.md`. */
  rel: string;
  /** Project-relative path: `folder/file.md`. */
  inProject: string;
  /** `Project/index.md` in any letter case: backend-owned. */
  isIndex: boolean;
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

/** Parse `Project/path/to/file.md`. */
export function parsePath(input: unknown): ParsedPath {
  const segs = segments(input, 'path');
  if (segs.length < 2) throw new PathError('path must be "<project>/<file>.md"');
  const project = parseProject(segs[0]);
  const last = segs[segs.length - 1]!;
  if (!last.endsWith('.md') || last === '.md') throw new PathError('only .md files are allowed');
  const inProject = segs.slice(1).join('/');
  return {
    project,
    rel: `${project}/${inProject}`,
    inProject,
    isIndex: segs.length === 2 && last.toLowerCase() === 'index.md',
  };
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
