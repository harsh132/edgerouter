/**
 * Does the facilitator actually support what we advertise?
 *
 * A gate can quote a network perfectly and still be unsettleable, because the
 * facilitator decides which (scheme, network) pairs it will accept. That failure
 * is invisible until a real payment arrives — by which point a user has signed
 * something nobody can settle.
 *
 * So the configured networks are compared against the facilitator's own
 * `GET /supported`. This caught a live mismatch on the first run: the gate
 * defaulted to Base Sepolia, which Blocky402 does not serve.
 *
 *   bun apps/gate/facilitator-check.ts [facilitator-url] [networks-json]
 */
import { parseNetworks } from './src/networks';

const FACILITATOR = process.argv[2] ?? 'https://api.testnet.blocky402.com';

let failures = 0;
const pass = (m: string) => console.log(`  ok    ${m}`);
const fail = (m: string) => { failures += 1; console.log(`  FAIL  ${m}`); };

type Kind = { x402Version: number; scheme: string; network: string; extra?: { feePayer?: string } };

const supported: { kinds?: Kind[] } = await fetch(`${FACILITATOR}/supported`, {
  signal: AbortSignal.timeout(20_000),
}).then((r) => r.json());

const kinds = supported.kinds ?? [];
console.log(`${FACILITATOR}\n`);
for (const k of kinds) {
  console.log(`  offers  ${k.scheme.padEnd(18)} ${k.network}${k.extra?.feePayer ? `  feePayer ${k.extra.feePayer}` : ''}`);
}
console.log();

const configured = parseNetworks(process.argv[3] ?? process.env.NETWORKS ?? '[]');
if (configured.size === 0) {
  fail('no networks configured to check — pass NETWORKS as JSON');
}

for (const [id, network] of configured) {
  const match = kinds.find((k) => k.network === id && k.scheme === 'exact');
  if (!match) {
    fail(`${id} is configured but the facilitator does not settle it`);
    continue;
  }
  pass(`${id} is settleable`);

  /*
    Hedera's fee payer is not ours to choose: the facilitator sponsors the
    transaction, so a quote naming a different account produces a transaction it
    will refuse to co-sign.
  */
  if (network.kind === 'hedera') {
    const theirs = match.extra?.feePayer;
    if (theirs !== network.feePayer) {
      fail(`${id} feePayer mismatch — we advertise ${network.feePayer}, facilitator sponsors ${theirs}`);
    } else {
      pass(`${id} feePayer matches the facilitator (${theirs})`);
    }
  }
}

const batch = kinds.some((k) => k.scheme === 'batch-settlement');
console.log(
  batch
    ? '\n  note  batch-settlement is offered — the escrow plan is reachable'
    : '\n  note  batch-settlement is NOT offered here; only `exact` is settleable,\n        so docs/BATCH-SETTLEMENT.md stays a plan rather than a next step',
);

console.log(failures === 0 ? '\nAll checks pass.' : `\n${failures} FAILED.`);
process.exit(failures === 0 ? 0 : 1);
