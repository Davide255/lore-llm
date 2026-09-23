/**
 * Minimal, line-oriented markdown model used by both the reader and the
 * block editor. It covers what a knowledge base needs (headings, paragraphs,
 * bullet/ordered/task lists, quotes, fenced code, rules, GFM tables) and round-trips:
 * `serialize(parse(src))` is a normalized but semantically equal document.
 */

export type Block =
  | { type: 'heading'; level: number; text: string; line: number }
  | { type: 'paragraph'; text: string; line: number }
  | { type: 'bullet'; indent: number; text: string; line: number }
  | { type: 'ordered'; indent: number; n: number; text: string; line: number }
  | { type: 'task'; indent: number; checked: boolean; text: string; line: number }
  | { type: 'quote'; text: string; line: number }
  | { type: 'code'; lang: string; text: string; line: number }
  /** GFM table. `text` is the table's source; cells come from `parseTable`. */
  | { type: 'table'; text: string; line: number }
  | { type: 'rule'; line: number };

export type BlockType = Block['type'];

const HEADING = /^(#{1,6})\s+(.*)$/;
const TASK = /^(\s*)[-*+]\s+\[( |x|X)\]\s?(.*)$/;
const BULLET = /^(\s*)[-*+]\s+(.*)$/;
const ORDERED = /^(\s*)(\d+)[.)]\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;
const FENCE = /^\s*```\s*([\w+-]*)\s*$/;
const RULE = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/;

const TABLE_DELIM = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

function indentOf(ws: string) {
  const spaces = ws.replace(/\t/g, '  ').length;
  return Math.floor(spaces / 2);
}

function isSpecial(line: string) {
  return (
    HEADING.test(line) ||
    TASK.test(line) ||
    BULLET.test(line) ||
    ORDERED.test(line) ||
    QUOTE.test(line) ||
    FENCE.test(line) ||
    RULE.test(line)
  );
}

export type Align = 'left' | 'center' | 'right' | null;

/** Split a table row on unescaped pipes, dropping the optional outer ones. */
function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && s[i + 1] === '|') {
      cur += '|';
      i++;
    } else if (s[i] === '|') {
      cells.push(cur.trim());
      cur = '';
    } else cur += s[i];
  }
  cells.push(cur.trim());
  return cells;
}

/** A table starts at `i` when a row is followed by a delimiter row with as many columns. */
function isTableStart(lines: string[], i: number) {
  const head = lines[i];
  const delim = lines[i + 1];
  if (!head?.includes('|') || isSpecial(head) || delim === undefined || !TABLE_DELIM.test(delim)) return false;
  return splitRow(head).length === splitRow(delim).length;
}

const isTableRow = (line: string) => line.trim() !== '' && line.includes('|') && !isSpecial(line);

export function parseTable(src: string): { header: string[]; align: Align[]; rows: string[][] } {
  const [head = '', delim = '', ...body] = src.split('\n');
  const header = splitRow(head);
  const align = splitRow(delim).map((c): Align => {
    const l = c.startsWith(':');
    const r = c.endsWith(':');
    return l && r ? 'center' : r ? 'right' : l ? 'left' : null;
  });
  // GFM: rows are padded or truncated to the header's width.
  const rows = body.map((l) => {
    const cells = splitRow(l).slice(0, header.length);
    while (cells.length < header.length) cells.push('');
    return cells;
  });
  return { header, align, rows };
}

export function parse(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    let m: RegExpMatchArray | null;
    if ((m = line.match(FENCE))) {
      const start = i;
      const body: string[] = [];
      i++;
      while (i < lines.length && !FENCE.test(lines[i])) body.push(lines[i++]);
      i++; // closing fence
      blocks.push({ type: 'code', lang: m[1] ?? '', text: body.join('\n'), line: start });
      continue;
    }
    if (isTableStart(lines, i)) {
      const start = i;
      const body = [lines[i].trim(), lines[i + 1].trim()];
      i += 2;
      while (i < lines.length && isTableRow(lines[i])) body.push(lines[i++].trim());
      blocks.push({ type: 'table', text: body.join('\n'), line: start });
      continue;
    }
    if (RULE.test(line)) {
      blocks.push({ type: 'rule', line: i++ });
      continue;
    }
    if ((m = line.match(HEADING))) {
      blocks.push({ type: 'heading', level: m[1].length, text: m[2].trim(), line: i++ });
      continue;
    }
    if ((m = line.match(TASK))) {
      blocks.push({
        type: 'task',
        indent: indentOf(m[1]),
        checked: m[2] !== ' ',
        text: m[3],
        line: i++,
      });
      continue;
    }
    if ((m = line.match(BULLET))) {
      blocks.push({ type: 'bullet', indent: indentOf(m[1]), text: m[2], line: i++ });
      continue;
    }
    if ((m = line.match(ORDERED))) {
      blocks.push({ type: 'ordered', indent: indentOf(m[1]), n: Number(m[2]), text: m[3], line: i++ });
      continue;
    }
    if (QUOTE.test(line)) {
      const start = i;
      const body: string[] = [];
      while (i < lines.length && (m = lines[i].match(QUOTE))) {
        body.push(m[1]);
        i++;
      }
      blocks.push({ type: 'quote', text: body.join('\n'), line: start });
      continue;
    }
    // Paragraph: merge consecutive plain lines. Indented continuation lines of
    // a list item are folded into that item.
    const prev = blocks[blocks.length - 1];
    if (
      prev &&
      (prev.type === 'bullet' || prev.type === 'task' || prev.type === 'ordered') &&
      /^\s+\S/.test(line) &&
      i > 0 &&
      lines[i - 1].trim() !== ''
    ) {
      prev.text += ' ' + line.trim();
      i++;
      continue;
    }
    const start = i;
    const body: string[] = [];
    // A table can interrupt a paragraph.
    while (i < lines.length && lines[i].trim() && !isSpecial(lines[i]) && !(i > start && isTableStart(lines, i)))
      body.push(lines[i++].trim());
    blocks.push({ type: 'paragraph', text: body.join(' '), line: start });
  }
  return blocks;
}

const LISTY: BlockType[] = ['bullet', 'ordered', 'task'];

export function serializeBlock(b: Block): string {
  const pad = (n: number) => '  '.repeat(n);
  switch (b.type) {
    case 'heading':
      return `${'#'.repeat(b.level)} ${b.text}`;
    case 'task':
      return `${pad(b.indent)}- [${b.checked ? 'x' : ' '}] ${b.text}`;
    case 'bullet':
      return `${pad(b.indent)}- ${b.text}`;
    case 'ordered':
      return `${pad(b.indent)}${b.n}. ${b.text}`;
    case 'quote':
      return b.text
        .split('\n')
        .map((l) => `> ${l}`)
        .join('\n');
    case 'code':
      return '```' + b.lang + '\n' + b.text + '\n```';
    case 'table':
      return b.text;
    case 'rule':
      return '---';
    case 'paragraph':
      return b.text;
  }
}

export function serialize(blocks: Block[]): string {
  let out = '';
  blocks.forEach((b, i) => {
    if (i > 0) {
      const prev = blocks[i - 1];
      const tight = LISTY.includes(prev.type) && LISTY.includes(b.type);
      out += tight ? '\n' : '\n\n';
    }
    out += serializeBlock(b);
  });
  return out + '\n';
}

// ─── Inline ──────────────────────────────────────────────────────────────────

export type Inline =
  | { type: 'text'; text: string }
  | { type: 'bold'; children: Inline[] }
  | { type: 'italic'; children: Inline[] }
  | { type: 'strike'; children: Inline[] }
  | { type: 'code'; text: string }
  | { type: 'link'; href: string; children: Inline[] };

const INLINE =
  /(`[^`]+`)|(\*\*[^*]+?\*\*|__[^_]+?__)|(~~[^~]+?~~)|(\*[^*\s][^*]*?\*|_[^_\s][^_]*?_)|(\[[^\]]+\]\([^)\s]+\))/;

export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let rest = src;
  while (rest) {
    const m = rest.match(INLINE);
    if (!m || m.index === undefined) {
      out.push({ type: 'text', text: rest });
      break;
    }
    if (m.index > 0) out.push({ type: 'text', text: rest.slice(0, m.index) });
    const tok = m[0];
    if (m[1]) out.push({ type: 'code', text: tok.slice(1, -1) });
    else if (m[2]) out.push({ type: 'bold', children: parseInline(tok.slice(2, -2)) });
    else if (m[3]) out.push({ type: 'strike', children: parseInline(tok.slice(2, -2)) });
    else if (m[4]) out.push({ type: 'italic', children: parseInline(tok.slice(1, -1)) });
    else if (m[5]) {
      const lm = tok.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/)!;
      out.push({ type: 'link', href: lm[2], children: parseInline(lm[1]) });
    }
    rest = rest.slice(m.index + tok.length);
  }
  return out;
}

export function plainText(src: string): string {
  const walk = (nodes: Inline[]): string =>
    nodes.map((n) => ('children' in n ? walk(n.children) : n.text)).join('');
  return walk(parseInline(src));
}

// ─── Checklists ──────────────────────────────────────────────────────────────

export function checklistProgress(src: string) {
  let done = 0;
  let total = 0;
  for (const b of parse(src)) {
    if (b.type === 'task') {
      total++;
      if (b.checked) done++;
    }
  }
  return { done, total };
}

/** Flip the task on source line `line`, touching nothing else in the file. */
export function toggleTaskAtLine(src: string, line: number): string {
  const lines = src.split('\n');
  const l = lines[line];
  if (l === undefined) return src;
  lines[line] = l.replace(/^(\s*[-*+]\s+\[)( |x|X)(\])/, (_, a, c, b) => a + (c === ' ' ? 'x' : ' ') + b);
  return lines.join('\n');
}

/** First H1 of a document, if any. */
export function firstHeading(src: string): string | null {
  const b = parse(src).find((x) => x.type === 'heading' && x.level === 1);
  return b && b.type === 'heading' ? plainText(b.text) : null;
}
