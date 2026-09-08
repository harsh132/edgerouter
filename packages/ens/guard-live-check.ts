/**
 * The guard, against the real registry.
 *
 *   bun packages/ens/guard-live-check.ts
 *
 * The unit checks prove the authority obeys a guard. This proves the guard
 * tells the truth about names that actually exist — which is the half that
 * cannot be faked, because it is the half where an RPC, a resolver, and a
 * registry all have to agree.
 *
 * Reads only. Nothing here revokes anything: taking a name down to watch a
 * refusal would cost a transaction and leave the demo broken afterwards, so the
 * revoked case is checked with a name that was never minted — which is exactly
 * what a cleared subregistry leaves behind.
 */
import { ensNameGuard } from './src/index';

let failures = 0;
const check = (ok: boolean, label: string, detail = '') => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
};

const guard = ensNameGuard();

console.log('\n  The name guard, against Sepolia\n');

for (const name of [
  'edgerouter.eth',
  'session-demo.edgerouter.eth',
  'researcher.session-demo.edgerouter.eth',
]) {
  const problem = await guard.check(name);
  check(problem === null, `${name} resolves, so it may spend`, problem ?? '');
}

/*
  A name nobody minted. This is the shape a revoked name takes: the registry no
  longer points anywhere, so resolution returns nothing at all rather than an
  error saying the name was withdrawn.
*/
const absent = 'never-minted.session-demo.edgerouter.eth';
const problem = await guard.check(absent);
check(problem !== null, 'a name that does not resolve is refused');
console.log(`        ${problem ?? '(resolved, which it should not)'}`);

/*
  Nodes that are not names pass untouched — the authority's root has been called
  `root` since before any of this existed, and an authority whose tree predates
  names should keep working.
*/
check((await guard.check('root')) === null, 'a node that is not a name is not checked');

/* The second read of a resolving name is served from cache rather than the RPC. */
const started = Date.now();
await guard.check('edgerouter.eth');
const cachedMs = Date.now() - started;
check(cachedMs < 50, 'a resolving name is cached, not re-resolved', `${cachedMs}ms`);

console.log(failures === 0 ? '\n  All checks pass.\n' : `\n  ${failures} FAILED.\n`);
if (failures > 0) process.exit(1);
