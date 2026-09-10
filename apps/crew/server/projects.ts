/**
 * Real directories on the machine, handed to agents deliberately.
 *
 * Until now an agent could reach one directory — its own, under
 * `~/.edgerouter/workspaces` — and nothing else. That is safe and nearly
 * useless: the work people actually want done is on a repo that already exists
 * somewhere, and an agent that cannot see it can only be told about it.
 *
 * A *project* is a grant of a real path. It has an opaque id, a mode, and a
 * name a person chose. The path lives here, in the runtime, and never anywhere
 * else — the capability carries `project:prj_7f3a:write`, which says nothing
 * about what is on the disk, and the chain carries only `files:host`, which
 * says an agent may touch the machine at all and never which part of it.
 *
 * ## What is refused inside every grant
 *
 * A grant of `C:\` is a grant of `C:\`, and the point of this file is not to
 * second-guess that. But some paths are refused inside *any* root, because
 * handing them over is never what someone meant by "let it work on my files":
 *
 *   - the wallet store and crew file, which hold the keys paying for the agent
 *     and the record of every allowance. An agent that can rewrite these is not
 *     operating under a budget any more.
 *   - private keys and credentials by their conventional names.
 *   - `.git` internals, for writes. File edits are recoverable from history; a
 *     rewritten object store is not.
 *
 * The agent's own workspace is carved back out of the first of these, because
 * it lives under the same directory and is the one part it must be able to
 * write.
 *
 * This list is a floor, not a security boundary. An agent granted write over
 * the directory holding this source can edit the list; that is a real
 * consequence of granting it, not an oversight of this file.
 */
import { existsSync, statSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';

const HOME = homedir();
const RUNTIME_HOME = join(HOME, '.edgerouter');
const WORKSPACES = join(RUNTIME_HOME, 'workspaces');

export type ProjectMode = 'read' | 'write';

export type Project = {
  /** Opaque, and opaque on purpose: it is what travels in a capability. */
  id: string;
  /** What a person calls it. Shown in the UI, never published. */
  name: string;
  /** The real path, resolved through symlinks when it was granted. */
  path: string;
  mode: ProjectMode;
  createdAt: number;
};

export const newProjectId = (): string => `prj_${randomUUID().replace(/-/g, '').slice(0, 8)}`;

/**
 * Paths no agent may touch, whatever it was granted.
 *
 * Matched against the resolved path, case-insensitively, because Windows will
 * happily open `C:\Users\me\.SSH\id_rsa` and a case-sensitive list would let it
 * through on the one platform this runs on most.
 */
const FORBIDDEN = [
  /*
    The runtime's own state: wallet keys, the crew file, the delegation record.
    Everything an agent's budget is enforced by lives here.
  */
  { test: (path: string) => within(RUNTIME_HOME, path) && !within(WORKSPACES, path), why: 'the runtime keeps its wallet and its records there' },
  { test: (path: string) => /(^|[\\/])\.env(\.|$)|(^|[\\/])\.env$/i.test(path), why: 'that is where secrets are kept' },
  { test: (path: string) => /(^|[\\/])\.ssh([\\/]|$)/i.test(path), why: 'those are ssh keys' },
  { test: (path: string) => /(^|[\\/])\.aws([\\/]|$)/i.test(path), why: 'those are cloud credentials' },
  { test: (path: string) => /(^|[\\/])\.gnupg([\\/]|$)/i.test(path), why: 'those are gpg keys' },
  { test: (path: string) => /(^|[\\/])id_(rsa|ed25519|ecdsa)/i.test(path), why: 'that is a private key' },
  { test: (path: string) => /\.(pem|key|pfx|p12|keystore)$/i.test(path), why: 'that is a private key' },
  { test: (path: string) => /(^|[\\/])credentials?(\.|$)/i.test(path), why: 'that is a credentials file' },
];

/** Paths readable but never writable. */
const READ_ONLY = [
  { test: (path: string) => /(^|[\\/])\.git([\\/]|$)/i.test(path), why: 'rewriting git internals cannot be undone' },
];

/** Whether `path` is inside `root`, or is `root`. String comparison only. */
const within = (root: string, path: string): boolean => {
  const step = relative(root, path);
  return step === '' || (!step.startsWith('..') && !isAbsolute(step));
};

export type Grant = { project: Project; mode: ProjectMode };

/**
 * Turns a path an agent asked for into a real one, or explains the refusal.
 *
 * The containment check runs against the *real* path of the nearest existing
 * ancestor, for the same reason it always has: the file being written may not
 * exist yet, so resolving the target itself would fail for exactly the
 * operation that matters most. Walking up and resolving that catches a
 * symlinked parent pointing out of the grant — which matters far more once a
 * root is somebody's actual repository.
 */
export const resolveIn = async (
  roots: { root: string; mode: ProjectMode; name: string }[],
  asked: string,
  need: ProjectMode,
): Promise<string> => {
  if (roots.length === 0) throw new Error('you have not been given access to any files');

  /*
    Absolute paths are allowed now, and have to be: a grant of a real directory
    is useless if the only way to name a file in it is relative to somewhere
    else. Relative paths still resolve against the first root, which is always
    the agent's own workspace.
  */
  const target = isAbsolute(asked) ? resolve(asked) : resolve(roots[0]!.root, asked);

  let existing = target;
  while (!existsSync(existing)) {
    const up = resolve(existing, '..');
    if (up === existing) break;
    existing = up;
  }
  const real = existsSync(existing) ? await realpath(existing) : existing;
  const realTarget = existing === target ? real : join(real, relative(existing, target));

  const grant = roots.find((candidate) => within(candidate.root, realTarget));
  if (!grant) {
    throw new Error(`${asked} is outside everything you have been given access to`);
  }
  if (need === 'write' && grant.mode !== 'write') {
    throw new Error(`you have read-only access to ${grant.name}`);
  }

  for (const rule of FORBIDDEN) {
    if (rule.test(realTarget)) throw new Error(`${asked} is off limits — ${rule.why}`);
  }
  if (need === 'write') {
    for (const rule of READ_ONLY) {
      if (rule.test(realTarget)) throw new Error(`${asked} cannot be written — ${rule.why}`);
    }
  }

  return realTarget;
};

/**
 * Checks a path a person is about to grant.
 *
 * Refuses what cannot be granted rather than what should not be. A directory
 * that does not exist is a typo; everything else is the user's call, including
 * a drive root, because "let it work on my machine" is a thing people mean.
 */
export const describeGrant = (path: string): { path: string; warning?: string } => {
  const resolved = resolve(path.trim());
  if (!existsSync(resolved)) throw new Error(`${resolved} does not exist`);
  if (!statSync(resolved).isDirectory()) throw new Error(`${resolved} is not a directory`);

  const root = resolve(resolved, '..') === resolved;
  const home = resolved.toLowerCase() === HOME.toLowerCase();

  return {
    path: resolved,
    ...(root || home
      ? {
          warning: root
            ? 'this is a whole drive: everything on it, except keys and the runtime’s own store'
            : 'this is your home directory: every file in it, except keys and the runtime’s own store',
        }
      : {}),
  };
};

/** Where an agent's own private workspace lives. Always its first root. */
export const workspacePathFor = (label: string): string => join(WORKSPACES, label);

export const SEPARATOR = sep;
