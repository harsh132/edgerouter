/**
 * Delegation with real money, against the real gate.
 *
 * `delegate-check.ts` proves the authority is self-consistent. This proves the
 * thing that actually matters and cannot be faked: a sub-agent that holds no
 * key, talking to a real authority over a real socket, buying real inference
 * from the deployed gate — and being stopped by its budget rather than by
 * anything it agreed to.
 *
 * The last part is the point. A cap a sub-agent enforces on itself is not a
 * cap; the refusal has to come from the side holding the money.
 *
 *   bun packages/sdk/delegate-live-check.ts [gate-url]
 *
 * Pays from the one wallet, the same one the crew spends from. It spends. Not
 * part of `bun run check`.
 */
import {
  createAuthority,
  authorityHandler,
  connectAuthority,
  loadOrCreateWallet,
  payAndFetch,
  formatHbar,
  AuthorityDenied,
  type PaymentSigner,
} from './src/index';

declare const Bun: {
  serve(options: {
    port: number;
    hostname: string;
    fetch: (request: Request) => Promise<Response>;
  }): { stop(): void };
};

const GATE = process.argv[2] ?? 'https://edgerouter-gate.prakashharsh32.workers.dev';
const PORT = 8791;
const NETWORK = 'hedera:testnet';

function die(message: string): never {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

const { wallet } = loadOrCreateWallet({ network: NETWORK });
const funding = await wallet.refresh();
if (!funding.funded) die(`the wallet has no funds — send hbar to ${wallet.evmAddress}`);

const signer: PaymentSigner = wallet.signer();
const payerNote = `${funding.accountId} (${formatHbar(funding.balanceMinor)})`;

/*
  A budget deliberately smaller than three calls cost. The interesting moment
  is the refusal, and a budget that never runs out would not produce one.
*/
const PRICE_GUESS = 1_234_000n; // roughly what one call has been costing
const BUDGET = PRICE_GUESS * 2n + PRICE_GUESS / 2n;

const authority = await createAuthority({
  signer,
  secret: crypto.randomUUID(),
  fundedMinor: BUDGET,
});

const server = Bun.serve({
  port: PORT,
  hostname: '127.0.0.1',
  fetch: authorityHandler(authority),
});

console.log(`\n  gate       ${GATE}`);
console.log(`  authority  http://127.0.0.1:${PORT}`);
console.log(`  paying     ${payerNote}`);
console.log(`  allowance  ${formatHbar(BUDGET)} — under three calls' worth, on purpose\n`);

const granted = await authority.mint({
  parent: authority.rootToken,
  child: 'sub-agent',
  amountMinor: BUDGET,
  expiresAt: Date.now() + 10 * 60 * 1000,
});
console.log(`  ok    delegated an allowance to "sub-agent"`);

/*
  From here nothing knows a key exists. The sub-agent has a URL and a bearer
  string, and its signer is the ordinary PaymentSigner interface — which is the
  whole claim: the paying client did not have to be written differently.
*/
const connection = await connectAuthority({
  url: `http://127.0.0.1:${PORT}`,
  capability: granted.capability,
  resourceUrl: GATE,
});
console.log(`  ok    the sub-agent connected, and holds no key`);
console.log(`  ok    it pays from ${connection.account}, which it does not control\n`);

const ask = (n: number) =>
  payAndFetch(new URL('/v1/chat/completions', GATE).toString(), {
    signer: connection.signer,
    maxAmount: 100_000_000n,
    init: {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek/deepseek-chat',
        messages: [{ role: 'user', content: `Reply with only the number ${n}.` }],
      }),
    },
  });

let paid = 0;
let refusal: AuthorityDenied | null = null;

for (let n = 1; n <= 3; n += 1) {
  try {
    const result = await ask(n);
    if (result.response.status !== 200) {
      const text = await result.response.text();
      die(`call ${n} failed with ${result.response.status}: ${text.slice(0, 200)}`);
    }
    paid += 1;
    const spent = result.quote ? BigInt(result.quote.amount) : 0n;
    console.log(
      `  call ${n}   paid ${formatHbar(spent)}, ${formatHbar(connection.remainingMinor() ?? 0n)} left`,
    );
  } catch (error) {
    if (error instanceof AuthorityDenied) {
      refusal = error;
      console.log(`  call ${n}   REFUSED by the authority — ${error.code}: ${error.message}`);
      break;
    }
    die(`call ${n} threw something unexpected: ${(error as Error).message}`);
  }
}

server.stop();

const problems: string[] = [];
if (paid === 0) problems.push('the sub-agent never managed to pay for anything');
if (!refusal) problems.push('the budget never ran out, so nothing proved it binds');
if (refusal && refusal.code !== 'budget_exhausted') {
  problems.push(`the refusal was ${refusal.code}, not budget_exhausted`);
}

const remaining = authority.balances('sub-agent')[0]?.balanceMinor ?? 0n;
if (remaining >= PRICE_GUESS) problems.push('the allowance was not actually drawn down');
if (authority.spentMinor() > BUDGET) problems.push('more was spent than was ever delegated');

console.log('');
if (problems.length > 0) {
  for (const problem of problems) console.log(`  FAIL  ${problem}`);
  process.exit(1);
}

console.log(`  ok    ${paid} calls bought, then the allowance stopped the next one`);
console.log(`  ok    spent ${formatHbar(authority.spentMinor())} of ${formatHbar(BUDGET)} delegated`);
console.log('\n  A sub-agent with no key spent someone else’s money, up to a limit it');
console.log('  could not raise, and was stopped by the side that holds the wallet.\n');
