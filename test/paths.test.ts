import { describe, expect, it } from 'vitest';
import { PathError, objectKey, parsePath } from '../src/storage/paths';
import { scopeAllows, validateScope } from '../src/permissions/scope';

describe('parsePath', () => {
  it('accepts project-relative markdown paths', () => {
    expect(parsePath('Project_Alpha/notes/a.md')).toMatchObject({ project: 'Project_Alpha', inProject: 'notes/a.md', isIndex: false });
    expect(parsePath('/P/checklist.md').rel).toBe('P/checklist.md');
  });

  it.each([
    '../other/x.md',
    'P/../../x.md',
    'P/./x.md',
    'P//x.md',
    'P\\x.md',
    'P/x.txt',
    'P/.md',
    'onlyproject',
    '',
    'P/x\u0000.md',
    '.hidden/x.md',
    '..%2f/x.md/y',
  ])('rejects %j', (p) => {
    expect(() => parsePath(p)).toThrow(PathError);
  });

  it('flags index.md in any letter case as reserved', () => {
    expect(parsePath('P/index.md').isIndex).toBe(true);
    expect(parsePath('P/INDEX.md').isIndex).toBe(true);
    expect(parsePath('P/sub/index.md').isIndex).toBe(false);
  });

  it('accepts attachments only when asked to', () => {
    expect(() => parsePath('P/img/a.png')).toThrow(PathError);
    expect(parsePath('P/img/a.PNG', { attachments: true })).toMatchObject({ kind: 'attachment', contentType: 'image/png', rel: 'P/img/a.PNG' });
    expect(parsePath('P/a.md', { attachments: true })).toMatchObject({ kind: 'markdown' });
    expect(parsePath('P/Lezione 1.docx', { attachments: true })).toMatchObject({
      kind: 'attachment',
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
    expect(parsePath('P/voti.XLSX', { attachments: true }).contentType).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(parsePath('P/slide.pptx', { attachments: true }).contentType).toBe('application/vnd.openxmlformats-officedocument.presentationml.presentation');
    // Legacy binary Office formats stay out: nothing can read them.
    for (const old of ['P/a.doc', 'P/a.xls', 'P/a.ppt']) expect(() => parsePath(old, { attachments: true })).toThrow(PathError);
    for (const bad of ['P/a.exe', 'P/.png', 'P/a', 'a.png']) expect(() => parsePath(bad, { attachments: true })).toThrow(PathError);
  });

  it('only objectKey adds the tenant prefix', () => {
    expect(objectKey('u1', 'P/a.md')).toBe('u1/P/a.md');
  });
});

describe('scope', () => {
  it('matches wildcard and project scopes', () => {
    expect(scopeAllows('*', 'A')).toBe(true);
    expect(scopeAllows('A/*', 'A')).toBe(true);
    expect(scopeAllows('A/*', 'AB')).toBe(false);
    expect(scopeAllows('A/*,B/*', 'B')).toBe(true);
  });
  it('validates scopes', () => {
    expect(validateScope('A/*, B/*')).toBe('A/*,B/*');
    expect(() => validateScope('A')).toThrow(PathError);
    expect(() => validateScope('../x/*')).toThrow(PathError);
  });
});
