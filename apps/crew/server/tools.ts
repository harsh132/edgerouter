/**
 * What an agent can do besides talk: read and write files, inside its own room.
 *
 * Until now an agent could only produce text. That makes the budget easy to
 * reason about and the agent useless for anything real — it cannot keep notes
 * between steps, cannot hand you a result, cannot build on what it did last
 * time. These four tools fix that, and each one is a step it pays for, so work
 * that takes ten calls costs ten calls.
 *
 * ## The room
 *
 * Every agent gets a directory of its own under `~/.edgerouter/workspaces/`,
 * and cannot address anything outside it. That is not a policy the model is
 * asked to respect — it is a check on every path, after resolution, before the
 * operation. A model that asks for `../../.ssh/id_rsa` gets an error, not a
 * key, and asking is not evidence of malice: a confused agent and a hostile one
 * produce the same request, so the containment cannot depend on telling them
 * apart.
 *
 * Symlinks are resolved before the check for the same reason. A path that
 * *validates* as inside the room and *resolves* to somewhere else is the whole
 * trick, and checking the string rather than the destination is how sandboxes
 * are usually escaped.
 *
 * ## What is deliberately absent
 *
 * No shell, no network, no ability to run anything. An agent here is autonomous
 * and unattended — nobody is approving its steps — and the distance between
 * "writes files in a directory" and "runs commands on your machine" is the
 * distance between a mistake and an incident. The gate is its only network, and
 * that one is metered.
 */
import { Type, type Static, type TSchema } from '@earendil-works/pi-ai';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { mkdirSync, existsSync } from 'node:fs';
import { readFile, writeFile, readdir, stat, mkdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, dirname, relative, isAbsolute } from 'node:path';
import type { Permission } from './permissions';
import { resolveIn, workspacePathFor, type ProjectMode } from './projects';
import { formatAmount, parseAmount } from '../../../packages/sdk/src/index';

const WORKSPACES = join(homedir(), '.edgerouter', 'workspaces');

/**
 * Directories a search never descends into.
 *
 * Not security — the deny-list is that — but the difference between a search
 * that answers and one that walks a hundred thousand files in `node_modules`
 * while an agent pays for the wait.
 */
const SKIP =
  /^(node_modules|\.git|\.next|dist|build|target|vendor|\.venv|__pycache__|\.cache|AppData|Windows|System32)$/i;

/** How much of a file one read may return. Beyond this it is a budget problem. */
const MAX_READ = 64 * 1024;

export const workspaceFor = (label: string): string => {
  const room = join(WORKSPACES, label);
  mkdirSync(room, { recursive: true });
  return room;
};

/**
 * Where an agent may look, in order.
 *
 * Its own workspace first, always, because a relative path with no other
 * context means "in my own room" and that has to keep working exactly as it
 * did. Granted projects follow, and a project is only in this list if the agent
 * holds `files:host` — the coarse permission and the specific grant both have
 * to be present, which is the whole point of splitting them.
 */
export type Root = { root: string; mode: ProjectMode; name: string };

/** A tool result in the shape pi wants, which is a content array. */
const said = (text: string) => ({ content: [{ type: 'text' as const, text }] });

const tool = <T extends TSchema>(
  spec: Omit<AgentTool<T>, 'execute'> & {
    run: (params: Static<T>) => Promise<string>;
  },
): AgentTool<T> => {
  const { run, ...rest } = spec;
  return {
    ...rest,
    execute: async (_id, params) => said(await run(params as Static<T>)),
  } as AgentTool<T>;
};

/**
 * The tools one agent gets, bound to its own room and its own permissions.
 *
 * Built per agent rather than shared, so the workspace is captured here and
 * never travels as an argument the model could set. `allows` comes from the
 * agent's capability rather than from the crew file — the capability is the
 * thing that was signed, and reading permissions from anywhere else would mean
 * an agent whose token says one thing and whose tools do another.
 *
 * A tool the agent may not use is *absent*, not present-and-refusing. The
 * difference is money: a model that can see `write_file` will call it, and
 * every refusal it reasons its way around is a step bought from the gate.
 * The permission is checked inside the tool as well, which is belt and braces —
 * the list is built once per run, and a later refactor rebuilding it from
 * something staler should fail closed rather than quietly grant.
 */
export type ToolContext = {
  label: string;
  allows: (permission: Permission) => boolean;
  /** Its workspace, then whatever directories it was granted. */
  roots: Root[];
  /**
   * Asks a person for more budget and waits for the answer.
   *
   * Supplied by the runtime because the tool cannot do any part of it itself:
   * the agent holds no key, cannot mint an allowance, and must not be able to.
   * All it can do is put the question somewhere a human will see it.
   */
  askForBudget: (amountMinor: bigint, reason: string) => Promise<string>;
  /** What it has left, for a tool that has to talk about money. */
  network: string;
  remainingMinor: () => bigint;
};

export const toolsFor = ({
  label,
  allows,
  roots,
  askForBudget,
  network,
  remainingMinor,
}: ToolContext): AgentTool[] => {
  const room = workspaceFor(label);

  const inside = (asked: string, need: ProjectMode) => resolveIn(roots, asked, need);

  /**
   * What the agent is told it can reach, once, in each tool description.
   *
   * Paths are given with forward slashes even on Windows, and that is not
   * cosmetic: a tool argument is JSON, a Windows path is full of backslashes,
   * and a model that does not double them produces `C:workspaceedgerouter`.
   * Observed — an agent given a backslash path reported the file did not exist,
   * which is exactly what a mangled path looks like from inside `read_file`.
   * Both forms resolve; only one of them survives being written by a model.
   */
  const reach =
    roots.length > 1
      ? ' You can also reach these, using absolute paths with forward slashes: ' +
        roots
          .slice(1)
          .map((r) => `${r.name} (${r.mode}) at ${r.root.split('\\').join('/')}`)
          .join('; ') +
        '.'
      : '';

  /*
    Refused in words, because the model has to decide what to do instead. It is
    told the refusal is final: an agent that reads "denied" as "try a different
    path" will spend its budget enumerating the ones it also cannot reach.
  */
  const needs = (permission: Permission) => {
    if (!allows(permission)) {
      throw new Error(
        `you do not have the ${permission} permission, and there is no way around it — ` +
          'say so and stop rather than trying another way',
      );
    }
  };

  const granted = (permission: Permission, made: AgentTool[]): AgentTool[] =>
    allows(permission) ? made : [];

  return [
    ...granted('files:read', [
    tool({
      name: 'list_files',
      label: 'List files',
      description:
        'List files and directories. Use "." for the top level of your own workspace.' + reach,
      parameters: Type.Object({
        path: Type.Optional(
          Type.String({
            description:
              'Relative to your workspace, or an absolute path inside a folder you have been granted. ' +
              'Defaults to ".".',
          }),
        ),
      }),
      run: async ({ path }) => {
        needs('files:read');
        const target = await inside(path?.trim() || '.', 'read');
        const entries = await readdir(target, { withFileTypes: true }).catch(() => null);
        if (!entries) return `No directory at ${target}.`;
        if (entries.length === 0) return 'Empty.';

        const lines = await Promise.all(
          entries.map(async (entry) => {
            if (entry.isDirectory()) return `${entry.name}/`;
            const info = await stat(join(target, entry.name));
            return `${entry.name}  ${info.size} bytes`;
          }),
        );
        return lines.sort().join('\n');
      },
    }),

    tool({
      name: 'read_file',
      label: 'Read file',
      description: 'Read a text file.' + reach,
      parameters: Type.Object({
        /*
          The parameter description is the one the model obeys, and it used to
          say "relative to your workspace" while the tool description offered
          granted folders. Told to read an absolute path, it stripped the prefix
          to satisfy the parameter — and the file it then looked for genuinely
          did not exist. Two descriptions that disagree is one instruction the
          model has to guess at.
        */
        path: Type.String({
          description:
            'Relative to your workspace, or an absolute path inside a folder you have been granted. ' +
            'Keep absolute paths exactly as given; do not shorten them.',
        }),
      }),
      run: async ({ path }) => {
        needs('files:read');
        const target = await inside(path, 'read');
        const body = await readFile(target, 'utf8').catch(() => null);
        /*
          Names the path it actually looked at, which is not pedantry: a model
          writing a Windows path into JSON can lose its backslashes, and
          `C:workspaceedgerouteroo` reported as "that file does not exist" is
          indistinguishable from a genuine miss. The resolved path in the
          message is what let this be diagnosed at all.
        */
        if (body === null) return `No file at ${target}.`;
        /*
          Truncated rather than refused. A model that asked for a large file
          usually wants the beginning of it, and every extra token here is paid
          for out of the same budget as the reasoning.
        */
        return body.length > MAX_READ
          ? `${body.slice(0, MAX_READ)}\n\n[truncated at ${MAX_READ} characters]`
          : body || '(the file is empty)';
      },
    }),

    ]),

    ...granted('files:write', [
    tool({
      name: 'write_file',
      label: 'Write file',
      description:
        'Write a text file, creating directories as needed. Replaces the file if it exists.' + reach,
      parameters: Type.Object({
        path: Type.String({
          description:
            'Relative to your workspace, or an absolute path inside a folder you have been granted for writing. ' +
            'Keep absolute paths exactly as given.',
        }),
        content: Type.String({ description: 'The full contents to write.' }),
      }),
      run: async ({ path, content }) => {
        needs('files:write');
        const target = await inside(path, 'write');
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, content, 'utf8');
        return `Wrote ${content.length} characters to ${path}.`;
      },
    }),

    ]),

    ...granted('files:read', [
    tool({
      name: 'search_files',
      label: 'Search files',
      description:
        'Find which files contain a piece of text. Searches your workspace and anything you have been ' +
        'granted; on a large directory this is slow and returns only the first matches.' + reach,
      parameters: Type.Object({
        query: Type.String({ description: 'Text to look for. Case-insensitive.' }),
      }),
      run: async ({ query }) => {
        needs('files:read');
        const needle = query.toLowerCase();
        const hits: string[] = [];

        const walk = async (directory: string): Promise<void> => {
          if (hits.length >= 40) return;
          /*
            A grant can be a whole drive, so this has to survive directories it
            cannot open and stop early rather than enumerate a machine. Neither
            is an error worth reporting to the model: it asked what matched, not
            which folders the operating system guards.
          */
          const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
          for (const entry of entries) {
            if (hits.length >= 40) return;
            if (SKIP.test(entry.name)) continue;
            const path = join(directory, entry.name);
            if (entry.isDirectory()) {
              await walk(path);
              continue;
            }
            /*
              Checked per file rather than trusted from the walk, so a search can
              never surface a line from a file `read_file` would refuse.
            */
            if ((await inside(path, 'read').catch(() => null)) === null) continue;
            const body = await readFile(path, 'utf8').catch(() => null);
            if (body === null) continue; // Binary, or unreadable. Not an error worth reporting.
            body.split('\n').forEach((line, index) => {
              if (hits.length < 40 && line.toLowerCase().includes(needle)) {
                hits.push(`${relative(room, path) || path}:${index + 1}: ${line.trim().slice(0, 200)}`);
              }
            });
          }
        };

        /*
          Every root, not just the workspace. A grant the agent cannot search is
          one it has to be told the shape of first, which defeats the point of
          giving it a repository.
        */
        for (const { root } of roots) {
          if (hits.length >= 40) break;
          await walk(root);
        }
        return hits.length > 0 ? hits.join('\n') : 'Nothing matched.';
      },
    }),
    ]),

    ...granted('budget:request', [
    tool({
      name: 'request_budget',
      label: 'Ask for more budget',
      description:
        'Ask the person who hired you to raise your spending limit. Use this only when a task genuinely ' +
        'needs more than you have left, and say plainly what the rest will be spent on. They may grant ' +
        'less than you ask for, or nothing. Waiting for an answer costs you nothing, but it may take ' +
        'minutes, and the answer may be no.',
      parameters: Type.Object({
        amount: Type.String({
          description: 'How much more you need, written the way the amount is shown to you, e.g. "0.2".',
        }),
        reason: Type.String({
          description: 'What the extra budget is for. One sentence. This is shown to a person, unedited.',
        }),
      }),
      run: async ({ amount, reason }) => {
        needs('budget:request');

        let amountMinor: bigint;
        try {
          amountMinor = parseAmount(network, amount);
        } catch (error) {
          return `${(error as Error).message}. Ask for a plain number, like "0.2".`;
        }
        if (amountMinor <= 0n) return 'Ask for an amount greater than zero.';

        /*
          The reason is required to be its own, not the task's. A request that
          says "I need more budget" tells the person nothing they did not
          already know from the fact of being asked.
        */
        if (reason.trim().length < 10) {
          return 'Say what the extra budget is for, in a sentence. Whoever answers needs it to decide.';
        }

        return askForBudget(amountMinor, reason.trim());
      },
    }),
    ]),
  ];
};