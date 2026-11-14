import { describe, expect, it } from 'vitest';
import { grade } from '../src/grade';
import { parseReport } from '../src/report';
import { gradeRequestSchema, type Question } from '../src/types';
import { collector, memoryKb, scriptedModel, toolUse } from './fakes';

const questions: Question[] = [
  { id: 'q1', type: 'mc', topic: 'Serie', prompt: 'Quale serie converge?', options: ['∑ 1/n', '∑ 1/n²', '∑ (−1)ⁿ', '∑ n/(n+1)'], correctIndex: 1, explanation: 'p = 2', source: { path: 'Analisi/serie.pdf', locator: 'p. 6', excerpt: '' } },
  { id: 'q2', type: 'tf', topic: 'Serie', prompt: 'Se aₙ → 0 allora converge.', correct: false, explanation: 'Solo necessaria.', source: null },
  { id: 'q3', type: 'open', topic: 'Criterio del rapporto', prompt: 'Enuncia il criterio del rapporto.', expectedPoints: ['termini positivi', 'L = 1 non decide'], source: null },
  { id: 'q4', type: 'open', topic: 'Criterio del rapporto', prompt: 'Perché L = 1 non decide?', expectedPoints: ['controesempi'], source: null },
];
const criteria = [
  { id: 'rigore', name: 'Rigore', description: 'Definizioni e ipotesi esatte', weight: 40 },
  { id: 'completezza', name: 'Completezza', description: '', weight: 30 },
  { id: 'chiarezza', name: 'Chiarezza', description: '', weight: 20 },
  { id: 'esempi', name: 'Esempi', description: '', weight: 10 },
];
const answer3 = 'Sia ∑ aₙ a termini positivi e L = lim aₙ₊₁/aₙ. Se L < 1 converge.';
const req = (over: object = {}) =>
  gradeRequestSchema.parse({
    project: 'Analisi',
    questions,
    answers: { q1: { choice: 1 }, q2: { value: false, motivation: 'La serie armonica diverge.' }, q3: { text: answer3 }, q4: { text: '' } },
    criteria,
    scale: '30',
    date: '2026-11-14',
    durationSec: 840,
    sources: [{ path: 'Analisi/serie.pdf' }],
    ...over,
  });
const scores = (r: number, c: number, ch: number, e: number) => [
  { criterion_id: 'rigore', score: r },
  { criterion_id: 'completezza', score: c },
  { criterion_id: 'chiarezza', score: ch },
  { criterion_id: 'esempi', score: e },
];

describe('grade', () => {
  it('grades closed answers locally, open ones with the model, and saves the report', async () => {
    const model = scriptedModel([
      {
        blocks: [
          toolUse('grade_answer', { question_id: 'q2', scores: scores(10, 10, 10, 10), comment: 'Perfetto.', highlights: [] }),
          toolUse('grade_answer', {
            question_id: 'q3',
            scores: scores(5, 6, 8, 9),
            comment: 'Manca la conclusione per L = 1.',
            highlights: [{ quote: 'a termini positivi', kind: 'good' }, { quote: 'non scritto', kind: 'wrong' }],
          }),
          toolUse('summarize', { headline: 'Buona base, poco rigore', subline: 'Chiuse quasi perfette.', criterion_notes: [{ criterion_id: 'rigore', note: 'Ipotesi mancanti.' }] }),
        ],
        stopReason: 'end_turn',
      },
    ]);
    const kb = memoryKb({});
    const c = collector();
    const result = await grade(req(), { model, kb, emit: c.emit, today: () => '2000-01-01' });

    expect(c.names()).toEqual(['graded', 'graded', 'graded', 'graded', 'result', 'saved', 'done']);
    // q1 1, q2 1, q3 0.63, q4 0 → 0.6575 → 20/30
    expect(result.grade).toMatchObject({ label: '20', suffix: '/30' });
    expect(result).toMatchObject({ headline: 'Buona base, poco rigore', closedCorrect: 2, closedTotal: 2, openAverage: 3.2 });
    expect(result.criteria[0]).toMatchObject({ id: 'rigore', score: 7.5, note: 'Ipotesi mancanti.' });
    const q3 = result.questions.find((q) => q.questionId === 'q3')!;
    expect(q3.highlights).toEqual([{ quote: 'a termini positivi', kind: 'good' }]); // invented quote dropped
    expect(result.questions.find((q) => q.questionId === 'q4')!.status).toBe('empty');

    // Empty and closed answers never reach the model.
    const prompt = model.requests[0]!.messages[0]!.content as string;
    expect(prompt).toContain('## q3');
    expect(prompt).not.toContain('## q4');
    expect(prompt).not.toContain('## q1');

    const [path, md] = [...kb.saved.entries()][0]!;
    expect(path).toBe('Analisi/studio/2026-11-14-serie.md');
    expect(md).toContain('**20 su 30** — Buona base, poco rigore');
    expect(parseReport(md)).toMatchObject({ date: '2026-11-14', grade: { label: '20' }, topics: ['Serie', 'Criterio del rapporto'], closedCorrect: 2 });
  });

  it('needs no model when every answer is closed', async () => {
    const model = scriptedModel([]);
    const closedOnly = req({ questions: questions.slice(0, 1), answers: { q1: { choice: 0 } }, criteria: [], scale: 'percent' });
    const c = collector();
    const result = await grade(closedOnly, { model, kb: memoryKb({}), emit: c.emit, today: () => '2026-11-14' });
    expect(model.requests).toHaveLength(0);
    expect(result).toMatchObject({ grade: { label: '0', suffix: '%' }, headline: 'Da ripassare', openAverage: null });
  });

  it('asks again for missing grades and the summary', async () => {
    const model = scriptedModel([
      { blocks: [toolUse('grade_answer', { question_id: 'q2', scores: scores(10, 10, 10, 10), comment: '', highlights: [] })], stopReason: 'end_turn' },
      {
        blocks: [
          toolUse('grade_answer', { question_id: 'q3', scores: scores(5, 5, 5, 5).slice(0, 2), comment: '', highlights: [] }),
        ],
        stopReason: 'tool_use',
      },
      {
        blocks: [
          toolUse('grade_answer', { question_id: 'q3', scores: scores(5, 5, 5, 5), comment: '', highlights: [] }),
          toolUse('summarize', { headline: 'Ok', subline: '', criterion_notes: [] }),
        ],
      },
    ]);
    const result = await grade(req(), { model, kb: memoryKb({}), emit: collector().emit, today: () => 'x' });
    expect(model.requests).toHaveLength(3);
    const retry = model.requests[2]!.messages.at(-1)!.content as { is_error?: boolean; content?: string }[];
    expect(retry[0]).toMatchObject({ is_error: true });
    expect(retry[0]!.content).toContain('chiarezza, esempi');
    expect(result.headline).toBe('Ok');
  });

  it('keeps the result when the report cannot be saved', async () => {
    const model = scriptedModel([]);
    const closedOnly = req({ questions: questions.slice(0, 1), answers: { q1: { choice: 1 } }, criteria: [] });
    const c = collector();
    await grade(closedOnly, { model, kb: memoryKb({}, { readOnly: true }), emit: c.emit, today: () => 'x' });
    expect(c.names()).toEqual(['graded', 'result', 'save_failed', 'done']);
    expect(c.events[2]).toMatchObject({ data: { message: 'Non hai i permessi per scrivere in questo progetto' } });
  });

  it('validates the request: weights, open questions without criteria, duplicate ids', () => {
    expect(() => req({ criteria: criteria.map((c) => ({ ...c, weight: 10 })) })).toThrow(/sum to 100/);
    expect(() => req({ criteria: [] })).toThrow(/at least one criterion/);
    expect(() => req({ questions: [questions[0], questions[0]] })).toThrow(/duplicate/);
  });
});
