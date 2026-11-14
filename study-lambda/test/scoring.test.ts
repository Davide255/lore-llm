import { describe, expect, it } from 'vitest';
import { criterionResults, gradeValue, scoreQuestion, sessionFraction, weightedScore } from '../src/scoring';
import type { Criterion, Question } from '../src/types';

const criteria: Criterion[] = [
  { id: 'rigore', name: 'Rigore', description: '', weight: 40 },
  { id: 'completezza', name: 'Completezza', description: '', weight: 30 },
  { id: 'chiarezza', name: 'Chiarezza', description: '', weight: 20 },
  { id: 'esempi', name: 'Esempi', description: '', weight: 10 },
];
const mcQ: Question = { id: 'q1', type: 'mc', topic: 'S', prompt: 'p', options: ['a', 'b', 'c', 'd'], correctIndex: 1, explanation: '', source: null };
const tfQ: Question = { id: 'q2', type: 'tf', topic: 'S', prompt: 'p', correct: false, explanation: '', source: null };
const openQ: Question = { id: 'q3', type: 'open', topic: 'S', prompt: 'p', expectedPoints: ['x'], source: null };

describe('scoring', () => {
  it('weights the criteria (the design example: 5, 6, 8, 9 → 6.3)', () => {
    expect(weightedScore({ rigore: 5, completezza: 6, chiarezza: 8, esempi: 9 }, criteria)).toBeCloseTo(6.3);
  });

  it('scores closed answers 1/0 and empty answers 0', () => {
    expect(scoreQuestion(mcQ, { choice: 1 }, criteria).score).toBe(1);
    expect(scoreQuestion(mcQ, { choice: 0 }, criteria)).toMatchObject({ score: 0, status: 'wrong' });
    expect(scoreQuestion(mcQ, {}, criteria)).toMatchObject({ score: 0, status: 'empty' });
    expect(scoreQuestion(openQ, { text: '   ' }, criteria).status).toBe('empty');
  });

  it('counts a true/false motivation for 30%', () => {
    const perfect = { criterionScores: { rigore: 10, completezza: 10, chiarezza: 10, esempi: 10 }, comment: '', highlights: [] };
    const weak = { criterionScores: { rigore: 5, completezza: 5, chiarezza: 5, esempi: 5 }, comment: '', highlights: [] };
    expect(scoreQuestion(tfQ, { value: false, motivation: 'm' }, criteria, perfect)).toMatchObject({ score: 1, status: 'correct' });
    expect(scoreQuestion(tfQ, { value: false, motivation: 'm' }, criteria, weak)).toMatchObject({ score: 0.85, status: 'partial' });
    expect(scoreQuestion(tfQ, { value: true, motivation: 'm' }, criteria, perfect)).toMatchObject({ score: 0.3, status: 'wrong' });
  });

  it('clamps and rounds model scores', () => {
    const r = scoreQuestion(openQ, { text: 'x' }, criteria, { criterionScores: { rigore: 14, completezza: -2, chiarezza: 7.6, esempi: 9 }, comment: '', highlights: [] });
    expect(r.criterionScores).toEqual({ rigore: 10, completezza: 0, chiarezza: 8, esempi: 9 });
  });

  it('shows the grade on every scale', () => {
    expect(gradeValue(0.8, '30')).toMatchObject({ label: '24', suffix: '/30' });
    expect(gradeValue(0.85, '10')).toMatchObject({ label: '8,5', suffix: '/10' });
    expect(gradeValue(0.8, 'percent')).toMatchObject({ label: '80', suffix: '%' });
    expect(gradeValue(0.74, 'judgement')).toMatchObject({ label: 'Buono', suffix: '' });
    expect(gradeValue(0.2, 'judgement').label).toBe('Insufficiente');
  });

  it('averages each criterion only over the answers it was applied to', () => {
    const res = criterionResults(criteria, [
      { questionId: 'q1', status: 'correct', score: 1 },
      { questionId: 'q3', status: 'partial', score: 0.6, criterionScores: { rigore: 5, completezza: 6, chiarezza: 8, esempi: 9 } },
      { questionId: 'q4', status: 'partial', score: 0.6, criterionScores: { rigore: 6, completezza: 6, chiarezza: 8, esempi: 9 } },
    ], { rigore: 'Ipotesi mancanti.' });
    expect(res[0]).toMatchObject({ score: 5.5, note: 'Ipotesi mancanti.' });
    expect(criterionResults(criteria, [{ questionId: 'q1', status: 'correct', score: 1 }], {})[0]!.score).toBeNull();
  });

  it('takes the mean of the question scores', () => {
    expect(sessionFraction([{ questionId: 'a', status: 'correct', score: 1 }, { questionId: 'b', status: 'empty', score: 0 }])).toBe(0.5);
    expect(sessionFraction([])).toBe(0);
  });
});
