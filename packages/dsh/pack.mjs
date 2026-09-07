/**
 * Builds the plugin and packs it to a *stable* filename.
 *
 * `npm pack` names the tarball after the version, which seems tidy and breaks
 * every install that came before it. A DSH profile pins the plugin by absolute
 * path — `file:.../dsh-plugin-edgerouter-0.1.1.tgz` — so bumping the version
 * leaves that pin pointing at a file whose name no longer exists, and pnpm then
 * refuses to do anything at all in that profile, including installing the
 * replacement:
 *
 *   ENOENT: no such file or directory, open '...-0.1.1.tgz'
 *   This error happened while installing a direct dependency
 *
 * One name fixes it. The pin stays valid across versions, and `dsh plugin add`
 * on the same path picks up new contents — pnpm keys its cache on path *and*
 * version, so a bumped version still re-extracts rather than replaying the old
 * one from cache.
 *
 *   npm run pack   →   dsh-plugin-edgerouter.tgz
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, renameSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const run = (command, args) =>
  execFileSync(command, args, { cwd: here, stdio: 'inherit', shell: process.platform === 'win32' });

const { version } = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'));

run(npm, ['run', 'build']);
run(npm, ['pack', '--pack-destination', '.', '--silent']);

const versioned = join(here, `dsh-plugin-edgerouter-${version}.tgz`);
const stable = join(here, 'dsh-plugin-edgerouter.tgz');

// Removed rather than overwritten: rename onto an existing file is not portable
// across every filesystem, and a stale tarball left behind is the exact failure
// this script exists to prevent.
rmSync(stable, { force: true });
renameSync(versioned, stable);

console.log(`\n  packed ${version} -> dsh-plugin-edgerouter.tgz`);
console.log('  install with:');
console.log(`    dsh plugin --profile desktop add "${stable.replace(/\\/g, '/')}"\n`);
