/** Server-sent events over the Lambda response stream. */
import type { StudyEvent } from './types';

export function formatEvent(e: StudyEvent): string {
  return `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`;
}

/** A comment line: ignored by SSE parsers, keeps proxies and the app's idle timer from closing a quiet stream. */
export const HEARTBEAT = ': ping\n\n';

export interface Sink {
  write(chunk: string): void;
  end(): void;
}

export function sseWriter(sink: Sink, heartbeatMs = 15_000): { emit: (e: StudyEvent) => void; close: () => void } {
  let open = true;
  const timer = heartbeatMs > 0 ? setInterval(() => open && sink.write(HEARTBEAT), heartbeatMs) : null;
  return {
    emit(e) {
      if (open) sink.write(formatEvent(e));
    },
    close() {
      if (!open) return;
      open = false;
      if (timer) clearInterval(timer);
      sink.end();
    },
  };
}
