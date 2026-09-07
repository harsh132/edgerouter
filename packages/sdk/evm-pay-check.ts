/**
 * A real EIP-3009 payment, end to end, against a running gate.
 *
 * `evm-check.ts` proves the signature is well formed. Only a facilitator can
 * prove it is *acceptable* — that the domain matches the token, that the
 * authorization submits, and that the money moves. This is that.
 *
 * It spends. The payer is the generated EVM wallet unless a key is supplied:
 *
 *   bun packages/sdk/evm-pay-check.ts [gate-url]
 *   EVM_PRIVATE_KEY=0x... bun packages/sdk/evm-pay-check.ts
 *
 * Note what is *not* needed: native gas. EIP-3009 is an authorization the
 * facilitator submits and pays for, so a wallet holding only USDC can pay.
 * That is the property being demonstrated as much as the payment itself.
 *
 * Not part of `bun run check`.
 */
import {
  evmSigner,
  loadOrCreateEvmWallet,
  payAndFetch,
  formatUsdc,
  PaymentRefused,
  type PaymentSigner,
} from './src/index';

const GATE = process.argv[2] ?? 'https://edgerouter-gate.prakashharsh32.workers.dev';
const NETWORK = process.env.EVM_NETWORK ?? 'eip155:80002';

function die(message: string): never {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

let signer: PaymentSigner;
let note: string;

if (process.env.EVM_PRIVATE_KEY) {
  signer = evmSigner({ privateKey: process.env.EVM_PRIVATE_KEY, network: NETWORK });
  note = 'from the environment';
} else {
  const { wallet } = loadOrCreateEvmWallet({ network: NETWORK });
  const funding = await wallet.refresh();
  if (!funding.canPay) {
    die(
      `the generated wallet holds no USDC — send some to ${wallet.address}\n` +
        '  Testnet USDC: https://faucet.circle.com',
    );
  }
  signer = wallet.signer();
  note = `generated wallet, ${formatUsdc(funding.tokenMinor)}, ${funding.nativeWei} wei of gas`;
}

console.log(`\n  gate      ${GATE}`);
console.log(`  network   ${NETWORK}`);
console.log(`  payer     ${signer.accountId} (${note})\n`);

/*
  The network is asked for explicitly. The gate defaults to Hedera, and a check
  that silently paid on the default would prove the EVM path works while never
  having exercised it.
*/
const url = new URL('/v1/chat/completions', GATE);
url.searchParams.set('network', NETWORK);

let result;
try {
  result = await payAndFetch(url.toString(), {
    signer,
    // 1 USDC. Far above the quote, so the cap is not what is being tested here.
    maxAmount: 1_000_000n,
    init: {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek/deepseek-chat',
        messages: [{ role: 'user', content: 'Reply with one short sentence about EIP-3009.' }],
      }),
    },
  });
} catch (error) {
  if (error instanceof PaymentRefused) die(`refused before signing (${error.reason}): ${error.message}`);
  throw error;
}

const body = await result.response.text();
if (result.response.status !== 200) {
  die(`the gate answered ${result.response.status}: ${body.slice(0, 400)}`);
}

const problems: string[] = [];
if (result.attempts !== 2) problems.push(`expected a 402 then a paid retry, saw ${result.attempts}`);
if (!result.quote) problems.push('nothing was quoted, so nothing was paid');
if (result.quote && result.quote.network !== NETWORK) {
  problems.push(`paid on ${result.quote.network}, not ${NETWORK}`);
}
if (!result.settlement) problems.push('the gate returned no settlement receipt');

if (result.quote) {
  console.log(`  quoted    ${formatUsdc(BigInt(result.quote.amount))}`);
  console.log(`  asset     ${result.quote.asset}`);
  console.log(`  payTo     ${result.quote.payTo}`);
  console.log(`  domain    name=${result.quote.extra?.name} version=${result.quote.extra?.version}`);
}
console.log(`  signing   ${result.signingMs}ms`);
console.log(`  paid call ${result.paidRequestMs}ms`);
if (result.settlement) {
  console.log(`  settled   ${JSON.stringify(result.settlement).slice(0, 200)}`);
}

const answer = (JSON.parse(body) as { choices?: { message?: { content?: string } }[] }).choices?.[0]
  ?.message?.content;
console.log(`\n  answer    ${(answer ?? '').trim().slice(0, 200)}`);
if (!answer) problems.push('the model returned no text');

console.log('');
if (problems.length > 0) {
  for (const problem of problems) console.log(`  FAIL  ${problem}`);
  process.exit(1);
}
console.log('  An EIP-3009 authorization was signed, settled, and paid for inference.\n');
