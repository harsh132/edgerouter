/**
 * What the page knows, and how it finds out.
 *
 * The browser holds no key and no capability — it asks the local runtime to
 * act and watches a stream to see what happened. That is the whole client:
 * five calls and one EventSource.
 */
import { useEffect, useRef, useState } from 'react';

export type Step = {
  n: number;
  at: number;
  text: string;
  /** Present when the step called tools instead of, or as well as, speaking. */
  tools?: string[];
  costMinor: string;
  ms: number;
};

export type Task = {
  id: string;
  prompt: string;
  startedAt: number;
  endedAt?: number;
  steps: Step[];
  outcome?: string;
  answer?: string;
};

export type Agent = {
  id: string;
  label: string;
  name?: string;
  brief: string;
  model: string;
  budgetMinor: string;
  spentMinor: string;
  budget: string;
  spent: string;
  account?: string;
  network: string;
  createdAt: number;
  status: 'idle' | 'running' | 'done' | 'stopped' | 'broke' | 'revoked';
  running: boolean;
  tasks: Task[];
};

export type State = {
  gate: string;
  network: string;
  account: string;
  spendable: string;
  spendableMinor: string;
  held?: string;
  naming: boolean;
  root: string;
  models: string[];
  file: string;
  agents: Agent[];
};

const post = async (path: string, body?: unknown): Promise<unknown> => {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = (await response.json()) as { error?: string };
  if (!response.ok) throw new Error(payload.error ?? `the runtime refused (${response.status})`);
  return payload;
};

export const hire = (agent: { label: string; brief: string; budgetMinor: string; model: string }) =>
  post('/api/agents', agent);

export const assign = (id: string, prompt: string) => post(`/api/agents/${id}/task`, { prompt });
export const halt = (id: string) => post(`/api/agents/${id}/stop`);
export const fire = (id: string) => post(`/api/agents/${id}/fire`);

/**
 * The live roster.
 *
 * Every change is a whole new state rather than a patch. The roster is a few
 * dozen agents; sending all of it removes an entire class of bug where the page
 * and the runtime disagree about what happened, and no user could ever perceive
 * the difference.
 */
export const useCrew = (): { state: State | null; connected: boolean; log: string[] } => {
  const [state, setState] = useState<State | null>(null);
  const [connected, setConnected] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const source = useRef<EventSource | null>(null);

  useEffect(() => {
    const events = new EventSource('/api/events');
    source.current = events;

    events.onopen = () => setConnected(true);
    events.onerror = () => setConnected(false);
    events.onmessage = (message) => {
      const event = JSON.parse(message.data) as
        | { type: 'state'; state: State }
        | { type: 'log'; text: string }
        | { type: 'step' | 'status' };

      if (event.type === 'state') {
        setState(event.state);
        setConnected(true);
      } else if (event.type === 'log') {
        /*
          Kept short on purpose. This is the line under the roster that says
          what the chain is doing right now — minting, clearing — and it is
          the only place a slow transaction is visible at all.
        */
        setLog((previous) => [...previous.slice(-4), event.text]);
      }
    };

    return () => events.close();
  }, []);

  return { state, connected, log };
};
