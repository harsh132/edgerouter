/**
 * Mints a capability for local development.
 *
 * The gate refuses before it quotes: no capability means 401, and a client
 * never reaches the 402 it is trying to pay. So anything exercising the payment
 * path needs one of these first.
 *
 *   bun apps/gate/mint-token.ts [node] [ceiling-minor] [hours]
 *
 * The secret is read from `.dev.vars`, which is git-ignored. This is a
 * development tool: a token minted against the deployed SERVICE_SECRET would be
 * a real bearer credential, and this script deliberately has no way to reach
 * one — it reads the local file or nothing.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mint, serialize } from '../../packages/core/src/token';
import { deriveRootKey } from './src/env';
import { base64 } from './src/x402';

const HERE = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

const devVar = (name: string): string | null => {
  try {
    const text = readFileSync(join(HERE, '.dev.vars'), 'utf8');
    for (const line of text.split('\n')) {
      const [key, ...rest] = line.split('=');
      if (key?.trim() === name) return rest.join('=').trim();
    }
  } catch {
    /* no .dev.vars — reported below */
  }
  return null;
};

const secret = process.env.SERVICE_SECRET ?? devVar('SERVICE_SECRET');
if (!secret) {
  console.error('\n  no SERVICE_SECRET in the environment or apps/gate/.dev.vars\n');
  process.exit(1);
}

const ROOT = process.env.EDGEROUTER_ROOT ?? 'harsh.edgerouter.eth';
const node = process.argv[2] ?? `dev.${ROOT}`;
const ceilingMinor = BigInt(process.argv[3] ?? '1000000');
const hours = Number(process.argv[4] ?? '24');

const expiresAt = Date.now() + hours * 3_600_000;
const token = await mint(await deriveRootKey(secret, ROOT), {
  root: ROOT,
  node,
  ceilingMinor,
  expiresAt,
});

const bearer = `er_${base64(serialize(token))}`;

console.error(`\n  root     ${ROOT}`);
console.error(`  node     ${node}`);
console.error(`  ceiling  ${ceilingMinor} (smallest unit of the payment asset)`);
console.error(`  expires  ${new Date(expiresAt).toISOString()}\n`);

// The token itself goes to stdout alone, so this composes:
//   EDGEROUTER_TOKEN=$(bun apps/gate/mint-token.ts) bun run pay-check
console.log(bearer);
