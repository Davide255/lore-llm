export const INDEX_FILE = 'index.md';
export const CHECKLIST_FILE = 'checklist.md';

export function splitPath(path: string): string[] {
  return path.split('/').filter(Boolean);
}

export function joinPath(...parts: (string | undefined | null)[]): string {
  return parts
    .filter((p): p is string => !!p)
    .flatMap(splitPath)
    .join('/');
}

export function basename(path: string): string {
  const parts = splitPath(path);
  return parts[parts.length - 1] ?? '';
}

export function dirname(path: string): string {
  return splitPath(path).slice(0, -1).join('/');
}

export function projectOf(path: string): string {
  return splitPath(path)[0] ?? '';
}

export function isProjectRoot(path: string): boolean {
  return splitPath(path).length === 1;
}

export function roleOf(path: string): 'index' | 'checklist' | 'doc' {
  const parts = splitPath(path);
  if (parts.length === 2 && parts[1] === INDEX_FILE) return 'index';
  if (parts.length === 2 && parts[1] === CHECKLIST_FILE) return 'checklist';
  return 'doc';
}

/** Resolve a markdown link target relative to the folder of `fromFile`. */
export function resolveLink(fromFile: string, target: string): string | null {
  if (/^[a-z]+:/i.test(target) || target.startsWith('#')) return null;
  const clean = decodeURIComponent(target.split('#')[0]);
  const base = clean.startsWith('/') ? [] : splitPath(dirname(fromFile));
  for (const part of splitPath(clean)) {
    if (part === '.') continue;
    if (part === '..') base.pop();
    else base.push(part);
  }
  return base.join('/');
}

const FILE_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

/** File/folder names: lowercase and dashes, no spaces (per design C2). */
export function validateSlug(name: string): string | null {
  if (!name) return 'Inserisci un nome.';
  if (!FILE_NAME_RE.test(name)) return 'Solo minuscole, numeri e trattini.';
  return null;
}

export function slugify(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}
