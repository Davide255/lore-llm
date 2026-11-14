/**
 * The session report: a normal markdown note in `<project>/studio/`, so
 * index.md, search and connected agents see it like any other file. It ends
 * with a ```lore-study JSON block — the machine-readable copy the app reads to
 * draw the trend and the list of saved reports (parseReport is its inverse).
 */
import type { Answer, GradeRequest, Question, SessionResult } from './types';

export const REPORT_FENCE = 'lore-study';
export const REPORT_VERSION = 1;

/** What the app needs to list a session without re-reading the questions. */
export interface ReportData {
  v: number;
  date: string;
  grade: { label: string; suffix: string; fraction: number };
  scale: SessionResult['scale'];
  headline: string;
  topics: string[];
  closedCorrect: number;
  closedTotal: number;
  openAverage: number | null;
  durationSec: number;
  preset?: string;
  criteria: { name: string; weight: number; score: number | null }[];
  questions: { id: string; type: Question['type']; topic: string; status: string; score: number }[];
  sources: string[];
}

const LETTERS = ['A', 'B', 'C', 'D'];

export function slugify(s: string): string {
  const slug = s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return slug || 'sessione';
}

export function reportPath(project: string, date: string, topics: string[]): string {
  return `${project}/studio/${date}-${slugify(topics[0] ?? 'sessione')}.md`;
}

function answerText(q: Question, a: Answer | undefined): string {
  if (!a) return '_Nessuna risposta_';
  if (q.type === 'mc') return a.choice === undefined ? '_Nessuna risposta_' : `${LETTERS[a.choice]}. ${q.options[a.choice]}`;
  if (q.type === 'tf') {
    if (a.value === undefined) return '_Nessuna risposta_';
    return `${a.value ? 'Vero' : 'Falso'}${a.motivation?.trim() ? ` — ${a.motivation.trim()}` : ''}`;
  }
  return a.text?.trim() ? a.text.trim() : '_Nessuna risposta_';
}

const STATUS: Record<string, string> = { correct: '✅', partial: '🟡', wrong: '❌', empty: '⚪' };

export function renderReport(req: GradeRequest, result: SessionResult, date: string): string {
  const byId = new Map(result.questions.map((r) => [r.questionId, r]));
  const { label, suffix } = result.grade;
  const grade = suffix.startsWith('/') ? `${label} su ${suffix.slice(1)}` : `${label}${suffix}`;
  const lines: string[] = [
    `# Sessione di studio · ${date}`,
    '',
    `**${grade}** — ${result.headline}`,
    '',
    result.subline,
    '',
    `- Argomenti: ${result.topics.join(', ') || '—'}`,
    `- Chiuse corrette: ${result.closedCorrect}/${result.closedTotal}`,
    ...(result.openAverage !== null ? [`- Media aperte: ${result.openAverage.toLocaleString('it-IT')}/10`] : []),
    `- Durata: ${Math.max(1, Math.round(result.durationSec / 60))} min`,
    ...(req.presetName ? [`- Criteri: ${req.presetName}`] : []),
    ...(req.sources.length ? [`- Appunti: ${req.sources.map((s) => `[[${s.path}]]`).join(', ')}`] : []),
  ];

  if (result.criteria.length) {
    lines.push('', '## Criteri', '');
    for (const c of result.criteria) lines.push(`- **${c.name}** · ${c.weight}% — ${c.score ?? '—'}/10${c.note ? `. ${c.note}` : ''}`);
  }
  if (req.instructions.trim()) lines.push('', '> ' + req.instructions.trim().replace(/\n/g, '\n> '));

  lines.push('', '## Domande');
  req.questions.forEach((q, i) => {
    const r = byId.get(q.id);
    lines.push('', `### ${i + 1}. ${STATUS[r?.status ?? 'empty']} ${q.prompt}`, '');
    if (q.type === 'mc') lines.push(...q.options.map((o, j) => `${LETTERS[j]}. ${o}${j === q.correctIndex ? ' ✓' : ''}`), '');
    lines.push(`**Risposta:** ${answerText(q, req.answers[q.id])}`, '');
    if (q.type === 'mc' || q.type === 'tf') lines.push(`**Soluzione:** ${q.type === 'tf' ? (q.correct ? 'Vero' : 'Falso') + '. ' : ''}${q.explanation}`, '');
    if (q.type === 'open') lines.push('**Punti attesi:**', ...q.expectedPoints.map((p) => `- ${p}`), '');
    if (r?.comment) lines.push(`**Commento:** ${r.comment}`, '');
    if (r?.criterionScores) {
      lines.push(`**Punteggio:** ${result.criteria.map((c) => `${c.name} ${r.criterionScores![c.id] ?? '—'}`).join(' · ')}`, '');
    }
    if (q.source) lines.push(`Fonte: [[${q.source.path}]]${q.source.locator ? ` · ${q.source.locator}` : ''}`, '');
  });

  const data: ReportData = {
    v: REPORT_VERSION,
    date,
    grade: { label: result.grade.label, suffix: result.grade.suffix, fraction: Math.round(result.grade.fraction * 1000) / 1000 },
    scale: result.scale,
    headline: result.headline,
    topics: result.topics,
    closedCorrect: result.closedCorrect,
    closedTotal: result.closedTotal,
    openAverage: result.openAverage,
    durationSec: result.durationSec,
    ...(req.presetName ? { preset: req.presetName } : {}),
    criteria: result.criteria.map((c) => ({ name: c.name, weight: c.weight, score: c.score })),
    questions: req.questions.map((q) => {
      const r = byId.get(q.id);
      return { id: q.id, type: q.type, topic: q.topic, status: r?.status ?? 'empty', score: r?.score ?? 0 };
    }),
    sources: req.sources.map((s) => s.path),
  };
  lines.push('', '```' + REPORT_FENCE, JSON.stringify(data), '```', '');
  return lines.join('\n');
}

/** The data block of a report, or null for any other note. */
export function parseReport(markdown: string): ReportData | null {
  const m = markdown.match(new RegExp('```' + REPORT_FENCE + '\\n([\\s\\S]*?)\\n```'));
  if (!m) return null;
  try {
    const data = JSON.parse(m[1]!) as ReportData;
    return data && data.v === REPORT_VERSION ? data : null;
  } catch {
    return null;
  }
}
