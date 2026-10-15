/** Pure helpers for `<project>/checklist.md`: `- [ ] item` lines, optionally grouped under `## vX.Y.Z` sections. */
import { ToolError } from './tools';

const BOX = /^-\s\[[ x]\]\s/i;

export function parseChecklist(content: string): { text: string; checked: boolean }[] {
  return content.split('\n').flatMap((line) => {
    if (!BOX.test(line)) return [];
    return [{ text: line.replace(BOX, ''), checked: /^-\s\[x\]/i.test(line) }];
  });
}

function findSection(lines: string[], version: string): { header: number; end: number } | null {
  const header = lines.findIndex((l) => l.trim() === `## ${version}`);
  if (header === -1) return null;
  let end = lines.length;
  for (let j = header + 1; j < lines.length; j++) {
    if (lines[j]!.startsWith('## ')) {
      end = j;
      break;
    }
  }
  return { header, end };
}

function insertIntoVersion(lines: string[], version: string, line: string): void {
  const section = findSection(lines, version);
  if (!section) {
    while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop();
    lines.push('', `## ${version}`, '', line);
    return;
  }
  let last = section.header;
  for (let j = section.header + 1; j < section.end; j++) if (BOX.test(lines[j]!)) last = j;
  lines.splice(last + 1, 0, line);
}

const matches = (line: string, needle: string) => BOX.test(line) && line.replace(BOX, '').toLowerCase().includes(needle.toLowerCase());

export function addItem(content: string | null, project: string, item: string, version?: string, checked = false): string {
  const line = `${checked ? '- [x]' : '- [ ]'} ${item}`;
  const lines = content === null ? [`# ${project} — Checklist`, ''] : content.split('\n');
  if (version) insertIntoVersion(lines, version, line);
  else {
    while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop();
    lines.push(line);
  }
  return `${lines.join('\n')}\n`;
}

export function setChecked(content: string, item: string, checked: boolean): { content: string; count: number } {
  let count = 0;
  const lines = content.split('\n').map((l) => {
    if (!matches(l, item)) return l;
    count++;
    return checked ? l.replace(/^-\s\[ \]\s/, '- [x] ') : l.replace(/^-\s\[x\]\s/i, '- [ ] ');
  });
  return { content: lines.join('\n'), count };
}

export function editItem(content: string, item: string, newText: string): { content: string; count: number } {
  let count = 0;
  const lines = content.split('\n').map((l) => {
    if (!matches(l, item)) return l;
    count++;
    return `${l.match(BOX)![0]}${newText}`;
  });
  return { content: lines.join('\n'), count };
}

export function deleteItems(content: string, item: string): { content: string; count: number } {
  const lines = content.split('\n');
  const kept = lines.filter((l) => !matches(l, item));
  return { content: kept.join('\n'), count: lines.length - kept.length };
}

export function moveItems(content: string, item: string, from: string, to: string): { content: string; count: number } {
  const lines = content.split('\n');
  const section = findSection(lines, from);
  if (!section) throw new ToolError(`Version "${from}" not found in the checklist.`);
  const moved: string[] = [];
  const keep: string[] = [];
  lines.forEach((l, i) => (i > section.header && i < section.end && matches(l, item) ? moved : keep).push(l));
  if (moved.length === 0) return { content, count: 0 };
  for (const l of moved) insertIntoVersion(keep, to, l);
  return { content: keep.join('\n'), count: moved.length };
}
