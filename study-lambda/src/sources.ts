/**
 * The notes the user picked, turned into Messages API content blocks. Claude
 * reads PDFs and images natively (handwriting and formulas included), so there
 * is no OCR step: a note is a text document, a PDF a base64 document, a photo
 * an image block preceded by its path so questions can cite it.
 */
import type Anthropic from '@anthropic-ai/sdk';
import { LIMITS, StudyError, type Emit, type SourceKind, type SourceRef } from './types';
import type { WorkerClient } from './worker-client';

type Block = Anthropic.Beta.BetaContentBlockParam;

const IMAGE_TYPES: Record<string, 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

export function sourceKind(path: string): SourceKind {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  if (ext === 'md') return 'markdown';
  if (ext === 'pdf') return 'pdf';
  if (ext in IMAGE_TYPES) return 'image';
  return 'unsupported';
}

export interface LoadedSources {
  blocks: Block[];
  /** Paths actually sent to the model (questions may only cite these). */
  paths: string[];
}

/**
 * Downloads every source through the Worker, emitting a `file` event per file,
 * and builds the content blocks. Unsupported types (SVG) are skipped with a
 * reason; a missing or forbidden file fails the whole request, since the user
 * explicitly asked for it.
 */
export async function loadSources(refs: SourceRef[], kb: WorkerClient, emit: Emit): Promise<LoadedSources> {
  if (refs.length > LIMITS.maxSources) throw new StudyError('too_large', `At most ${LIMITS.maxSources} files per session`);
  const blocks: Block[] = [];
  const paths: string[] = [];
  let total = 0;

  for (const ref of refs) {
    const kind = sourceKind(ref.path);
    if (kind === 'unsupported') {
      emit({ event: 'file', data: { path: ref.path, status: 'skipped', kind, reason: 'Formato non supportato' } });
      continue;
    }
    emit({ event: 'file', data: { path: ref.path, status: 'loading', kind } });

    if (kind === 'markdown') {
      const text = await kb.readNote(ref.path, ref.owner);
      total += new TextEncoder().encode(text).byteLength;
      checkTotal(total);
      blocks.push({ type: 'document', title: ref.path, source: { type: 'text', media_type: 'text/plain', data: text } });
      emit({ event: 'file', data: { path: ref.path, status: 'ready', kind, bytes: text.length } });
    } else {
      const { bytes } = await kb.readBlob(ref.path, ref.owner);
      total += bytes.byteLength;
      checkTotal(total);
      const data = Buffer.from(bytes).toString('base64');
      if (kind === 'pdf') {
        blocks.push({ type: 'document', title: ref.path, source: { type: 'base64', media_type: 'application/pdf', data } });
      } else {
        const ext = ref.path.slice(ref.path.lastIndexOf('.') + 1).toLowerCase();
        blocks.push({ type: 'text', text: `Foto: ${ref.path}` });
        blocks.push({ type: 'image', source: { type: 'base64', media_type: IMAGE_TYPES[ext]!, data } });
      }
      emit({ event: 'file', data: { path: ref.path, status: 'ready', kind, bytes: bytes.byteLength } });
    }
    paths.push(ref.path);
  }

  if (blocks.length === 0) throw new StudyError('invalid', 'None of the selected files can be read');
  // The sources are the stable, large prefix of every round: cache them.
  const last = blocks[blocks.length - 1]!;
  (last as { cache_control?: unknown }).cache_control = { type: 'ephemeral' };
  return { blocks, paths };
}

function checkTotal(total: number): void {
  if (total > LIMITS.maxSourceBytes) {
    throw new StudyError('too_large', `The selected files exceed ${LIMITS.maxSourceBytes / 1024 / 1024} MB`);
  }
}
