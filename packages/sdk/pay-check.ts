/**
 * One real x402 round trip on Hedera testnet.
 *
 *   402 issued  →  transfer signed  →  settlement accepted  →  200 served
 *
 * This is the only thing in the repository that moves money, so it is a script
 * you run rather than part of `bun run check`. Nothing else needs a key, and
 * nothing else should have one.
 *
 *   HEDERA_ACCOUNT_ID=0.0.x HEDERA_PRIVATE_KEY=... bun packages/sdk/pay-check.ts [url]
 *
 * The key is read from the environment only. Do not pass it as an argument —
 * arguments end up in shell history and in process listings. It is never
 * printed here, and the failure paths are written so it cannot appear in an
 * error message either.
 *
 * What this answers that no unit check can:
 *
 *   1. whether Blocky402 accepts a transaction built by `@x402/hedera` against
 *      requirements built by our gate — the two halves have never met
 *   2. how long settlement actually takes, which is the input to whether
 *      batching is worth building (docs/BATCH-SETTLEMENT.md)
 */
import { payAndFetch, hederaSigner, formatHbar, PaymentRefused } from './src/index';

const URL_ARG = process.argv[2] ?? 'http://127.0.0.1:8787/v1/chat/completions';
const ACCOUNT = process.env.HEDERA_ACCOUNT_ID;
const KEY = process.env.HEDERA_PRIVATE_KEY;
const CAPABILITY = process.env.EDGEROUTER_TOKEN;

/** A cap this script cannot exceed regardless of what the server quotes. */
const MAX_TINYBARS = BigInt(process.env.MAX_TINYBARS ?? 100_000_000n.toString());

const MIRROR = 'https://testnet.mirrornode.hedera.com';

// A declaration rather than an arrow constant, so TypeScript treats a call to
// it as terminating and narrows `null` away on the lines that follow.
function die(message: string): never {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

if (!ACCOUNT) die('set HEDERA_ACCOUNT_ID to the payer account (not the gate’s payTo)');
if (!KEY) die('set HEDERA_PRIVATE_KEY in the environment — never as an argument');

const balanceOf = async (account: string): Promise<bigint | null> => {
  try {
    const response = await fetch(`${MIRROR}/api/v1/accounts/${account}`);
    if (!response.ok) return null;
    const body = (await response.json()) as { balance?: { balance?: number } };
    return BigInt(body.balance?.balance ?? 0);
  } catch {
    return null;
  }
};

const signer = hederaSigner({ accountId: ACCOUNT!, privateKey: KEY!, network: 'hedera:testnet' });

console.log(`\n  payer     ${signer.accountId}`);
console.log(`  resource  ${URL_ARG}`);
console.log(`  cap       ${formatHbar(MAX_TINYBARS)}`);

const before = await balanceOf(signer.accountId);
if (before === null) die(`could not read ${signer.accountId} from the mirror node`);
if (before === 0n) die(`${signer.accountId} has no HBAR — fund it from the testnet faucet`);
console.log(`  balance   ${formatHbar(before)}\n`);

const body = JSON.stringify({
  model: 'deepseek/deepseek-chat',
  messages: [{ role: 'user', content: 'Reply with the single word: paid.' }],
});

let result;
try {
  result = await payAndFetch(URL_ARG, {
    signer,
    maxAmount: MAX_TINYBARS,
    init: {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(CAPABILITY ? { authorization: `Bearer ${CAPABILITY}` } : {}),
      },
      body,
    },
  });
} catch (error) {
  if (error instanceof PaymentRefused) {
    die(`refused before signing (${error.reason}): ${error.message}`);
  }
  die(`payment failed: ${(error as Error).message}`);
}

const { quote, response, settlement, attempts, signingMs, paidRequestMs } = result!;

if (attempts === 1) {
  console.log('  The resource was free — no 402, nothing paid.');
  console.log('  Point this at a paid route to prove settlement.\n');
  process.exit(0);
}

console.log(`  quoted    ${formatHbar(BigInt(quote!.amount))} on ${quote!.network}`);
console.log(`  payTo     ${quote!.payTo}`);
console.log(`  feePayer  ${String(quote!.extra?.feePayer ?? '(none)')}`);
console.log(`  signing   ${signingMs} ms`);
console.log(`  paid call ${paidRequestMs} ms  (upstream + settlement)\n`);

const text = await response.text();

if (response.status !== 200) {
  console.log(`  FAILED  the gate answered ${response.status}`);
  console.log(`  ${text.slice(0, 400)}\n`);
  process.exit(1);
}

console.log(`  served    200`);
if (settlement) {
  const id = settlement.transaction ?? settlement.transactionId;
  console.log(`  settled   ${settlement.success === false ? 'NO' : 'yes'}`);
  if (typeof id === 'string' && id.length > 0) {
    console.log(`  tx        ${id}`);
    console.log(`  explorer  https://hashscan.io/testnet/transaction/${encodeURIComponent(id)}`);
  }
} else {
  console.log('  settled   unknown — the gate sent no PAYMENT-RESPONSE');
}

/*
  The mirror node lags consensus by a moment, so a balance read straight after
  a 200 can still show the old figure. Reported either way rather than retried:
  the settlement record above is the authoritative answer, and a script that
  polls until it agrees would just be hiding the lag.
*/
const after = await balanceOf(signer.accountId);
if (after !== null) {
  const spent = before - after;
  console.log(`  balance   ${formatHbar(after)}  (${spent > 0n ? '-' : ''}${formatHbar(spent > 0n ? spent : -spent)})`);
  if (spent <= 0n) console.log('            mirror node may not have caught up yet');
}

console.log('');
