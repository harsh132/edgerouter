/**
 * What the crew is, on disk.
 *
 * An agent outlives the process that made it, and it has to: the ENS name was
 * minted on a real chain and the allowance was drawn from a real wallet, so a
 * crew that evaporated on restart would leave paid-for names orphaned and
 * budgets stranded in a tree nobody can reach. The file is the record of what
 * exists out there, not a cache of it.
 *
 * Deliberately not a database. The whole state is a few dozen agents and their
 * task history; a JSON file read once at boot and written on change is the
 * right size, and it can be read by a human when something looks wrong.
 */
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HOME = join(homedir(), '.edgerouter');
const FILE = join(HOME, 'crew.json');

/** What an agent is doing right now. Not persisted as truth — see `load`. */
export type AgentStatus = 'idle' | 'running' | 'done' | 'stopped' | 'broke' | 'revoked';

export type Step = {
  n: number;
  at: number;
  /** What the model said this step. */
  text: string;
  /** Smallest units paid for this step, as a string because JSON has no bigint. */
  costMinor: string;
  /** Milliseconds the call took, signing included. */
  ms: number;
};

export type Task = {
  id: string;
  prompt: string;
  startedAt: number;
  endedAt?: number;
  steps: Step[];
  /** Why it stopped, in words the UI can show without interpreting. */
  outcome?: string;
  answer?: string;
};

export type Agent = {
  id: string;
  /** What the user typed. `researcher`. */
  label: string;
  /** The full ENS name, once it exists. Absent while minting or if naming is off. */
  name?: string;
  /** The persona. Becomes the system prompt. */
  brief: string;
  /** Which model it buys from the gate. */
  model: string;
  /** Where its name was minted, kept so revoking does not have to look it up. */
  ensParentRegistry?: string;
  ensResolver?: string;
  /** Smallest units this agent may ever spend. */
  budgetMinor: string;
  /** Smallest units it has spent. */
  spentMinor: string;
  /** The capability it pays with, issued by the authority. */
  capability?: string;
  /** The address it pays from — the wallet's, which it does not control. */
  account?: string;
  network: string;
  createdAt: number;
  status: AgentStatus;
  tasks: Task[];
};

export type Crew = {
  version: 1;
  agents: Agent[];
};

const EMPTY: Crew = { version: 1, agents: [] };

/**
 * Reads the crew, forgiving anything that is not there yet.
 *
 * Running statuses are downgraded to idle on load. A process that died
 * mid-task left an agent marked `running` with nothing running it, and showing
 * that to the user would be a lie the UI then invites them to act on — a stop
 * button for a task that is not happening.
 */
export const load = (): Crew => {
  try {
    const crew = JSON.parse(readFileSync(FILE, 'utf8')) as Crew;
    for (const agent of crew.agents) {
      if (agent.status === 'running') {
        agent.status = 'idle';
        const task = agent.tasks.at(-1);
        if (task && !task.endedAt) {
          task.endedAt = Date.now();
          task.outcome = 'interrupted — the runtime restarted';
        }
      }
    }
    return crew;
  } catch {
    return structuredClone(EMPTY);
  }
};

/**
 * Writes the crew, atomically.
 *
 * Rename rather than write-in-place, because the reader is a person's whole
 * agent roster and a half-written file is an empty one. Same reason the plugin
 * does it for settings.
 */
export const save = (crew: Crew): void => {
  mkdirSync(HOME, { recursive: true });
  const temporary = `${FILE}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(crew, null, 2)}\n`, 'utf8');
  renameSync(temporary, FILE);
};

export const FILE_PATH = FILE;
