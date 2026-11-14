/**
 * POST /grade — grades a submitted session and saves the report.
 *
 * Events: `graded` per question (closed ones at once, model-graded ones as each
 * grade_answer call completes), `result`, then `saved` or `save_failed`, `done`.
 * Closed answers never reach the model. The model scores each criterion of
 * each open answer / true-false motivation and writes the verdict lines; the
 * numbers come from scoring.ts.
 */
import type { Block, MessageParam, Model } from './model';
import { renderReport, reportPath } from './report';
import { criterionResults, gradeValue, needsModel, scoreQuestion, sessionFraction, type ModelGrade } from './scoring';
import { GRADING_TOOLS, gradeInput, summaryInput } from './tools';
import { StudyError, type Emit, type GradeRequest, type Question, type QuestionResult, type SessionResult } from './types';
import type { WorkerClient } from './worker-client';

const MAX_ROUNDS = 4;

const SYSTEM = `Sei il tutor di Lore, un'app di studio. Valuti le risposte di uno studente secondo i SUOI criteri, con i pesi e il tono che ha scelto.

Regole:
- Dai a ogni criterio un intero da 0 a 10 per ogni risposta. Non calcolare medie né voti: li calcola l'app.
- Valuta ciò che è scritto, confrontandolo con i punti attesi; non premiare la lunghezza.
- Per un vero/falso valuti solo la motivazione (la correttezza della scelta la conta l'app).
- Il commento è rivolto allo studente, in seconda persona, in italiano: cosa manca o è sbagliato e dove ripassarlo.
- Le citazioni in highlights devono essere copiate parola per parola dalla risposta.
- Formule in Unicode leggibile, non LaTeX.

Procedura: una chiamata grade_answer per ogni risposta elencata, poi una sola chiamata summarize. Non scrivere altro testo.`;

export interface GradeDeps {
  model: Model;
  kb: WorkerClient;
  emit: Emit;
  /** Today in the user's time zone when the request doesn't say. */
  today: () => string;
  signal?: AbortSignal;
}

export async function grade(req: GradeRequest, deps: GradeDeps): Promise<SessionResult> {
  const { emit } = deps;
  const toModel = req.questions.filter((q) => needsModel(q, req.answers[q.id]));
  const modelGrades = new Map<string, ModelGrade>();
  const results = new Map<string, QuestionResult>();

  // Closed answers (and empty ones) are final right away.
  for (const q of req.questions) {
    if (toModel.includes(q)) continue;
    const r = scoreQuestion(q, req.answers[q.id], req.criteria);
    results.set(q.id, r);
    emit({ event: 'graded', data: r });
  }

  let summary: { headline: string; subline: string; notes: Record<string, string> } | null = null;
  if (toModel.length) summary = await gradeWithModel(req, toModel, modelGrades, results, deps);

  const ordered = req.questions.map((q) => results.get(q.id)!);
  const closed = req.questions.filter((q) => q.type !== 'open');
  const open = req.questions.filter((q) => q.type === 'open');
  const closedCorrect = closed.filter((q) => {
    const a = req.answers[q.id];
    return q.type === 'mc' ? a?.choice === q.correctIndex : q.type === 'tf' ? a?.value === q.correct : false;
  }).length;
  const openAverage = open.length
    ? Math.round((open.reduce((s, q) => s + results.get(q.id)!.score, 0) / open.length) * 100) / 10
    : null;
  const topics = [...new Set(req.questions.map((q) => q.topic).filter(Boolean))];

  const result: SessionResult = {
    grade: gradeValue(sessionFraction(ordered), req.scale),
    scale: req.scale,
    headline: summary?.headline ?? closedHeadline(closedCorrect, closed.length),
    subline: summary?.subline ?? `${closedCorrect} risposte corrette su ${closed.length}.`,
    closedCorrect,
    closedTotal: closed.length,
    openAverage,
    durationSec: req.durationSec,
    criteria: criterionResults(req.criteria, ordered, summary?.notes ?? {}),
    questions: ordered,
    topics,
  };
  emit({ event: 'result', data: result });

  const date = req.date ?? deps.today();
  try {
    const path = await deps.kb.createNote(reportPath(req.project, date, topics), renderReport(req, result, date), req.owner);
    emit({ event: 'saved', data: { path } });
  } catch (err) {
    const message = err instanceof StudyError && err.code === 'forbidden' ? 'Non hai i permessi per scrivere in questo progetto' : 'Report non salvato';
    emit({ event: 'save_failed', data: { message } });
  }
  emit({ event: 'done', data: {} });
  return result;
}

async function gradeWithModel(
  req: GradeRequest,
  toModel: Question[],
  modelGrades: Map<string, ModelGrade>,
  results: Map<string, QuestionResult>,
  deps: GradeDeps,
): Promise<{ headline: string; subline: string; notes: Record<string, string> } | null> {
  const criterionIds = new Set(req.criteria.map((c) => c.id));
  const pending = new Set(toModel.map((q) => q.id));
  let summary: { headline: string; subline: string; notes: Record<string, string> } | null = null;

  function accept(block: Block): { ok: boolean; text: string } {
    if (block.type !== 'tool_use') return { ok: true, text: '' };
    if (block.name === 'summarize') {
      const s = summaryInput.safeParse(block.input);
      if (!s.success) return { ok: false, text: `Input non valido: ${s.error.message}` };
      summary = {
        headline: s.data.headline,
        subline: s.data.subline,
        notes: Object.fromEntries(s.data.criterion_notes.filter((n) => criterionIds.has(n.criterion_id)).map((n) => [n.criterion_id, n.note])),
      };
      return { ok: true, text: 'ok' };
    }
    if (block.name !== 'grade_answer') return { ok: false, text: `Strumento sconosciuto: ${block.name}` };
    const g = gradeInput.safeParse(block.input);
    if (!g.success) return { ok: false, text: `Input non valido: ${g.error.message}` };
    const q = toModel.find((x) => x.id === g.data.question_id);
    if (!q) return { ok: false, text: `Domanda ${g.data.question_id} non è tra quelle da valutare.` };
    const scores = Object.fromEntries(g.data.scores.filter((s) => criterionIds.has(s.criterion_id)).map((s) => [s.criterion_id, s.score]));
    const missing = req.criteria.filter((c) => scores[c.id] === undefined);
    if (missing.length) return { ok: false, text: `Mancano i punteggi per: ${missing.map((c) => c.id).join(', ')}` };

    const answer = req.answers[q.id]!;
    const text = (q.type === 'open' ? answer.text : answer.motivation) ?? '';
    const grade: ModelGrade = {
      criterionScores: scores,
      comment: g.data.comment,
      // Keep only quotes that really are in the answer: the app underlines them by substring.
      highlights: g.data.highlights.filter((h) => h.quote.trim() && text.includes(h.quote)),
    };
    modelGrades.set(q.id, grade);
    const r = scoreQuestion(q, answer, req.criteria, grade);
    results.set(q.id, r);
    if (pending.delete(q.id)) deps.emit({ event: 'graded', data: r });
    return { ok: true, text: 'ok' };
  }

  const messages: MessageParam[] = [{ role: 'user', content: gradingPrompt(req, toModel, results) }];
  for (let round = 0; round < MAX_ROUNDS && (pending.size > 0 || !summary); round++) {
    const seen = new Map<string, { ok: boolean; text: string }>();
    const turn = await deps.model.turn(
      { system: SYSTEM, messages, tools: GRADING_TOOLS, maxTokens: 16000 },
      (block) => {
        if (block.type === 'tool_use') seen.set(block.id, accept(block));
      },
      deps.signal,
    );
    if (turn.stopReason === 'refusal') throw new StudyError('refusal', 'The model declined to grade these answers');
    for (const block of turn.content) if (block.type === 'tool_use' && !seen.has(block.id)) seen.set(block.id, accept(block));
    if (pending.size === 0 && summary) break;

    messages.push({ role: 'assistant', content: turn.content });
    const toolResults = turn.content
      .filter((b): b is Extract<Block, { type: 'tool_use' }> => b.type === 'tool_use')
      .map((b) => ({ type: 'tool_result' as const, tool_use_id: b.id, content: seen.get(b.id)!.text, ...(seen.get(b.id)!.ok ? {} : { is_error: true }) }));
    const left = pending.size ? `Mancano le valutazioni di: ${[...pending].join(', ')}. ` : '';
    messages.push({ role: 'user', content: [...toolResults, { type: 'text', text: `${left}${summary ? '' : 'Poi chiama summarize.'}`.trim() || 'Continua.' }] });
  }

  if (pending.size) throw new StudyError('incomplete', `Grading incomplete: ${[...pending].join(', ')}`);
  return summary;
}

function gradingPrompt(req: GradeRequest, toModel: Question[], closed: Map<string, QuestionResult>): string {
  const criteria = req.criteria.map((c) => `- ${c.id} · ${c.name} (${c.weight}%)${c.description ? `: ${c.description}` : ''}`).join('\n');
  const closedQs = req.questions.filter((q) => q.type !== 'open');
  const closedLine = closedQs.length
    ? `Domande chiuse (già corrette dall'app): ${closedQs.filter((q) => closed.get(q.id)?.status === 'correct').length}/${closedQs.length} giuste.`
    : '';
  const items = toModel
    .map((q) => {
      const a = req.answers[q.id]!;
      if (q.type === 'open') {
        return `## ${q.id} · aperta · ${q.topic}\nDomanda: ${q.prompt}\nPunti attesi:\n${q.expectedPoints.map((p) => `- ${p}`).join('\n')}\nRisposta dello studente:\n"""\n${a.text}\n"""`;
      }
      if (q.type === 'tf') {
        return `## ${q.id} · vero o falso · ${q.topic}\nAffermazione: ${q.prompt}\nCorretta: ${q.correct ? 'Vero' : 'Falso'}. ${q.explanation}\nLo studente ha risposto ${a.value ? 'Vero' : 'Falso'} con la motivazione:\n"""\n${a.motivation}\n"""`;
      }
      return '';
    })
    .join('\n\n');
  return [
    `Criteri dello studente (id · nome · peso):\n${criteria}`,
    req.instructions.trim() ? `Come vuole essere valutato:\n${req.instructions.trim()}` : '',
    `Livello: ${req.difficulty}.`,
    closedLine,
    `Risposte da valutare:\n\n${items}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

function closedHeadline(correct: number, total: number): string {
  if (total === 0) return 'Sessione completata';
  const f = correct / total;
  if (f >= 0.9) return 'Ottimo lavoro';
  if (f >= 0.7) return 'Buona preparazione';
  if (f >= 0.5) return 'Ci sei quasi';
  return 'Da ripassare';
}
