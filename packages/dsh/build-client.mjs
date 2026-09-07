/**
 * Wraps the browser bundle in the shape DSH's client loader expects.
 *
 * The loader does not import a bundle; it runs a script that *registers a
 * factory*, so nothing in the plugin executes until the plugin is first used:
 *
 *   window.__ModuleLoader__.load({ id, factory: (require) => { … } })
 *
 * Inside that factory, `require` answers only the shell's frozen module table
 * (React, Cordis, the static UI libraries) plus whatever `dsh.client.external`
 * declares. That is why the bundle is built as CJS with those packages
 * external — the `require` calls rolldown emits are exactly the requests the
 * loader resolves.
 *
 * This wrapper is derived from what the shipped plugins emit rather than from a
 * published builder, because DSH's own client build tooling is internal. If a
 * future release changes the shape, this is the one file to change.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const { name } = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'));

execFileSync(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['tsdown', '--config', 'tsdown.client.config.ts'],
  { cwd: here, stdio: 'inherit', shell: process.platform === 'win32' },
);

/*
  tsdown names a cjs output `.cjs`. The loader serves `./client` from the
  package's export map and the shipped plugins use `.js`, so the extension is
  normalised here rather than by fighting the bundler's naming.
*/
const built = join(here, 'client', 'client.cjs');
const bundle = join(here, 'client', 'client.js');
const body = readFileSync(built, 'utf8');
rmSync(built, { force: true });

if (body.startsWith('window.__ModuleLoader__')) {
  console.log('  client bundle already wrapped; nothing to do');
} else {
  /*
    `module` and `exports` are declared inside the factory rather than assumed:
    a browser has neither, and the CJS body rolldown emits assigns to both.
  */
  writeFileSync(
    bundle,
    [
      `window.__ModuleLoader__.load({ id: ${JSON.stringify(name)}, factory: (require) => {`,
      'var module = { exports: {} };',
      'var exports = module.exports;',
      'Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });',
      body,
      'return module.exports;',
      '} });',
      '',
    ].join('\n'),
    'utf8',
  );
  console.log(`  wrapped client bundle for ${name}`);
}
