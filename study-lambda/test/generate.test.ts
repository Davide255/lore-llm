import { describe, expect, it } from 'vitest';
import { generate } from '../src/generate';
import { generateRequestSchema } from '../src/types';
import { collector, mc, memoryKb, open, scriptedModel, tf, toolUse } from './fakes';

const kb = () =>
  memoryKb({ 'Analisi/limiti.md': '# Limiti\nlim sin x / x = 1', 'Analisi/serie.pdf': new Uint8Array([37, 80, 68, 70]), 'Analisi/logo.svg': '<svg/>' });
const req = (over: object = {}) =>
  generateRequestSchema.parse({ sources: [{ path: 'Analisi/limiti.md' }, { path: 'Analisi/serie.pdf' }], mix: { mc: 1, tf: 1, open: 1 }, ...over });

describe('generate', () => {
  it('streams files, topics and one event per question, then done', async () => {
    const model = scriptedModel([
      { blocks: [toolUse('report_topics', { topics: ['Serie', 'Limiti'] }), toolUse('add_multiple_choice', mc()), toolUse('add_true_false', tf()), toolUse('add_open_question', open())] },
    ]);
    const c = collector();
    const qs = await generate(req(), { model, kb: kb(), emit: c.emit });

    expect(c.names()).toEqual(['file', 'file', 'file', 'file', 'topics', 'question', 'question', 'question', 'done']);
    expect(qs.map((q) => [q.id, q.type])).toEqual([['q1', 'mc'], ['q2', 'tf'], ['q3', 'open']]);
    expect(qs[0]).toMatchObject({ correctIndex: 1, source: { path: 'Analisi/limiti.md' } });

    // The sources go to the model as a text document and a base64 PDF, cached.
    const content = model.requests[0]!.messages[0]!.content as { type: string; title?: string; cache_control?: unknown }[];
    expect(content.slice(0, 2).map((b) => [b.type, b.title])).toEqual([['document', 'Analisi/limiti.md'], ['document', 'Analisi/serie.pdf']]);
    expect(content[1]!.cache_control).toEqual({ type: 'ephemeral' });
    expect((content[2] as unknown as { text: string }).text).toContain('1 domanda a risposta multipla, 1 vero o falso, 1 domanda aperta');
  });

  it('rejects an invalid call, asks for the rest and ignores extras', async () => {
    const model = scriptedModel([
      { blocks: [toolUse('report_topics', { topics: ['Serie'] }), toolUse('add_multiple_choice', { ...mc(), options: ['a', 'b'] }), toolUse('add_true_false', tf()), toolUse('add_true_false', tf())] },
      { blocks: [toolUse('add_multiple_choice', mc()), toolUse('add_open_question', open())], stopReason: 'end_turn' },
    ]);
    const c = collector();
    const qs = await generate(req(), { model, kb: kb(), emit: c.emit });
    expect(qs.map((q) => q.type)).toEqual(['tf', 'mc', 'open']);

    const second = model.requests[1]!.messages;
    const results = second[2]!.content as { type: string; is_error?: boolean; content?: string; text?: string }[];
    expect(results.filter((r) => r.type === 'tool_result').map((r) => !!r.is_error)).toEqual([false, true, false, false]);
    expect(results.find((r) => r.type === 'tool_result' && r.content?.startsWith('Ignorata'))).toBeTruthy();
    expect(results.at(-1)!.text).toBe('Mancano ancora 1 domanda a risposta multipla, 1 domanda aperta. Continua.');
  });

  it('drops a cited source that was not sent, and every source when citing is off', async () => {
    const model = scriptedModel([{ blocks: [toolUse('add_multiple_choice', { ...mc(), source_path: 'Altro/x.md' })], stopReason: 'end_turn' }]);
    const qs = await generate(req({ mix: { mc: 1, tf: 0, open: 0 } }), { model, kb: kb(), emit: collector().emit });
    expect(qs[0]!.source).toBeNull();

    const model2 = scriptedModel([{ blocks: [toolUse('add_multiple_choice', mc())], stopReason: 'end_turn' }]);
    const qs2 = await generate(req({ mix: { mc: 1, tf: 0, open: 0 }, citeSource: false }), { model: model2, kb: kb(), emit: collector().emit });
    expect(qs2[0]!.source).toBeNull();
  });

  it('skips SVG files and fails when nothing readable is left', async () => {
    const c = collector();
    await expect(generate(req({ sources: [{ path: 'Analisi/logo.svg' }] }), { model: scriptedModel([]), kb: kb(), emit: c.emit })).rejects.toMatchObject({ code: 'invalid' });
    expect(c.events[0]).toMatchObject({ event: 'file', data: { status: 'skipped', kind: 'unsupported' } });
  });

  it('gives up after four rounds without the full mix', async () => {
    const empty = { blocks: [], stopReason: 'end_turn' };
    const model = scriptedModel([empty, empty, empty, empty]);
    await expect(generate(req(), { model, kb: kb(), emit: collector().emit })).rejects.toMatchObject({ code: 'incomplete' });
    expect(model.requests).toHaveLength(4);
  });

  it('surfaces a refusal', async () => {
    const model = scriptedModel([{ blocks: [], stopReason: 'refusal' }]);
    await expect(generate(req(), { model, kb: kb(), emit: collector().emit })).rejects.toMatchObject({ code: 'refusal' });
  });
});
