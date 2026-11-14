/**
 * The grade is arithmetic, done here and never by the model: the model only
 * scores each criterion of each open answer (and true/false motivations).
 *
 * - multiple choice: 1 if the chosen option is the correct one, else 0;
 * - true/false: 1/0; with a motivation, 70% the answer and 30% the motivation;
 * - open: Σ(weight · criterion score) / Σ weight / 10;
 * - empty answers: 0.
 * The session fraction is the mean over the questions, shown on the chosen scale.
 */
import type { Answer, Criterion, CriterionResult, GradeValue, Question, QuestionResult, Scale } from './types';

export const TF_ANSWER_SHARE = 0.7;

export interface ModelGrade {
  criterionScores: Record<string, number>;
  comment: string;
  highlights: { quote: string; kind: 'good' | 'wrong' }[];
}

export function isEmpty(q: Question, a: Answer | undefined): boolean {
  if (!a) return true;
  if (q.type === 'mc') return a.choice === undefined;
  if (q.type === 'tf') return a.value === undefined;
  return !a.text?.trim();
}

/** Answers the model has to grade: non-empty open answers and written true/false motivations. */
export function needsModel(q: Question, a: Answer | undefined): boolean {
  if (isEmpty(q, a)) return false;
  return q.type === 'open' || (q.type === 'tf' && !!a?.motivation?.trim());
}

/** Weighted 0…10 score of one answer over the criteria. */
export function weightedScore(scores: Record<string, number>, criteria: Criterion[]): number {
  const weight = criteria.reduce((s, c) => s + c.weight, 0);
  if (weight === 0) return 0;
  return criteria.reduce((s, c) => s + c.weight * clamp(scores[c.id] ?? 0), 0) / weight;
}

export const clamp = (n: number) => Math.min(10, Math.max(0, Math.round(n)));

export function scoreQuestion(q: Question, a: Answer | undefined, criteria: Criterion[], model?: ModelGrade): QuestionResult {
  if (isEmpty(q, a)) return { questionId: q.id, status: 'empty', score: 0 };
  const extra = model
    ? { criterionScores: Object.fromEntries(criteria.map((c) => [c.id, clamp(model.criterionScores[c.id] ?? 0)])), comment: model.comment, highlights: model.highlights }
    : {};

  if (q.type === 'mc') {
    const ok = a!.choice === q.correctIndex;
    return { questionId: q.id, status: ok ? 'correct' : 'wrong', score: ok ? 1 : 0 };
  }
  if (q.type === 'tf') {
    const ok = a!.value === q.correct;
    if (!model) return { questionId: q.id, status: ok ? 'correct' : 'wrong', score: ok ? 1 : 0 };
    const score = (ok ? TF_ANSWER_SHARE : 0) + (1 - TF_ANSWER_SHARE) * (weightedScore(model.criterionScores, criteria) / 10);
    return { questionId: q.id, status: ok ? (score >= 0.999 ? 'correct' : 'partial') : 'wrong', score: round(score), ...extra };
  }
  const score = model ? weightedScore(model.criterionScores, criteria) / 10 : 0;
  const status = score >= 0.85 ? 'correct' : score >= 0.35 ? 'partial' : 'wrong';
  return { questionId: q.id, status, score: round(score), ...extra };
}

/** Mean of each criterion over the answers it was applied to. */
export function criterionResults(criteria: Criterion[], results: QuestionResult[], notes: Record<string, string>): CriterionResult[] {
  return criteria.map((c) => {
    const values = results.map((r) => r.criterionScores?.[c.id]).filter((v): v is number => v !== undefined);
    const score = values.length ? Math.round((values.reduce((s, v) => s + v, 0) / values.length) * 10) / 10 : null;
    return { id: c.id, name: c.name, weight: c.weight, score, note: notes[c.id] ?? '' };
  });
}

const JUDGEMENTS: [number, string][] = [
  [0.9, 'Ottimo'],
  [0.8, 'Distinto'],
  [0.7, 'Buono'],
  [0.6, 'Discreto'],
  [0.5, 'Sufficiente'],
  [0, 'Insufficiente'],
];

export function gradeValue(fraction: number, scale: Scale): GradeValue {
  const f = Math.min(1, Math.max(0, fraction));
  switch (scale) {
    case '30':
      return { fraction: f, label: String(Math.round(f * 30)), suffix: '/30' };
    case '10':
      return { fraction: f, label: (Math.round(f * 100) / 10).toLocaleString('it-IT'), suffix: '/10' };
    case 'percent':
      return { fraction: f, label: String(Math.round(f * 100)), suffix: '%' };
    case 'judgement':
      return { fraction: f, label: JUDGEMENTS.find(([min]) => f >= min)![1], suffix: '' };
  }
}

export function sessionFraction(results: QuestionResult[]): number {
  if (!results.length) return 0;
  return results.reduce((s, r) => s + r.score, 0) / results.length;
}

const round = (n: number) => Math.round(n * 1000) / 1000;
