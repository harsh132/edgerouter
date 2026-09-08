/**
 * Buying an answer on Arc, against the deployed gate.
 *
 *   bun packages/sdk/arc-pay-check.ts
 *
 * The spike proved Circle's Gateway settles a payment. This proves the gate
 * quotes one we can pay and serves what we bought — which is a different claim,
 * and the one the Arc track actually asks about.
 *
 * It spends testnet USDC out of the Gateway balance. Nothing here is mocked:
 * the gate is the deployed Worker, the facilitator is Circle's, and the answer
 * comes from the model the payment bought.
 */
import { GatewayClient } from '@circle-fin/x402-batching/client';
import { evmSigner, loadOrCreateEvmWallet, base64 } from './src/index';
import type { PaymentRequirements } from './src/index';

const GATE = 'https://edgerouter-gate.prakashharsh32.workers.dev/v1/chat/completions';
const ARC = 'eip155:5042002';

let failures = 0;
const check = (ok: boolean, label: string, detail = '') => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
};

const { wallet } = loadOrCreateEvmWallet({ network: ARC });
const privateKey = wallet.exportPrivateKey() as `0x${string}`;
const address = wallet.address as `0x${string}`;

console.log('\n  Paying the gate on Arc\n');
console.log(`  buyer            ${address}`);

const gateway = new GatewayClient({ chain: 'arcTestnet', privateKey });
const before = await gateway.getBalances(address);
console.log(`  gateway balance  ${before.gateway.formattedAvailable}\n`);

if (before.gateway.available === 0n) {
  console.log('  Nothing deposited into the Gateway, so nothing can be paid from it.');
  console.log('  Run `bun packages/sdk/arc-gateway-spike.ts` to deposit, then retry.\n');
  process.exit(0);
}

/* ------------------------------------------------------------------- quoted */

const url = `${GATE}?network=${encodeURIComponent(ARC)}`;
const body = JSON.stringify({
  model: 'openai/gpt-4o-mini',
  messages: [{ role: 'user', content: 'Reply with exactly: paid on Arc' }],
});

const unpaid = await fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body,
});
check(unpaid.status === 402, 'the gate asks to be paid', String(unpaid.status));

const required = (await unpaid.json()) as {
  x402Version: number;
  resource: unknown;
  accepts: PaymentRequirements[];
};
const quote = required.accepts[0]!;
check(quote.network === ARC, 'and quotes Arc', `${quote.amount} units`);
check(
  (quote.extra as { verifyingContract?: string }).verifyingContract ===
    '0x0077777d7EBA4688BDeF3E311b846F25870A19B9',
  'binding the signature to the GatewayWallet',
);

/* -------------------------------------------------------------------- paid */

/*
  Our own signer, not Circle's scheme directly — the point being that the
  composite dispatches to the batched path on its own, from the quote alone.
*/
const signer = evmSigner({ privateKey, network: ARC });
const payload = await signer.createPayload(required.x402Version, quote);

const payment = base64(
  JSON.stringify({ x402Version: required.x402Version, payload, resource: required.resource, accepted: quote }),
);

const started = Date.now();
const paid = await fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'PAYMENT-SIGNATURE': payment },
  body,
});
const elapsed = Date.now() - started;

if (!paid.ok) {
  const detail = await paid.text();
  check(false, 'the payment was accepted', `${paid.status} ${detail.slice(0, 300)}`);
} else {
  const answer = (await paid.json()) as { choices?: { message?: { content?: string } }[] };
  const text = answer.choices?.[0]?.message?.content ?? '';
  check(true, 'the payment was accepted', `${elapsed}ms`);
  check(text.length > 0, 'and the gate served what was bought', text.trim().slice(0, 60));

  const receipt = paid.headers.get('PAYMENT-RESPONSE');
  const settlement = receipt
    ? (JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(receipt), (c) => c.charCodeAt(0)))) as {
        transaction?: string;
      }).transaction
    : undefined;
  console.log(`  settlement       ${settlement ?? '(none reported)'}`);
}

/* ------------------------------------------------------------------ charged */

/*
  The balance, afterwards. A gate that served without charging would pass every
  check above, and be a different product entirely.
*/
const after = await gateway.getBalances(address);
console.log(`\n  gateway before   ${before.gateway.formattedAvailable}`);
console.log(`  gateway after    ${after.gateway.formattedAvailable}`);
check(
  after.gateway.available < before.gateway.available,
  'and the money actually left',
  `${before.gateway.available - after.gateway.available} units`,
);

console.log(failures === 0 ? '\n  All checks pass.\n' : `\n  ${failures} FAILED.\n`);
if (failures > 0) process.exit(1);
