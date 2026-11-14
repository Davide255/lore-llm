/**
 * Tools the model calls to hand back structured data, one call per question or
 * per graded answer, so each one can be streamed to the app as soon as it is
 * complete. `strict: true` makes the API enforce the JSON schema; zod checks
 * what the schema can't say (4 options, 0…10 scores) before anything is used.
 */
import { z } from 'zod';
import type { Tool } from './model';

const str = (description: string) => ({ type: 'string', description }) as const;
const source = {
  source_path: str('Path of the note the question comes from, exactly as in the document title or "Foto: <path>" line.'),
  source_locator: str('Where in that note: "p. 6", a heading, or an area of the photo. Empty if unknown.'),
  source_excerpt: str('A short verbatim excerpt (max ~200 characters) the question is based on.'),
};

function tool(name: string, description: string, properties: Record<string, unknown>): Tool {
  return {
    name,
    description,
    strict: true,
    input_schema: { type: 'object', properties, required: Object.keys(properties), additionalProperties: false },
  };
}

export const GENERATION_TOOLS: Tool[] = [
  tool('report_topics', 'Call once, first: the 2-6 topics of the notes the questions will cover, most frequent first.', {
    topics: { type: 'array', items: { type: 'string' } },
  }),
  tool('add_multiple_choice', 'Add one multiple-choice question with exactly 4 options and exactly one correct.', {
    topic: str('One of the reported topics.'),
    prompt: str('The question.'),
    options: { type: 'array', items: { type: 'string' }, description: 'Exactly 4 options, without letters.' },
    correct_option: { type: 'integer', description: 'Index 0-3 of the correct option.' },
    explanation: str('One or two sentences on why the correct option is correct.'),
    ...source,
  }),
  tool('add_true_false', 'Add one true/false statement.', {
    topic: str('One of the reported topics.'),
    statement: str('A statement that is either true or false according to the notes.'),
    correct: { type: 'boolean', description: 'Whether the statement is true.' },
    explanation: str('Why, in one or two sentences: what a good motivation would say.'),
    ...source,
  }),
  tool('add_open_question', 'Add one open-answer question.', {
    topic: str('One of the reported topics.'),
    prompt: str('The question.'),
    expected_points: {
      type: 'array',
      items: { type: 'string' },
      description: '2-6 points a complete answer must contain, used later for grading.',
    },
    ...source,
  }),
];

const sourceShape = { source_path: z.string(), source_locator: z.string(), source_excerpt: z.string() };

export const topicsInput = z.object({ topics: z.array(z.string().min(1)).min(1).max(8) });
export const mcInput = z.object({
  topic: z.string(),
  prompt: z.string().min(1),
  options: z.array(z.string().min(1)).length(4),
  correct_option: z.number().int().min(0).max(3),
  explanation: z.string(),
  ...sourceShape,
});
export const tfInput = z.object({
  topic: z.string(),
  statement: z.string().min(1),
  correct: z.boolean(),
  explanation: z.string(),
  ...sourceShape,
});
export const openInput = z.object({
  topic: z.string(),
  prompt: z.string().min(1),
  expected_points: z.array(z.string().min(1)).min(1).max(8),
  ...sourceShape,
});

export const GRADING_TOOLS: Tool[] = [
  tool('grade_answer', 'Grade one answer (an open answer, or the motivation of a true/false answer). Call once per answer.', {
    question_id: str('The id of the question, e.g. "q9".'),
    scores: {
      type: 'array',
      description: 'One entry per criterion, integer score 0-10.',
      items: {
        type: 'object',
        properties: { criterion_id: { type: 'string' }, score: { type: 'integer' } },
        required: ['criterion_id', 'score'],
        additionalProperties: false,
      },
    },
    comment: str('2-4 sentences to the student, second person, citing what is missing and pointing to the source.'),
    highlights: {
      type: 'array',
      description: 'Up to 6 verbatim quotes from the answer: what earned points (good), what is wrong (wrong).',
      items: {
        type: 'object',
        properties: { quote: { type: 'string' }, kind: { type: 'string', enum: ['good', 'wrong'] } },
        required: ['quote', 'kind'],
        additionalProperties: false,
      },
    },
  }),
  tool('summarize', 'Call once, after every grade_answer: the overall verdict of the session.', {
    headline: str('3-6 words, e.g. "Buona base, poco rigore".'),
    subline: str('One sentence on closed vs open answers.'),
    criterion_notes: {
      type: 'array',
      description: 'One line per criterion on how the session went for it.',
      items: {
        type: 'object',
        properties: { criterion_id: { type: 'string' }, note: { type: 'string' } },
        required: ['criterion_id', 'note'],
        additionalProperties: false,
      },
    },
  }),
];

export const gradeInput = z.object({
  question_id: z.string(),
  scores: z.array(z.object({ criterion_id: z.string(), score: z.number() })),
  comment: z.string(),
  highlights: z.array(z.object({ quote: z.string(), kind: z.enum(['good', 'wrong']) })).max(12),
});
export const summaryInput = z.object({
  headline: z.string().min(1),
  subline: z.string(),
  criterion_notes: z.array(z.object({ criterion_id: z.string(), note: z.string() })),
});
