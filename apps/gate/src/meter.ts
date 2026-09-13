/**
 * Finding out what a call cost, from the response that answered it.
 *
 * OpenRouter reports usage on every response with no flag asked for: in the
 * body of a plain one, and in the last data event of a stream. So metering is
 * reading, not requesting — and the gate still does not need to understand
 * SSE beyond finding lines that start with `data:`.
 *
 * Incremental, because a stream is metered as it passes and a reply can be long.
 * Nothing is kept but a partial line and the most recent usage seen; the text
 * of the answer is never accumulated.
 */
import type { Usage } from './pricing';

const usageIn = (value: unknown): Usage | null => {
  if (!value || typeof value !== 'object') return null;
  const usage = (value as { usage?: unknown }).usage;
  return usage && typeof usage === 'object' ? (usage as Usage) : null;
};

/** Usage out of a non-streamed JSON body, or null when it has none. */
export const usageFromJson = (text: string): Usage | null => {
  try {
    return usageIn(JSON.parse(text));
  } catch {
    return null;
  }
};

/**
 * Reads usage out of an SSE stream, one chunk at a time.
 *
 * Chunks split wherever the network splits them, including through the middle
 * of a line, so a partial line is carried into the next push rather than
 * parsed half-formed. The last usage wins: OpenRouter sends it once, at the
 * end, and a provider that sent a running total would still end on the final
 * one.
 */
export class UsageScanner {
  private partial = '';
  private found: Usage | null = null;

  push(text: string): void {
    const lines = (this.partial + text).split('\n');
    this.partial = lines.pop() ?? '';
    for (const line of lines) this.line(line);
  }

  /** Call once the stream has ended, to read a final line with no newline after it. */
  finish(): Usage | null {
    if (this.partial) this.line(this.partial);
    this.partial = '';
    return this.found;
  }

  private line(raw: string): void {
    const line = raw.trimEnd();
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') return;
    try {
      const usage = usageIn(JSON.parse(data));
      if (usage) this.found = usage;
    } catch {
      /* a data line that is not JSON carries no usage */
    }
  }
}
