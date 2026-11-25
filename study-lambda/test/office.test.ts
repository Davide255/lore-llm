import { readFileSync } from 'node:fs';
import { strToU8, zipSync } from 'fflate';
import { afterEach, describe, expect, it } from 'vitest';
import { extractOfficeText, OFFICE_LIMITS, OfficeError, officeFormat } from '../src/office';
import { loadSources } from '../src/sources';
import type { StudyEvent } from '../src/types';
import { memoryKb } from './fakes';

// Real files: written by python-docx / python-pptx, the spreadsheet saved again by LibreOffice (cached formula values).
const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
const zip = (files: Record<string, string>) => zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])));

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const docx = (body: string) => zip({ 'word/document.xml': `<?xml version="1.0"?><w:document ${W}><w:body>${body}</w:body></w:document>` });
const para = (text: string, style = '') =>
  `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;

describe('officeFormat', () => {
  it('recognises the OOXML extensions only', () => {
    expect(officeFormat('P/a.DOCX')).toBe('docx');
    expect(officeFormat('P/b.xlsx')).toBe('xlsx');
    expect(officeFormat('P/c d.pptx')).toBe('pptx');
    for (const p of ['P/a.doc', 'P/a.xls', 'P/a.ppt', 'P/a.md', 'P/docx']) expect(officeFormat(p)).toBeNull();
  });
});

describe('extractOfficeText on real files', () => {
  it('reads a Word document: headings, lists, tables, special characters', () => {
    const text = extractOfficeText(fixture('appunti.docx'), 'docx');
    expect(text).toContain('# Termodinamica');
    expect(text).toContain('Il primo principio afferma che ΔU = Q − L & vale per sistemi chiusi.');
    expect(text).toContain('- Energia interna');
    expect(text).toContain('| Grandezza | Unità |\n| Pressione | Pa |');
    expect(text).toContain('## Secondo principio');
    expect(text).toContain("L'entropia di un sistema isolato non diminuisce.");
  });

  it('reads a spreadsheet: one section per sheet, shared strings, booleans and cached formula values', () => {
    const text = extractOfficeText(fixture('voti.xlsx'), 'xlsx');
    expect(text).toBe(
      ['## Foglio: Voti', '', 'Studente | Voto | Promosso', 'Anna | 28 | VERO', 'Luca | 17 | FALSO', ' |  |  |  | 45', '', '## Foglio: Formule', '', 'Legge dei gas | PV = nRT'].join('\n'),
    );
  });

  it('reads a presentation: slides in order with their speaker notes', () => {
    const text = extractOfficeText(fixture('lezione.pptx'), 'pptx');
    expect(text).toBe(
      [
        '## Slide 1',
        '',
        'Ciclo di Carnot',
        'Due isoterme e due adiabatiche',
        '',
        'Note del relatore:',
        'Il rendimento dipende solo dalle temperature.',
        '',
        '## Slide 2',
        '',
        'Rendimento',
        'η = 1 − Tc/Th',
      ].join('\n'),
    );
    // The slide number field of the notes page is not text of the notes.
    expect(text).not.toMatch(/Note del relatore:\n\d/);
  });
});

describe('extractOfficeText on edge cases', () => {
  afterEach(() => {
    OFFICE_LIMITS.maxPartBytes = 48 * 1024 * 1024;
    OFFICE_LIMITS.maxTotalBytes = 64 * 1024 * 1024;
  });

  it('leaves deleted revisions and field codes out of a Word document and decodes entities', () => {
    const text = extractOfficeText(
      docx(
        para('Titolo', 'Titolo1') +
          '<w:p><w:r><w:t>resta</w:t></w:r><w:del><w:r><w:delText>tolto</w:delText></w:r></w:del>' +
          '<w:r><w:instrText> PAGE </w:instrText></w:r><w:r><w:t xml:space="preserve"> &lt;a&gt; &#233;&#x00E8;</w:t></w:r></w:p>',
      ),
      'docx',
    );
    expect(text).toBe('# Titolo\n\nresta <a> éè');
  });

  it('keeps the slides in presentation order, not file order', () => {
    const slide = (t: string) => `<p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${t}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
    const text = extractOfficeText(
      zip({
        'ppt/presentation.xml': '<p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst><p:sldId id="1" r:id="rId9"/><p:sldId id="2" r:id="rId8"/></p:sldIdLst></p:presentation>',
        'ppt/_rels/presentation.xml.rels':
          '<Relationships><Relationship Id="rId8" Type="x/slide" Target="slides/slide1.xml"/><Relationship Id="rId9" Type="x/slide" Target="/ppt/slides/slide2.xml"/></Relationships>',
        'ppt/slides/slide1.xml': slide('seconda'),
        'ppt/slides/slide2.xml': slide('prima'),
      }),
      'pptx',
    );
    expect(text).toBe('## Slide 1\n\nprima\n\n## Slide 2\n\nseconda');
  });

  it('places sparse and inline-string cells in their column', () => {
    const text = extractOfficeText(
      zip({
        'xl/workbook.xml': '<workbook xmlns:r="r"><sheets><sheet name="A &amp; B" sheetId="1" r:id="rId1"/></sheets></workbook>',
        'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Type="x/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
        'xl/worksheets/sheet1.xml':
          '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>x|y</t></is></c><c r="C1"><v>3.5</v></c><c r="D1" t="e"><v>#DIV/0!</v></c></row><row r="2"><c r="B2"/></row></sheetData></worksheet>',
      }),
      'xlsx',
    );
    expect(text).toBe('## Foglio: A & B\n\nx/y |  | 3.5 | #DIV/0!');
  });

  it('rejects files that are not Office documents', () => {
    expect(() => extractOfficeText(new Uint8Array([1, 2, 3]), 'docx')).toThrow(OfficeError);
    expect(() => extractOfficeText(zip({ 'other.xml': '<a/>' }), 'docx')).toThrow(OfficeError);
    // A Word file renamed .xlsx has no workbook.
    expect(() => extractOfficeText(fixture('appunti.docx'), 'xlsx')).toThrow(OfficeError);
  });

  it('refuses to inflate parts above the size limits (zip bombs)', () => {
    OFFICE_LIMITS.maxPartBytes = 1000;
    expect(() => extractOfficeText(docx(para('a'.repeat(2000))), 'docx')).toThrow(/troppo grande/);
    OFFICE_LIMITS.maxPartBytes = 48 * 1024 * 1024;
    OFFICE_LIMITS.maxTotalBytes = 1000;
    expect(() => extractOfficeText(fixture('lezione.pptx'), 'pptx')).toThrow(/troppo grande/);
  });
});

describe('loadSources with Office files', () => {
  it('sends the extracted text as a document and skips unreadable files with a reason', async () => {
    const events: StudyEvent[] = [];
    const kb = memoryKb({
      'Fisica/lezione.pptx': fixture('lezione.pptx'),
      'Fisica/rotto.docx': new Uint8Array([80, 75, 3, 4]),
      'Fisica/vuoto.docx': docx('<w:p/>'),
    });
    const { blocks, paths } = await loadSources(
      [{ path: 'Fisica/lezione.pptx' }, { path: 'Fisica/rotto.docx' }, { path: 'Fisica/vuoto.docx' }],
      kb,
      (e) => events.push(e),
    );
    expect(paths).toEqual(['Fisica/lezione.pptx']);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: 'document', title: 'Fisica/lezione.pptx', source: { type: 'text', media_type: 'text/plain' } });
    expect((blocks[0] as { source: { data: string } }).source.data).toContain('Note del relatore:');
    const files = events.filter((e) => e.event === 'file').map((e) => e.data);
    expect(files).toEqual([
      { path: 'Fisica/lezione.pptx', status: 'loading', kind: 'office' },
      { path: 'Fisica/lezione.pptx', status: 'ready', kind: 'office', bytes: fixture('lezione.pptx').byteLength },
      { path: 'Fisica/rotto.docx', status: 'loading', kind: 'office' },
      { path: 'Fisica/rotto.docx', status: 'skipped', kind: 'office', reason: expect.stringContaining('danneggiato') },
      { path: 'Fisica/vuoto.docx', status: 'loading', kind: 'office' },
      { path: 'Fisica/vuoto.docx', status: 'skipped', kind: 'office', reason: 'Nessun testo leggibile nel file' },
    ]);
  });
});
