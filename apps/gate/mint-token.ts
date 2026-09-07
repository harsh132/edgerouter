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

/*
  Which variable holds the secret is itself configurable, for one specific
  reason: a deployed gate has a different SERVICE_SECRET from the dev one, and
  the obvious way to keep it around — putting it in `.env` — silently wins over
  `.dev.vars` and makes every local mint produce production tokens. Naming the
  variable instead lets both live side by side:

    .env:  PROD_SERVICE_SECRET=...
    mint:  EDGEROUTER_SECRET_ENV=PROD_SERVICE_SECRET bun apps/gate/mint-token.ts

  A token minted this way is a real bearer credential for a live service. Treat
  it like one: it is printed to stdout so it can go straight into a variable
  without passing through a file or a terminal history.
*/
const SECRET_ENV = process.env.EDGEROUTER_SECRET_ENV ?? 'SERVICE_SECRET';
const secret = process.env[SECRET_ENV] ?? devVar('SERVICE_SECRET');
if (!secret) {
  console.error(`\n  no ${SECRET_ENV} in the environment, and no SERVICE_SECRET in apps/gate/.dev.vars\n`);
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
