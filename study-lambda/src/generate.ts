/**
 * POST /generate — reads the notes and streams the questions one by one.
 *
 * Events, in order: `file` (per source: loading → ready | skipped), `topics`,
 * `question` × N, `done`. The model hands every question back through a tool
 * call; each validated call is emitted as soon as its block completes. If the
 * model stops short of the requested mix it is asked for the rest, for at
 * most MAX_ROUNDS requests.
 */
import type { Block, MessageParam, Model } from './model';
import { loadSources } from './sources';
import { GENERATION_TOOLS, mcInput, openInput, tfInput, topicsInput } from './tools';
import { StudyError, type Emit, type GenerateRequest, type Question, type QuestionSource } from './types';
import type { WorkerClient } from './worker-client';

const MAX_ROUNDS = 4;

const TONE: Record<GenerateRequest['difficulty'], string> = {
  ripasso: 'Ripasso: domande dirette su definizioni, enunciati ed esempi visti negli appunti, per consolidare.',
  esame: "Esame: il livello di uno scritto d'esame, con distrattori plausibili e qualche domanda che richiede di collegare due concetti.",
  orale: "Orale: come un docente all'orale, chiedi di enunciare con le ipotesi esatte, giustificare e dare controesempi.",
};

const SYSTEM = `Sei il tutor di Lore, un'app di studio. Prepari domande per verificare la preparazione dello studente sui SUOI appunti.

Regole:
- Ogni domanda nasce dagli appunti forniti (note markdown, PDF, foto anche scritte a mano). Non inventare argomenti assenti.
- Copri gli argomenti che compaiono più spesso, senza ripetere la stessa domanda in forme diverse.
- Scrivi in italiano. Le formule in Unicode leggibile (∑ aₙ, x², lim, →, ≤), non in LaTeX.
- Risposta multipla: 4 opzioni, una sola corretta, distrattori plausibili e di lunghezza simile; varia la posizione della corretta.
- Vero o falso: un'affermazione netta, né banale né ambigua; circa metà vere e metà false.
- Aperta: chiedi di enunciare, spiegare o dimostrare; i punti attesi sono ciò che una risposta completa deve contenere.
- Per la fonte usa esattamente il percorso indicato nel titolo del documento o nella riga "Foto: <percorso>".

Procedura: chiama prima report_topics, poi una chiamata per ogni domanda con add_multiple_choice, add_true_false o add_open_question. Non scrivere altro testo.`;

export interface GenerateDeps {
  model: Model;
  kb: WorkerClient;
  emit: Emit;
  signal?: AbortSignal;
}

type Counts = { mc: number; tf: number; open: number };

export async function generate(req: GenerateRequest, deps: GenerateDeps): Promise<Question[]> {
  const { model, kb, emit } = deps;
  const sources = await loadSources(req.sources, kb, emit);
  const wanted: Counts = { ...req.mix };
  const made: Counts = { mc: 0, tf: 0, open: 0 };
  const total = wanted.mc + wanted.tf + wanted.open;
  const questions: Question[] = [];
  let topicsSent = false;

  /** Validates one tool call and turns it into a question; returns the tool_result text. */
  function accept(block: Block): { ok: boolean; text: string } {
    if (block.type !== 'tool_use') return { ok: true, text: '' };
    const input = block.input;
    if (block.name === 'report_topics') {
      const parsed = topicsInput.safeParse(input);
      if (!parsed.success) return { ok: false, text: `Input non valido: ${parsed.error.message}` };
      if (!topicsSent) emit({ event: 'topics', data: { topics: parsed.data.topics } });
      topicsSent = true;
      return { ok: true, text: 'ok' };
    }
    const type = block.name === 'add_multiple_choice' ? 'mc' : block.name === 'add_true_false' ? 'tf' : block.name === 'add_open_question' ? 'open' : null;
    if (!type) return { ok: false, text: `Strumento sconosciuto: ${block.name}` };
    if (made[type] >= wanted[type]) return { ok: true, text: 'Ignorata: hai già raggiunto il numero richiesto per questo tipo.' };

    const question = toQuestion(type, input, `q${questions.length + 1}`, sources.paths, req.citeSource);
    if (typeof question === 'string') return { ok: false, text: `Input non valido, riprova: ${question}` };
    made[type]++;
    questions.push(question);
    emit({ event: 'question', data: { question, index: questions.length, total } });
    return { ok: true, text: 'ok' };
  }

  const messages: MessageParam[] = [
    {
      role: 'user',
      content: [
        ...sources.blocks,
        {
          type: 'text',
          text: `Prepara ${describe(wanted)}.\nTono: ${TONE[req.difficulty]}${
            req.instructions.trim() ? `\nIndicazioni dello studente su come vuole essere valutato (usale anche per il taglio delle domande):\n${req.instructions.trim()}` : ''
          }`,
        },
      ],
    },
  ];

  for (let round = 0; round < MAX_ROUNDS && questions.length < total; round++) {
    const results = new Map<string, { ok: boolean; text: string }>();
    const turn = await model.turn(
      { system: SYSTEM, messages, tools: GENERATION_TOOLS, maxTokens: 32000 },
      (block) => {
        if (block.type === 'tool_use') results.set(block.id, accept(block));
      },
      deps.signal,
    );
    if (turn.stopReason === 'refusal') throw new StudyError('refusal', 'The model declined to write questions on these notes');

    // Blocks the stream callback missed (a fake model, or a block cut by max_tokens) are handled here.
    for (const block of turn.content) if (block.type === 'tool_use' && !results.has(block.id)) results.set(block.id, accept(block));
    if (questions.length >= total) break;

    messages.push({ role: 'assistant', content: turn.content });
    const missing: Counts = { mc: wanted.mc - made.mc, tf: wanted.tf - made.tf, open: wanted.open - made.open };
    const toolResults = turn.content
      .filter((b): b is Extract<Block, { type: 'tool_use' }> => b.type === 'tool_use')
      .map((b) => ({ type: 'tool_result' as const, tool_use_id: b.id, content: results.get(b.id)!.text, ...(results.get(b.id)!.ok ? {} : { is_error: true }) }));
    messages.push({ role: 'user', content: [...toolResults, { type: 'text', text: `Mancano ancora ${describe(missing)}. Continua.` }] });
  }

  if (questions.length < total) {
    throw new StudyError('incomplete', `Only ${questions.length} of ${total} questions could be prepared`);
  }
  emit({ event: 'done', data: { count: questions.length } });
  return questions;
}

function describe(c: Counts): string {
  const parts = [
    c.mc ? `${c.mc} ${c.mc === 1 ? 'domanda' : 'domande'} a risposta multipla` : '',
    c.tf ? `${c.tf} vero o falso` : '',
    c.open ? `${c.open} ${c.open === 1 ? 'domanda aperta' : 'domande aperte'}` : '',
  ].filter(Boolean);
  return parts.join(', ');
}

/** A validated question, or the reason the input was rejected. */
export function toQuestion(type: 'mc' | 'tf' | 'open', input: unknown, id: string, paths: string[], cite: boolean): Question | string {
  const parsers = { mc: mcInput, tf: tfInput, open: openInput } as const;
  const parsed = parsers[type].safeParse(input);
  if (!parsed.success) return parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
  const d = parsed.data;
  const source: QuestionSource | null =
    cite && paths.includes(d.source_path) ? { path: d.source_path, locator: d.source_locator, excerpt: d.source_excerpt.slice(0, 300) } : null;
  if (type === 'mc') {
    const m = mcInput.parse(d);
    return { id, type, topic: m.topic, prompt: m.prompt, options: m.options, correctIndex: m.correct_option, explanation: m.explanation, source };
  }
  if (type === 'tf') {
    const t = tfInput.parse(d);
    return { id, type, topic: t.topic, prompt: t.statement, correct: t.correct, explanation: t.explanation, source };
  }
  const o = openInput.parse(d);
  return { id, type, topic: o.topic, prompt: o.prompt, expectedPoints: o.expected_points, source };
}
