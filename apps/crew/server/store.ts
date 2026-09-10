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
import type { Project } from './projects';

const HOME = join(homedir(), '.edgerouter');
const FILE = join(HOME, 'crew.json');

/** What an agent is doing right now. Not persisted as truth — see `load`. */
export type AgentStatus = 'idle' | 'running' | 'done' | 'stopped' | 'broke' | 'revoked';

export type Step = {
  n: number;
  at: number;
  /** What the model said this step. Empty when the step only called tools. */
  text: string;
  /**
   * Tools the model asked for on this step, if any.
   *
   * A step that only calls tools produces no text, and rendering it as an empty
   * message makes a working agent look stuck. Naming what it reached for is
   * both more honest and more interesting: this is the step where it wrote the
   * file, and it cost the same as any other.
   */
  tools?: string[];
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
  /**
   * The alias: the label the name is registered under. `cto`.
   *
   * Lowercase, hyphenated, unique under the parent, and fixed once minted,
   * because it is half of an ENS name and the node the authority charges.
   */
  label: string;
  /** The full ENS name, once it exists. Absent while minting or if naming is off. */
  name?: string;
  /**
   * What a person calls it. `Chief Technical Officer`.
   *
   * Free text, and free to change: nothing is keyed on it. Absent means the
   * agent is called by its alias, which is what every agent hired before this
   * field existed is.
   */
  title?: string;
  /** The persona. Becomes the system prompt. */
  brief: string;
  /** Which model it buys from the gate. */
  model: string;
  /**
   * The agent's picture, and the banner behind it.
   *
   * A URL, an ipfs:// URI, or a data: URI — whatever the browser handed over.
   * Held here as well as on chain because chain reads are slow and this file is
   * what the roster renders from; the copy on chain is the one other people can
   * see, and the two are written together.
   */
  avatar?: string;
  header?: string;
  /** Where its name was minted, kept so revoking does not have to look it up. */
  ensParentRegistry?: string;
  ensResolver?: string;
  /**
   * What it is allowed to do, beyond spend.
   *
   * Names from `permissions.ts`. Absent means the default set — its own
   * workspace and nothing else — which is exactly what every agent hired before
   * this field existed already had, so an upgraded install changes no
   * behaviour.
   *
   * This is a record of intent, not the thing enforced. Enforcement reads the
   * capability, which is minted from this on every attach; if the two ever
   * disagree the capability wins, because it is the half that was signed.
   */
  permissions?: string[];
  /**
   * Project ids this agent may reach, and how.
   *
   * Ids rather than paths: the path belongs to the project record, so revoking
   * it there revokes it for everyone at once, and an agent's row never carries
   * a real directory anywhere it might be logged or published.
   */
  grants?: { projectId: string; mode: 'read' | 'write' }[];
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
  /**
   * Directories on this machine that agents may be given.
   *
   * Held once at crew level rather than copied into each agent, because the
   * path is the sensitive part and one place to revoke it is worth more than
   * the convenience of denormalising. An agent holds ids.
   */
  projects?: Project[];
};

const EMPTY: Crew = { version: 1, agents: [], projects: [] };

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
