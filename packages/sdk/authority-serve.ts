/**
 * Runs a budget authority on loopback.
 *
 *   bun packages/sdk/authority-serve.ts --fund 1.0
 *
 * It prints the root capability once, on stdout, and never again. That is the
 * key to everything this process holds, so it is treated like one: hand it to
 * the parent agent, mint children from it, and do not put it in a file that
 * gets synced.
 *
 * Loopback only, and not configurable. A capability is a bearer token — the
 * defining property of a macaroon and the reason delegation needs no server
 * round trip — which means anything that can reach this port and holds a token
 * can spend that token's budget. Between an agent and its sub-agents on one
 * machine that is exactly right. On 0.0.0.0 it is a wallet with an HTTP
 * interface, so binding it there is not offered.
 */
import { createAuthority, authorityHandler, loadOrCreateWallet, formatHbar } from './src/index';

/*
  Declared locally rather than by taking `@types/bun`. This repo also compiles
  against `@cloudflare/workers-types`, and two packages that each define the
  global `fetch`, `Request`, and `Response` do not agree about them — the gate
  would start failing to typecheck to make one script's `serve` call legible.
*/
declare const Bun: {
  serve(options: {
    port: number;
    hostname: string;
    fetch: (request: Request) => Promise<Response>;
  }): unknown;
};

const arg = (name: string): string | undefined => {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : undefined;
};

function die(message: string): never {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

const SECRET = process.env.EDGEROUTER_AUTHORITY_SECRET;

/*
  Generated when absent rather than defaulted to something. A default secret is
  a secret everyone has, and the only thing lost by generating one is that
  capabilities do not survive a restart — which for a session budget is closer
  to right than wrong.
*/
const secret = SECRET ?? crypto.randomUUID() + crypto.randomUUID();
if (!SECRET) {
  console.log('  note      no EDGEROUTER_AUTHORITY_SECRET set; capabilities last until restart');
}

const hbar = Number(arg('fund') ?? '1');
if (!Number.isFinite(hbar) || hbar <= 0) die('--fund takes a positive number of hbar');
const fundedMinor = BigInt(Math.round(hbar * 1e8));

const port = Number(arg('port') ?? '8790');
const network = arg('network') ?? 'hedera:testnet';

const { wallet, path } = loadOrCreateWallet({ network });
const funding = await wallet.refresh();
if (!funding.funded) {
  die(`the wallet has no account yet — send hbar to ${wallet.evmAddress}
  stored at ${path}`);
}

const signer = wallet.signer();
const authority = await createAuthority({
  signer,
  secret,
  fundedMinor,
  ...(arg('pay-to') ? { allowPayTo: [arg('pay-to')!] } : {}),
});

const handler = authorityHandler(authority);
Bun.serve({ port, hostname: '127.0.0.1', fetch: handler });

console.log(`\n  authority http://127.0.0.1:${port}`);
console.log(`  paying    ${authority.account} on ${authority.network}`);
console.log(`  budget    ${formatHbar(fundedMinor)}`);
if (arg('pay-to')) console.log(`  pays only ${arg('pay-to')}`);
console.log(`\n  root capability (hand this to the parent agent, once):\n`);
console.log(`  ${authority.rootCapability}\n`);
