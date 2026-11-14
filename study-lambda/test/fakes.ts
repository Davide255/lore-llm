import type { Block, Model, TurnRequest } from '../src/model';
import type { StudyEvent } from '../src/types';
import type { WorkerClient } from '../src/worker-client';

let n = 0;
export function toolUse(name: string, input: unknown): Block {
  return { type: 'tool_use', id: `toolu_${++n}`, name, input, caller: { type: 'direct' } } as unknown as Block;
}

/** Plays back one scripted turn per request and records what it was sent. */
export function scriptedModel(turns: { blocks: Block[]; stopReason?: string }[]): Model & { requests: TurnRequest[] } {
  const requests: TurnRequest[] = [];
  let i = 0;
  return {
    requests,
    async turn(req, onBlock) {
      requests.push(structuredClone(req));
      const t = turns[i++];
      if (!t) throw new Error('No more scripted turns');
      for (const b of t.blocks) onBlock(b);
      return { content: t.blocks, stopReason: t.stopReason ?? 'tool_use' };
    },
  };
}

export function memoryKb(files: Record<string, string | Uint8Array>, opts: { readOnly?: boolean } = {}): WorkerClient & { saved: Map<string, string> } {
  const saved = new Map<string, string>();
  return {
    saved,
    async readNote(path) {
      const f = files[path];
      if (typeof f !== 'string') throw Object.assign(new Error('nf'), { code: 'not_found' });
      return f;
    },
    async readBlob(path) {
      const f = files[path];
      if (!(f instanceof Uint8Array)) throw new Error('not found');
      return { bytes: f, contentType: 'application/octet-stream' };
    },
    async createNote(path, content) {
      if (opts.readOnly) {
        const { StudyError } = await import('../src/types');
        throw new StudyError('forbidden', 'no');
      }
      saved.set(path, content);
      return path;
    },
  };
}

export function collector(): { emit: (e: StudyEvent) => void; events: StudyEvent[]; names: () => string[] } {
  const events: StudyEvent[] = [];
  return { emit: (e) => events.push(e), events, names: () => events.map((e) => e.event) };
}

export const src = { source_path: 'Analisi/limiti.md', source_locator: 'Limiti notevoli', source_excerpt: 'lim sin x / x = 1' };
export const mc = (prompt = 'Quale serie converge?') => ({ topic: 'Serie', prompt, options: ['∑ 1/n', '∑ 1/n²', '∑ (−1)ⁿ', '∑ n/(n+1)'], correct_option: 1, explanation: 'p-serie con p = 2 > 1.', ...src });
export const tf = () => ({ topic: 'Serie', statement: 'Se aₙ → 0 allora ∑ aₙ converge.', correct: false, explanation: 'È solo necessaria.', ...src });
export const open = () => ({ topic: 'Criteri', prompt: 'Enuncia il criterio del rapporto.', expected_points: ['termini positivi', 'L < 1 converge', 'L = 1 non decide'], ...src });
