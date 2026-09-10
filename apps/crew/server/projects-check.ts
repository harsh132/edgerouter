/**
 * What an agent can and cannot open, checked against a real filesystem.
 *
 *   bun apps/crew/server/projects-check.ts
 *
 * No network and no chain. Everything here is path arithmetic, and path
 * arithmetic is exactly the kind of code that looks obviously right and is
 * wrong on one platform, one separator, or one symlink. The interesting cases
 * are the refusals: a check that only proves an agent can read its own files
 * proves nothing about the grant that lets it read yours.
 */
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { resolveIn, describeGrant, type ProjectMode } from './projects';

let failures = 0;
const check = (claim: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${claim}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

const refuses = async (claim: string, run: () => Promise<unknown>, expect?: RegExp) => {
  try {
    await run();
    check(claim, false, 'it was allowed');
  } catch (error) {
    const message = (error as Error).message;
    check(claim, expect ? expect.test(message) : true, message.slice(0, 80));
  }
};

console.log('\n  what an agent may open\n');

const sandbox = mkdtempSync(join(tmpdir(), 'crew-check-'));
const room = join(sandbox, 'workspace');
const repo = join(sandbox, 'repo');
const outside = join(sandbox, 'not-granted');

for (const directory of [room, repo, outside, join(repo, 'src'), join(repo, '.git')]) {
  mkdirSync(directory, { recursive: true });
}
writeFileSync(join(repo, 'src', 'index.ts'), 'export const x = 1;\n');
writeFileSync(join(repo, '.env'), 'SECRET=1\n');
writeFileSync(join(outside, 'private.txt'), 'not yours\n');

const roots = (mode: ProjectMode) => [
  { root: room, mode: 'write' as ProjectMode, name: 'your workspace' },
  { root: repo, mode, name: 'the repo' },
];

/* ---------------------------------------------------------------- allowed */

check(
  'a relative path resolves inside its own workspace',
  (await resolveIn(roots('read'), 'notes.md', 'write')).startsWith(room),
);
check(
  'an absolute path inside a granted folder is allowed',
  (await resolveIn(roots('read'), join(repo, 'src', 'index.ts'), 'read')).startsWith(repo),
);
check(
  'a file that does not exist yet can still be written',
  (await resolveIn(roots('write'), join(repo, 'src', 'new.ts'), 'write')).endsWith('new.ts'),
);

/* ---------------------------------------------------------------- refused */

await refuses(
  'a path outside every grant is refused',
  () => resolveIn(roots('read'), join(outside, 'private.txt'), 'read'),
  /outside everything/,
);

await refuses(
  'traversal out of a grant is refused',
  () => resolveIn(roots('read'), join(repo, '..', 'not-granted', 'private.txt'), 'read'),
  /outside everything/,
);

await refuses(
  'writing to a read-only grant is refused',
  () => resolveIn(roots('read'), join(repo, 'src', 'index.ts'), 'write'),
  /read-only/,
);

await refuses(
  'a .env inside a granted folder is refused, whatever the mode',
  () => resolveIn(roots('write'), join(repo, '.env'), 'read'),
  /off limits/,
);

await refuses(
  'git internals cannot be written',
  () => resolveIn(roots('write'), join(repo, '.git', 'HEAD'), 'write'),
  /cannot be written/,
);

check(
  'but git internals can be read',
  (await resolveIn(roots('write'), join(repo, '.git', 'HEAD'), 'read')).includes('.git'),
);

/*
  The wallet. This is the one that matters most: an agent granted a whole drive
  is granted the directory holding the key that pays for it, and a deny-list
  that covers `.env` but not this would be theatre.
*/
const wholeMachine = [
  { root: room, mode: 'write' as ProjectMode, name: 'your workspace' },
  { root: homedir(), mode: 'write' as ProjectMode, name: 'everything' },
];
await refuses(
  'the runtime’s own store is refused even when the whole home directory is granted',
  () => resolveIn(wholeMachine, join(homedir(), '.edgerouter', 'crew.json'), 'read'),
  /off limits/,
);
await refuses(
  'and so is the wallet inside it',
  () => resolveIn(wholeMachine, join(homedir(), '.edgerouter', 'wallets', 'evm.json'), 'read'),
  /off limits/,
);
check(
  'but an agent’s own workspace under it stays writable',
  (await resolveIn(wholeMachine, join(homedir(), '.edgerouter', 'workspaces', 'x', 'notes.md'), 'write')).includes(
    'workspaces',
  ),
);
await refuses(
  'ssh keys are refused under a whole-machine grant',
  () => resolveIn(wholeMachine, join(homedir(), '.ssh', 'id_rsa'), 'read'),
  /off limits/,
);

/*
  A symlink is the interesting attack, because the string looks contained and
  the file is not. Skipped where the platform will not make one without
  elevation, which is most Windows machines — better an honest skip than a
  check that passes because it never ran.
*/
try {
  symlinkSync(outside, join(repo, 'escape'), 'dir');
  await refuses(
    'a symlink pointing out of a grant is refused',
    () => resolveIn(roots('read'), join(repo, 'escape', 'private.txt'), 'read'),
    /outside everything/,
  );
} catch {
  console.log('  skip  symlink escape — this platform will not create one without elevation');
}

/* ------------------------------------------------------------- granting */

await refuses(
  'a folder that does not exist cannot be granted',
  async () => describeGrant(join(sandbox, 'nope')),
  /does not exist/,
);
await refuses('a file cannot be granted as a folder', async () => describeGrant(join(repo, '.env')), /not a directory/);
check(
  'granting a home directory is allowed, and says what it is',
  Boolean(describeGrant(homedir()).warning),
  describeGrant(homedir()).warning ?? '',
);
check('granting an ordinary folder carries no warning', describeGrant(repo).warning === undefined);

console.log(failures === 0 ? '\n  All checks pass.\n' : `\n  ${failures} failed.\n`);
process.exit(failures === 0 ? 0 : 1);
