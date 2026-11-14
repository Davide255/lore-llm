/**
 * Wire contract of the study Lambda (see docs/STUDY_API.md). The mobile app
 * keeps a copy of these types in src/api/study/types.ts: change both together.
 */
import { z } from 'zod';

export const LIMITS = {
  maxSources: 12,
  /** Raw bytes across all sources; base64 adds ~33%, the API caps a request at 32 MB. */
  maxSourceBytes: 20 * 1024 * 1024,
  maxPerType: 20,
  maxQuestions: 30,
  maxCriteria: 8,
  maxInstructions: 2000,
  maxAnswerChars: 8000,
} as const;

export const DIFFICULTIES = ['ripasso', 'esame', 'orale'] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

export const SCALES = ['30', '10', 'percent', 'judgement'] as const;
export type Scale = (typeof SCALES)[number];

const ownerSchema = z
  .string()
  .regex(/^t:[A-Za-z0-9_-]{1,64}$/)
  .optional();
const pathSchema = z.string().min(3).max(512);

export const sourceRefSchema = z.object({ path: pathSchema, owner: ownerSchema });
export type SourceRef = z.infer<typeof sourceRefSchema>;

export const generateRequestSchema = z.object({
  sources: z.array(sourceRefSchema).min(1).max(LIMITS.maxSources),
  mix: z
    .object({
      mc: z.number().int().min(0).max(LIMITS.maxPerType),
      tf: z.number().int().min(0).max(LIMITS.maxPerType),
      open: z.number().int().min(0).max(LIMITS.maxPerType),
    })
    .refine((m) => m.mc + m.tf + m.open >= 1 && m.mc + m.tf + m.open <= LIMITS.maxQuestions, {
      message: `between 1 and ${LIMITS.maxQuestions} questions`,
    }),
  difficulty: z.enum(DIFFICULTIES).default('esame'),
  citeSource: z.boolean().default(true),
  /** The user's grading instructions: they also set the tone of the questions. */
  instructions: z.string().max(LIMITS.maxInstructions).default(''),
});
export type GenerateRequest = z.infer<typeof generateRequestSchema>;

export const questionSourceSchema = z.object({
  path: z.string(),
  /** Page, heading or area of the note, e.g. "p. 6" or "Condizione necessaria". */
  locator: z.string(),
  excerpt: z.string(),
});
export type QuestionSource = z.infer<typeof questionSourceSchema>;

const base = { id: z.string().min(1).max(16), topic: z.string(), prompt: z.string().min(1), source: questionSourceSchema.nullable() };

export const questionSchema = z.discriminatedUnion('type', [
  z.object({
    ...base,
    type: z.literal('mc'),
    options: z.array(z.string().min(1)).length(4),
    correctIndex: z.number().int().min(0).max(3),
    explanation: z.string(),
  }),
  z.object({ ...base, type: z.literal('tf'), correct: z.boolean(), explanation: z.string() }),
  z.object({ ...base, type: z.literal('open'), expectedPoints: z.array(z.string()).min(1) }),
]);
export type Question = z.infer<typeof questionSchema>;

export const answerSchema = z.object({
  choice: z.number().int().min(0).max(3).optional(),
  value: z.boolean().optional(),
  motivation: z.string().max(LIMITS.maxAnswerChars).optional(),
  text: z.string().max(LIMITS.maxAnswerChars).optional(),
});
export type Answer = z.infer<typeof answerSchema>;

export const criterionSchema = z.object({
  id: z.string().min(1).max(32),
  name: z.string().min(1).max(60),
  description: z.string().max(200).default(''),
  /** Percent; the weights of a session sum to 100. */
  weight: z.number().min(0).max(100),
});
export type Criterion = z.infer<typeof criterionSchema>;

export const gradeRequestSchema = z
  .object({
    /** Where the report is saved: `<project>/studio/…` in `owner`'s space. */
    project: z.string().min(1).max(64),
    owner: ownerSchema,
    questions: z.array(questionSchema).min(1).max(LIMITS.maxQuestions),
    answers: z.record(z.string(), answerSchema),
    criteria: z.array(criterionSchema).max(LIMITS.maxCriteria),
    instructions: z.string().max(LIMITS.maxInstructions).default(''),
    scale: z.enum(SCALES).default('30'),
    difficulty: z.enum(DIFFICULTIES).default('esame'),
    presetName: z.string().max(60).optional(),
    /** The user's local calendar day, for the report's name. */
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    durationSec: z.number().int().min(0).max(24 * 3600).default(0),
    sources: z.array(sourceRefSchema).max(LIMITS.maxSources).default([]),
  })
  .refine((r) => new Set(r.questions.map((q) => q.id)).size === r.questions.length, { message: 'duplicate question id' })
  .refine((r) => r.criteria.length === 0 || Math.abs(r.criteria.reduce((s, c) => s + c.weight, 0) - 100) < 0.5, {
    message: 'criteria weights must sum to 100',
  })
  .refine((r) => r.criteria.length > 0 || !r.questions.some((q) => q.type === 'open'), {
    message: 'open questions need at least one criterion',
  });
export type GradeRequest = z.infer<typeof gradeRequestSchema>;

export interface Highlight {
  quote: string;
  kind: 'good' | 'wrong';
}

/** Outcome of one question. `score` is 0…1; criterion scores are 0…10. */
export interface QuestionResult {
  questionId: string;
  status: 'correct' | 'wrong' | 'partial' | 'empty';
  score: number;
  criterionScores?: Record<string, number>;
  comment?: string;
  highlights?: Highlight[];
}

export interface GradeValue {
  /** 0…1 */
  fraction: number;
  /** Displayed value: "24", "8,5", "80", "Buono". */
  label: string;
  /** "/30", "/10", "%", or "" for a judgement. */
  suffix: string;
}

export interface CriterionResult {
  id: string;
  name: string;
  weight: number;
  /** 0…10, mean over the answers the criterion applied to; null when none did. */
  score: number | null;
  note: string;
}

export interface SessionResult {
  grade: GradeValue;
  scale: Scale;
  headline: string;
  subline: string;
  closedCorrect: number;
  closedTotal: number;
  /** 0…10, null without open questions. */
  openAverage: number | null;
  durationSec: number;
  criteria: CriterionResult[];
  questions: QuestionResult[];
  topics: string[];
}

export type StudyEvent =
  | { event: 'file'; data: { path: string; status: 'loading' | 'ready' | 'skipped'; kind: SourceKind; bytes?: number; reason?: string } }
  | { event: 'topics'; data: { topics: string[] } }
  | { event: 'question'; data: { question: Question; index: number; total: number } }
  | { event: 'graded'; data: QuestionResult }
  | { event: 'result'; data: SessionResult }
  | { event: 'saved'; data: { path: string } }
  | { event: 'save_failed'; data: { message: string } }
  | { event: 'done'; data: Record<string, unknown> }
  | { event: 'error'; data: { message: string; code: ErrorCode } };

export type SourceKind = 'markdown' | 'pdf' | 'image' | 'unsupported';

export type ErrorCode =
  | 'unauthorized'
  | 'invalid'
  | 'not_found'
  | 'forbidden'
  | 'too_large'
  | 'refusal'
  | 'incomplete'
  | 'model'
  | 'upstream'
  | 'internal';

export class StudyError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export type Emit = (e: StudyEvent) => void;
