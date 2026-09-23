export type DiffLine = { type: 'ctx' | 'add' | 'del'; text: string };
export type DiffHunk = { title: string | null; lines: DiffLine[] };

/** Line-level LCS diff. Knowledge-base files are small, O(n·m) is fine. */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.replace(/\n$/, '').split('\n');
  const b = after.replace(/\n$/, '').split('\n');
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: 'ctx', text: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) out.push({ type: 'del', text: a[i++] });
    else out.push({ type: 'add', text: b[j++] });
  }
  while (i < n) out.push({ type: 'del', text: a[i++] });
  while (j < m) out.push({ type: 'add', text: b[j++] });
  return out;
}

export function diffStats(lines: DiffLine[]) {
  return {
    added: lines.filter((l) => l.type === 'add').length,
    removed: lines.filter((l) => l.type === 'del').length,
  };
}

const HEADING = /^#{1,6}\s+(.*)$/;

/** Group changed lines into hunks titled by the closest preceding heading. */
export function toHunks(lines: DiffLine[], context = 1): DiffHunk[] {
  const keep = new Array(lines.length).fill(false);
  lines.forEach((l, i) => {
    if (l.type === 'ctx') return;
    for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) keep[k] = true;
  });
  const hunks: DiffHunk[] = [];
  let heading: string | null = null;
  let current: DiffHunk | null = null;
  lines.forEach((l, i) => {
    const h = l.type !== 'del' ? l.text.match(HEADING) : null;
    if (h) heading = h[1];
    if (!keep[i]) {
      current = null;
      return;
    }
    if (!current) {
      current = { title: heading, lines: [] };
      hunks.push(current);
    }
    // Don't repeat the heading line as context when it already titles the hunk.
    if (!(h && l.type === 'ctx' && current.lines.length === 0)) current.lines.push(l);
  });
  return hunks;
}
