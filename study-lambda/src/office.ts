/**
 * Word, Excel and PowerPoint files as plain text for the model. The Messages
 * API reads PDFs and images but not Office files, so the Lambda opens the
 * OOXML zip itself and keeps only the text, in reading order:
 *
 * - .docx: paragraphs (headings as `#`, list items as `-`), tables as rows of
 *   `a | b | c`; deleted revisions are left out.
 * - .pptx: one `## Slide N` section per slide in presentation order, then the
 *   speaker notes, which often hold the explanation the slide only hints at.
 * - .xlsx: one `## Foglio: <name>` section per sheet, one line per row with the
 *   cells separated by ` | ` (formulas as their cached value, dates as Excel
 *   serial numbers: the file does not store them as text).
 *
 * Only the XML parts that hold text are inflated, and each is capped by its
 * declared size (fflate never writes past it), so a zip bomb cannot take the
 * Lambda's memory.
 */
import { unzipSync } from 'fflate';

export type OfficeFormat = 'docx' | 'xlsx' | 'pptx';

export const OFFICE_LIMITS = {
  /** Largest single XML part inflated. */
  maxPartBytes: 48 * 1024 * 1024,
  /** All parts of one file together: about 4× in memory as JS strings, within the 1 GB Lambda; the text it yields is far above the 20 MB the request may send anyway. */
  maxTotalBytes: 64 * 1024 * 1024,
};

export class OfficeError extends Error {}

export function officeFormat(path: string): OfficeFormat | null {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  return ext === 'docx' || ext === 'xlsx' || ext === 'pptx' ? ext : null;
}

/** The text of an Office file, or throws OfficeError when it is not a readable OOXML file. */
export function extractOfficeText(bytes: Uint8Array, format: OfficeFormat): string {
  const parts = unzipParts(bytes, format);
  const text = format === 'docx' ? docxText(parts) : format === 'pptx' ? pptxText(parts) : xlsxText(parts);
  return text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ---------------------------------------------------------------------------
// Zip

type Parts = Map<string, string>;

const WANTED: Record<OfficeFormat, RegExp> = {
  docx: /^word\/(document\.xml|_rels\/document\.xml\.rels|footnotes\.xml)$/,
  pptx: /^ppt\/(presentation\.xml|_rels\/presentation\.xml\.rels|slides\/slide\d+\.xml|slides\/_rels\/slide\d+\.xml\.rels|notesSlides\/notesSlide\d+\.xml)$/,
  xlsx: /^xl\/(workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|worksheets\/sheet\d+\.xml)$/,
};

function unzipParts(bytes: Uint8Array, format: OfficeFormat): Parts {
  let total = 0;
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, {
      filter: (f) => {
        if (!WANTED[format].test(f.name)) return false;
        if (f.originalSize > OFFICE_LIMITS.maxPartBytes) throw new OfficeError('too_large');
        total += f.originalSize;
        if (total > OFFICE_LIMITS.maxTotalBytes) throw new OfficeError('too_large');
        return true;
      },
    });
  } catch (e) {
    if (e instanceof OfficeError) throw new OfficeError('Il file è troppo grande una volta decompresso');
    throw new OfficeError('Il file è danneggiato o non è un documento Office (docx, xlsx, pptx)');
  }
  const decoder = new TextDecoder();
  const parts: Parts = new Map();
  for (const [name, data] of Object.entries(files)) parts.set(name, decoder.decode(data));
  const main = { docx: 'word/document.xml', pptx: 'ppt/presentation.xml', xlsx: 'xl/workbook.xml' }[format];
  if (!parts.has(main)) throw new OfficeError('Il file è danneggiato o non è un documento Office (docx, xlsx, pptx)');
  return parts;
}

// ---------------------------------------------------------------------------
// XML

interface Tag {
  /** Qualified name, e.g. `w:p`. */
  name: string;
  kind: 'open' | 'close' | 'empty';
  attrs: string;
}
type Token = Tag | { text: string };

const TOKEN_RE = /<(\/?)([A-Za-z_][\w.:-]*)([^>]*?)(\/?)>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|([^<]+)/g;

function* tokens(xml: string): Generator<Token> {
  for (const m of xml.matchAll(TOKEN_RE)) {
    if (m[2]) yield { name: m[2], kind: m[1] ? 'close' : m[4] ? 'empty' : 'open', attrs: m[3] ?? '' };
    else if (m[5] !== undefined) yield { text: m[5] };
    else if (m[6] !== undefined) yield { text: decodeEntities(m[6]) };
  }
}

const isTag = (t: Token): t is Tag => 'name' in t;

function attr(attrs: string, name: string): string | null {
  const m = new RegExp(`(?:^|\\s)${name.replace(/[.:]/g, '\\$&')}\\s*=\\s*("([^"]*)"|'([^']*)')`).exec(attrs);
  return m ? decodeEntities(m[2] ?? m[3] ?? '') : null;
}

const NAMED: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (whole, e: string) => {
    if (e[0] !== '#') return NAMED[e.toLowerCase()] ?? whole;
    const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

/** `Id -> Target` of a `.rels` part, targets resolved against `base` (the folder of the part they belong to). */
function relationships(xml: string | undefined, base: string): Map<string, { target: string; type: string }> {
  const out = new Map<string, { target: string; type: string }>();
  if (!xml) return out;
  for (const t of tokens(xml)) {
    if (!isTag(t) || t.kind === 'close' || localName(t.name) !== 'Relationship') continue;
    const id = attr(t.attrs, 'Id');
    const target = attr(t.attrs, 'Target');
    if (id && target && attr(t.attrs, 'TargetMode') !== 'External') {
      out.set(id, { target: resolvePath(base, target), type: attr(t.attrs, 'Type') ?? '' });
    }
  }
  return out;
}

function resolvePath(base: string, target: string): string {
  const segs = target.startsWith('/') ? [] : base.split('/').filter(Boolean);
  for (const s of target.split('/')) {
    if (s === '..') segs.pop();
    else if (s && s !== '.') segs.push(s);
  }
  return segs.join('/');
}

const localName = (n: string) => n.slice(n.indexOf(':') + 1);
const numberIn = (name: string) => Number(/(\d+)\.xml$/.exec(name)?.[1] ?? 0);

// ---------------------------------------------------------------------------
// Word

function docxText(parts: Parts): string {
  const body = wordBody(parts.get('word/document.xml')!);
  const notes = wordBody(parts.get('word/footnotes.xml') ?? '');
  return notes ? `${body}\n\n## Note a piè di pagina\n\n${notes}` : body;
}

/** Paragraphs and tables of a WordprocessingML part. */
function wordBody(xml: string): string {
  const lines: string[] = [];
  let para = '';
  let prefix = '';
  let inText = false;
  let inDeleted = 0;
  let row: string[] | null = null;
  let cell: string[] | null = null;
  let tableDepth = 0;

  const endParagraph = () => {
    const text = para.trim();
    if (cell) {
      if (text) cell.push(text);
    } else if (text) {
      lines.push(prefix + text, '');
    }
    para = '';
    prefix = '';
  };

  for (const t of tokens(xml)) {
    if (!isTag(t)) {
      if (inText && !inDeleted) para += t.text;
      continue;
    }
    switch (t.name) {
      case 'w:t':
        inText = t.kind === 'open';
        break;
      case 'w:del':
        if (t.kind === 'open') inDeleted++;
        else if (t.kind === 'close') inDeleted = Math.max(0, inDeleted - 1);
        break;
      case 'w:tab':
        if (t.kind !== 'close') para += '\t';
        break;
      case 'w:br':
      case 'w:cr':
        para += cell ? ' ' : '\n';
        break;
      case 'w:pStyle': {
        const style = attr(t.attrs, 'w:val') ?? '';
        const heading = /^(?:heading|titolo|berschrift|titre|ttulo)\s*(\d)$/i.exec(style);
        if (heading) prefix = `${'#'.repeat(Math.min(6, Number(heading[1])))} `;
        else if (/^(?:title|titolo)$/i.test(style)) prefix = '# ';
        else if (/list|elenco/i.test(style) && !prefix) prefix = '- ';
        break;
      }
      case 'w:numPr':
        if (t.kind !== 'close' && !prefix) prefix = '- ';
        break;
      case 'w:p':
        // On open too: a paragraph inside a text box starts before its outer one ends, keep the outer text so far.
        endParagraph();
        break;
      case 'w:tbl':
        if (t.kind === 'open') tableDepth++;
        else if (t.kind === 'close') {
          tableDepth--;
          if (tableDepth === 0) lines.push('');
        }
        break;
      case 'w:tr':
        // Nested tables are flattened into the cell of the outer one.
        if (tableDepth > 1) break;
        if (t.kind === 'open') row = [];
        else if (t.kind === 'close' && row) {
          if (row.some(Boolean)) lines.push(`| ${row.join(' | ')} |`);
          row = null;
        }
        break;
      case 'w:tc':
        if (tableDepth > 1) break;
        if (t.kind === 'open') cell = [];
        else if (t.kind === 'close' && cell) {
          row?.push(cell.join(' ').replace(/\|/g, '/'));
          cell = null;
        }
        break;
    }
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// PowerPoint

function pptxText(parts: Parts): string {
  const rels = relationships(parts.get('ppt/_rels/presentation.xml.rels'), 'ppt');
  const ordered: string[] = [];
  for (const t of tokens(parts.get('ppt/presentation.xml')!)) {
    if (isTag(t) && t.kind !== 'close' && t.name === 'p:sldId') {
      const target = rels.get(attr(t.attrs, 'r:id') ?? '')?.target;
      if (target && parts.has(target) && !ordered.includes(target)) ordered.push(target);
    }
  }
  // Without a usable slide list, fall back to the file numbers.
  if (ordered.length === 0) {
    ordered.push(...[...parts.keys()].filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k)).sort((a, b) => numberIn(a) - numberIn(b)));
  }

  const sections: string[] = [];
  ordered.forEach((slide, i) => {
    const text = drawingText(parts.get(slide)!);
    const slideRels = relationships(parts.get(slide.replace(/slides\/(slide\d+\.xml)$/, 'slides/_rels/$1.rels')), 'ppt/slides');
    const notesPart = [...slideRels.values()].find((r) => r.type.endsWith('/notesSlide'))?.target;
    const notes = notesPart ? drawingText(parts.get(notesPart) ?? '') : '';
    let section = `## Slide ${i + 1}\n\n${text || '(nessun testo)'}`;
    if (notes) section += `\n\nNote del relatore:\n${notes}`;
    sections.push(section);
  });
  return sections.join('\n\n');
}

/** Paragraphs of DrawingML text (slides and notes). Field values (slide numbers, dates) are skipped. */
function drawingText(xml: string): string {
  const lines: string[] = [];
  let para = '';
  let inText = false;
  let inField = false;
  for (const t of tokens(xml)) {
    if (!isTag(t)) {
      if (inText && !inField) para += t.text;
      continue;
    }
    if (t.name === 'a:t') inText = t.kind === 'open';
    else if (t.name === 'a:fld') inField = t.kind === 'open';
    else if (t.name === 'a:br') para += '\n';
    else if (t.name === 'a:p' && t.kind !== 'open') {
      if (para.trim()) lines.push(para.trim());
      para = '';
    }
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Excel

function xlsxText(parts: Parts): string {
  const shared = sharedStrings(parts.get('xl/sharedStrings.xml'));
  const rels = relationships(parts.get('xl/_rels/workbook.xml.rels'), 'xl');
  const sheets: { name: string; part: string }[] = [];
  for (const t of tokens(parts.get('xl/workbook.xml')!)) {
    if (isTag(t) && t.kind !== 'close' && localName(t.name) === 'sheet') {
      const target = rels.get(attr(t.attrs, 'r:id') ?? '')?.target;
      if (target && parts.has(target)) sheets.push({ name: attr(t.attrs, 'name') ?? target, part: target });
    }
  }
  if (sheets.length === 0) {
    for (const k of [...parts.keys()].filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k)).sort((a, b) => numberIn(a) - numberIn(b))) {
      sheets.push({ name: `Foglio ${numberIn(k)}`, part: k });
    }
  }

  return sheets
    .map(({ name, part }) => {
      const rows = sheetRows(parts.get(part)!, shared);
      return `## Foglio: ${name}\n\n${rows.length ? rows.join('\n') : '(vuoto)'}`;
    })
    .join('\n\n');
}

function sharedStrings(xml: string | undefined): string[] {
  const out: string[] = [];
  if (!xml) return out;
  let current: string | null = null;
  let inText = false;
  let inPhonetic = false;
  for (const t of tokens(xml)) {
    if (!isTag(t)) {
      if (inText && !inPhonetic && current !== null) current += t.text;
      continue;
    }
    if (t.name === 'si' || t.name.endsWith(':si')) {
      if (t.kind === 'open') current = '';
      else if (t.kind === 'close') {
        out.push(current ?? '');
        current = null;
      } else out.push('');
    } else if (localName(t.name) === 't') inText = t.kind === 'open';
    else if (localName(t.name) === 'rPh') inPhonetic = t.kind === 'open';
  }
  return out;
}

/** Column index (0-based) of a cell reference like `C12`. */
function columnOf(ref: string | null): number | null {
  const letters = ref ? /^([A-Z]+)\d*$/i.exec(ref)?.[1] : undefined;
  if (!letters) return null;
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function sheetRows(xml: string, shared: string[]): string[] {
  const rows: string[] = [];
  let row: string[] | null = null;
  let cellType = '';
  let col = 0;
  let value = '';
  let inValue = false;
  let inInline = false;

  for (const t of tokens(xml)) {
    if (!isTag(t)) {
      if (inValue || inInline) value += t.text;
      continue;
    }
    const name = localName(t.name);
    if (name === 'row') {
      if (t.kind === 'open') row = [];
      else if (row) {
        while (row.length && !row[row.length - 1]) row.pop();
        if (row.length) rows.push(row.join(' | '));
        row = null;
      }
    } else if (name === 'c') {
      if (t.kind === 'close' || t.kind === 'empty') {
        if (t.kind === 'close' && row) {
          let text = value;
          if (cellType === 's') text = shared[Number(value)] ?? '';
          else if (cellType === 'b') text = value === '1' ? 'VERO' : 'FALSO';
          text = text.replace(/\s*\n\s*/g, ' ').replace(/\|/g, '/').trim();
          while (row.length < col) row.push('');
          row[col] = text;
        }
        if (t.kind === 'empty' && row) col = (columnOf(attr(t.attrs, 'r')) ?? row.length) + 1;
        else col++;
      } else {
        cellType = attr(t.attrs, 't') ?? 'n';
        col = columnOf(attr(t.attrs, 'r')) ?? row?.length ?? col;
        value = '';
      }
    } else if (name === 'v') inValue = t.kind === 'open';
    else if (name === 't') inInline = t.kind === 'open' && cellType === 'inlineStr';
  }
  return rows;
}
