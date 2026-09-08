/**
 * Delegation as the plugin runs it: an authority on a real socket.
 *
 *   bun packages/dsh/delegation-check.ts
 *
 * The authority's own rules are checked in `delegate-check`, against the object.
 * What is checked here is the part that only exists inside DSH — a Node HTTP
 * server in front of it — because that translation is where a working authority
 * can still be unreachable: a body read as the wrong type, a header lost, a port
 * that never frees.
 *
 * No key and no network. The signer records what it was asked to sign.
 */
import { startDelegation } from './src/delegation';
import type { PaymentRequirements, PaymentSigner } from '../sdk/src/index';

let failures = 0;
const check = (ok: boolean, label: string, detail = '') => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
};

const NETWORK = 'hedera:testnet';
const signed: PaymentRequirements[] = [];

const signer: PaymentSigner = {
  network: NETWORK,
  accountId: '0.0.1001',
  async createPayload(_version, requirements) {
    signed.push(requirements);
    return { transaction: `signed:${requirements.amount}` };
  },
};

const quote = (amount: string) => ({
  scheme: 'exact',
  network: NETWORK,
  amount,
  asset: '0.0.0',
  payTo: '0.0.2002',
  maxTimeoutSeconds: 180,
  extra: { feePayer: '0.0.7162784' },
});

console.log('\n  Delegation over a real socket\n');

const delegation = await startDelegation({
  signer,
  network: NETWORK,
  fundedMinor: 100_000n,
});

try {
  check(/^http:\/\/127\.0\.0\.1:\d+$/.test(delegation.url), 'listens on loopback', delegation.url);

  const health = await fetch(`${delegation.url}/health`).then((r) => r.json());
  check((health as { ok: boolean }).ok === true, 'health answers without a capability');
  check(
    !JSON.stringify(health).includes('balance'),
    'and reports liveness rather than what anyone holds',
  );

  const capability = await delegation.mint({ child: 'researcher', amountMinor: 10_000n, hours: 1 });
  check(capability.startsWith('er_'), 'minting returns a capability');

  const tree = delegation.view();
  check(
    tree.allowances.some((node) => node.id === 'researcher' && node.balanceMinor === '10000'),
    'and the allowance appears in the tree',
  );
  check(
    tree.allowances.find((node) => node.id === 'researcher')!.balance.includes('0.0001'),
    'rendered in the asset the user thinks in',
    tree.allowances.find((node) => node.id === 'researcher')!.balance,
  );

  /*
    The whole point of the socket: a sub-agent holding only a capability, in
    another process, spends through it. A POST with a JSON body is exactly the
    translation this file exists to check.
  */
  const paid = await fetch(`${delegation.url}/sign`, {
    method: 'POST',
    headers: { authorization: `Bearer ${capability}`, 'content-type': 'application/json' },
    body: JSON.stringify({ x402Version: 2, requirements: quote('4000') }),
  });
  const paidBody = (await paid.json()) as { remainingMinor?: string };
  check(paid.status === 200, 'a capability can spend over HTTP', String(paid.status));
  check(paidBody.remainingMinor === '6000', 'and the budget goes down by what was signed');
  check(signed.length === 1 && signed[0]!.amount === '4000', 'the signer signed exactly that');

  const over = await fetch(`${delegation.url}/sign`, {
    method: 'POST',
    headers: { authorization: `Bearer ${capability}`, 'content-type': 'application/json' },
    body: JSON.stringify({ x402Version: 2, requirements: quote('9000') }),
  });
  check(over.status === 402, 'spending past the allowance is refused with 402', String(over.status));
  check(signed.length === 1, 'and nothing was signed for it');

  const anonymous = await fetch(`${delegation.url}/sign`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ x402Version: 2, requirements: quote('10') }),
  });
  check(anonymous.status === 401, 'no capability, no signature', String(anonymous.status));

  const recovered = await delegation.revoke('researcher');
  check(recovered === 6_000n, 'revoking returns what was left', recovered.toString());

  const afterRevoke = await fetch(`${delegation.url}/sign`, {
    method: 'POST',
    headers: { authorization: `Bearer ${capability}`, 'content-type': 'application/json' },
    body: JSON.stringify({ x402Version: 2, requirements: quote('100') }),
  });
  check(afterRevoke.status === 403, 'a revoked capability cannot spend', String(afterRevoke.status));
} finally {
  await delegation.stop();
}

/*
  The socket must actually be released. A stopped delegation that still holds a
  port would leave a budget listening with nothing owning it, and would refuse
  to restart on the same port.
*/
const reachable = await fetch(`${delegation.url}/health`)
  .then(() => true)
  .catch(() => false);
check(!reachable, 'stopping closes the socket');

console.log(failures === 0 ? '\n  All checks pass.\n' : `\n  ${failures} FAILED.\n`);
if (failures > 0) process.exit(1);
