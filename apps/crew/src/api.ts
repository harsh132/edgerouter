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
  /** The ENS label. `cto`. Fixed. */
  label: string;
  /** The full ENS name, once minted. */
  name?: string;
  /** The display name. `Chief Technical Officer`. Absent means use the alias. */
  title?: string;
  brief: string;
  model: string;
  budgetMinor: string;
  spentMinor: string;
  budget: string;
  spent: string;
  /** What it may do, beyond spend. Always sent, defaults resolved by the runtime. */
  permissions: string[];
  /** Directories it may reach. Empty unless it also holds files:host. */
  grants: Grant[];
  /** Its picture and banner. Also written to ENS, where others can see them. */
  avatar?: string;
  header?: string;
  account?: string;
  network: string;
  createdAt: number;
  status: 'idle' | 'running' | 'done' | 'stopped' | 'broke' | 'revoked';
  running: boolean;
  tasks: Task[];
};

/** A directory on this machine that agents can be given. */
export type Project = {
  id: string;
  name: string;
  path: string;
  mode: 'read' | 'write';
  createdAt: number;
};

export type Grant = { projectId: string; mode: 'read' | 'write' };

/** An agent asking for more budget, waiting for a person. */
export type BudgetRequest = {
  id: string;
  agentId: string;
  askedMinor: string;
  asked: string;
  reason: string;
  at: number;
};

/** One permission the runtime enforces, as it describes itself. */
export type PermissionInfo = { name: string; label: string; detail: string; default: boolean };

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
  permissions: PermissionInfo[];
  file: string;
  requests: BudgetRequest[];
  projects: Project[];
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

export const hire = (agent: {
  label: string;
  title?: string;
  permissions?: string[];
  grants?: Grant[];
  brief: string;
  budgetMinor: string;
  model: string;
  avatar?: string;
  header?: string;
}) => post('/api/agents', agent);

export const assign = (id: string, prompt: string) => post(`/api/agents/${id}/task`, { prompt });

/**
 * Changes an agent that already exists.
 *
 * Only the fields passed are touched — each one that reaches the chain is a
 * transaction, so sending the whole agent back would charge for rewriting
 * records that did not change.
 */
export const edit = (
  id: string,
  changes: {
    title?: string;
    permissions?: string[];
    grants?: Grant[];
    brief?: string;
    model?: string;
    budgetMinor?: string;
    avatar?: string;
    header?: string;
  },
) => post(`/api/agents/${id}/edit`, changes);
/**
 * Answers a request for more budget.
 *
 * The amount is sent rather than implied, because approving is not agreeing —
 * a person may grant a tenth of what was asked, and the number they typed is
 * the limit rather than the one the agent proposed.
 */
/**
 * Grants a directory to the crew.
 *
 * The path is typed rather than picked, because a browser file picker hands
 * back a file, not the directory path the runtime needs — and a path the user
 * wrote is one they can see before they commit to it.
 */
export const addProject = (project: { name: string; path: string; mode: 'read' | 'write' }) =>
  post('/api/projects', project);

export const removeProject = async (id: string): Promise<void> => {
  const response = await fetch(`/api/projects/${id}`, { method: 'DELETE' });
  if (!response.ok) throw new Error('the runtime refused to remove it');
};

export const approve = (id: string, grantedMinor: string) =>
  post(`/api/requests/${id}/approve`, { grantedMinor });
export const decline = (id: string) => post(`/api/requests/${id}/decline`);

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
        | { type: 'delta'; agentId: string; n: number; text: string }
        | { type: 'step' | 'status' };

      if (event.type === 'state') {
        setState(event.state);
        setConnected(true);
      } else if (event.type === 'delta') {
        /*
          Patched in place rather than answered with a fresh state.

          A delta arrives for every chunk the model produces, and rebuilding the
          whole roster that often would send the entire crew — every agent,
          every task, every step — down the wire several times a second to
          change one string. The step being written already exists here; it is
          found by agent and step number, because those are stable and array
          positions are not.
        */
        setState((previous) => {
          if (!previous) return previous;
          return {
            ...previous,
            agents: previous.agents.map((agent) => {
              if (agent.id !== event.agentId) return agent;
              const tasks = [...agent.tasks];
              const last = tasks.length - 1;
              const task = tasks[last];
              if (!task) return agent;
              tasks[last] = {
                ...task,
                steps: task.steps.map((step) => (step.n === event.n ? { ...step, text: event.text } : step)),
              };
              return { ...agent, tasks };
            }),
          };
        });
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
