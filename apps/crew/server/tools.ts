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

const WORKSPACES = join(homedir(), '.edgerouter', 'workspaces');

/** How much of a file one read may return. Beyond this it is a budget problem. */
const MAX_READ = 64 * 1024;

export const workspaceFor = (label: string): string => {
  const room = join(WORKSPACES, label);
  mkdirSync(room, { recursive: true });
  return room;
};

/**
 * Resolves a path the agent asked for, or refuses.
 *
 * The containment check happens against the *real* path of the nearest
 * existing ancestor, because the file being written may not exist yet — and a
 * check that only works on existing paths would be no check at all for writes,
 * which are the operations that matter.
 */
const inside = async (room: string, asked: string): Promise<string> => {
  if (isAbsolute(asked)) throw new Error('paths are relative to your workspace; absolute paths are not allowed');

  const target = resolve(room, asked);

  /*
    Walk up to something that exists, resolve *that* through any symlinks, and
    check the result. Resolving the target directly would fail for a new file;
    checking the unresolved string would miss a symlinked parent.
  */
  let existing = target;
  while (!existsSync(existing) && dirname(existing) !== existing) existing = dirname(existing);

  const realRoom = await realpath(room);
  const realExisting = await realpath(existing);
  const step = relative(realRoom, realExisting);
  if (step.startsWith('..') || isAbsolute(step)) {
    throw new Error('that path is outside your workspace');
  }

  return target;
};

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
 * The tools one agent gets, bound to its own room.
 *
 * Built per agent rather than shared, so the workspace is captured here and
 * never travels as an argument the model could set.
 */
export const toolsFor = (label: string): AgentTool[] => {
  const room = workspaceFor(label);

  return [
    tool({
      name: 'list_files',
      label: 'List files',
      description:
        'List files and directories in your workspace. Use "." for the top level. Returns names with sizes.',
      parameters: Type.Object({
        path: Type.Optional(Type.String({ description: 'Directory relative to your workspace. Defaults to ".".' })),
      }),
      run: async ({ path }) => {
        const target = await inside(room, path?.trim() || '.');
        const entries = await readdir(target, { withFileTypes: true }).catch(() => null);
        if (!entries) return 'That directory does not exist.';
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
      description: 'Read a text file from your workspace.',
      parameters: Type.Object({
        path: Type.String({ description: 'File relative to your workspace.' }),
      }),
      run: async ({ path }) => {
        const target = await inside(room, path);
        const body = await readFile(target, 'utf8').catch(() => null);
        if (body === null) return 'That file does not exist.';
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

    tool({
      name: 'write_file',
      label: 'Write file',
      description:
        'Write a text file in your workspace, creating directories as needed. Replaces the file if it exists.',
      parameters: Type.Object({
        path: Type.String({ description: 'File relative to your workspace.' }),
        content: Type.String({ description: 'The full contents to write.' }),
      }),
      run: async ({ path, content }) => {
        const target = await inside(room, path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, content, 'utf8');
        return `Wrote ${content.length} characters to ${path}.`;
      },
    }),

    tool({
      name: 'search_files',
      label: 'Search files',
      description: 'Find which files in your workspace contain a piece of text. Returns matching lines.',
      parameters: Type.Object({
        query: Type.String({ description: 'Text to look for. Case-insensitive.' }),
      }),
      run: async ({ query }) => {
        const needle = query.toLowerCase();
        const hits: string[] = [];

        const walk = async (directory: string): Promise<void> => {
          for (const entry of await readdir(directory, { withFileTypes: true })) {
            const path = join(directory, entry.name);
            if (entry.isDirectory()) {
              await walk(path);
              continue;
            }
            const body = await readFile(path, 'utf8').catch(() => null);
            if (body === null) continue; // Binary, or unreadable. Not an error worth reporting.
            body.split('\n').forEach((line, index) => {
              if (hits.length < 40 && line.toLowerCase().includes(needle)) {
                hits.push(`${relative(room, path)}:${index + 1}: ${line.trim().slice(0, 200)}`);
              }
            });
          }
        };

        await walk(room);
        return hits.length > 0 ? hits.join('\n') : 'Nothing matched.';
      },
    }),
  ];
};
