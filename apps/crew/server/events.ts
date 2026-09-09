/**
 * One broadcast channel, so the browser sees what the runtime is doing.
 *
 * An agent working is only interesting live. A roster that updates when you
 * reload is a database viewer; a roster where a step appears and the spend
 * ticks up while you watch is the thing being demonstrated — that inference is
 * being bought, one call at a time, against a limit.
 *
 * Server-sent events rather than WebSockets: every message goes one way, from
 * runtime to browser, and SSE reconnects on its own.
 */
export type CrewEvent =
  | { type: 'crew'; agents: unknown[] }
  | { type: 'step'; agentId: string; step: unknown; spentMinor: string }
  | { type: 'status'; agentId: string; status: string; detail?: string }
  | { type: 'log'; text: string };

type Listener = (event: CrewEvent) => void;

const listeners = new Set<Listener>();

export const subscribe = (listener: Listener): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const emit = (event: CrewEvent): void => {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      /*
        A browser that went away mid-write must not take the runtime with it.
        The agent's work is the valuable thing here; the stream is a view of it.
      */
    }
  }
};
