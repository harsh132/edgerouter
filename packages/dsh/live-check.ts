/**
 * The adapter against a real gate, with real money.
 *
 * `check.ts` proves the adapter is consistent with a fake gate, which is worth
 * exactly as much as the fake is accurate. This drives the same adapter through
 * a running gate and a real settlement, so the thing being tested is the gate's
 * actual 402 rather than my idea of one.
 *
 * Not part of `bun run check`: it spends. Same rules as `pay-check.ts` — the key
 * comes from the environment, never an argument, and is never printed.
 *
 *   HEDERA_ACCOUNT_ID=0.0.x HEDERA_PRIVATE_KEY=... \
 *   EDGEROUTER_TOKEN=$(bun apps/gate/mint-token.ts 2>/dev/null) \
 *   bun packages/dsh/live-check.ts [base-url]
 */
import type { GenerateOptions, Message, StreamChunk } from '@deepseek-ai/dsh-llm';
import { hederaSigner, formatHbar, loadOrCreateWallet } from '../sdk/src/index';
import { EdgerouterAdapter, type Paid } from './src/adapter';

const BASE = process.argv[2] ?? 'http://127.0.0.1:8789';
const ACCOUNT = process.env.HEDERA_ACCOUNT_ID;
const KEY = process.env.HEDERA_PRIVATE_KEY;
const CAPABILITY = process.env.EDGEROUTER_TOKEN;

function die(message: string): never {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

/*
  The generated wallet by default, because that is the path a user actually
  takes. The environment still wins when it is set, so CI and anyone with an
  existing funded account can drive the same check without a second wallet.
*/
let signerFor: () => ReturnType<typeof hederaSigner>;
let payer: string;

if (ACCOUNT && KEY) {
  signerFor = () => hederaSigner({ accountId: ACCOUNT, privateKey: KEY, network: 'hedera:testnet' });
  payer = `${ACCOUNT} (from the environment)`;
} else {
  const { wallet, path } = loadOrCreateWallet({ network: 'hedera:testnet' });
  const funding = await wallet.refresh();
  if (!funding.funded) {
    die(`the generated wallet has no funds — send hbar to ${wallet.evmAddress}
  stored at ${path}`);
  }
  signerFor = () => wallet.signer();
  payer = `${funding.accountId} (generated wallet, ${formatHbar(funding.balanceMinor)})`;
}
// Deliberately not required: the gate is permissionless, and running this
// without a token is the more important case to be able to test.


const paidCalls: Paid[] = [];
const adapter = new EdgerouterAdapter({
  connection: () => ({
    baseURL: BASE,
    capability: CAPABILITY ?? '',
    maxAmount: BigInt(process.env.MAX_TINYBARS ?? '100000000'),
    network: 'hedera:testnet',
    defaultContextWindow: 128_000,
  }),
  signer: async () => signerFor(),
  onPaid: (paid) => paidCalls.push(paid),
});

console.log(`\n  gate      ${BASE}`);
console.log(`  payer     ${payer}`);
console.log(`  capability ${CAPABILITY ? 'presented' : 'none — anonymous'}`);

const models = await adapter.listModels('edgerouter');
console.log(`  catalog   ${models.length} models from the gate\n`);
if (models.length === 0) die('the gate served no catalog — is it running?');

const message = (text: string): Message =>
  ({ id: 'm1', role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }) as unknown as Message;

const request = {
  provider: 'edgerouter',
  model: 'deepseek/deepseek-chat',
  system: 'Answer in one short sentence.',
  messages: [message('What is a 402 status code for?')],
} as unknown as GenerateOptions;

const chunks: StreamChunk[] = [];
const arrivals: number[] = [];
let answer = '';
const started = Date.now();
try {
  for await (const chunk of adapter.stream(request)) {
    chunks.push(chunk);
    if (chunk.type === 'text-delta') {
      answer += chunk.text;
      arrivals.push(Date.now() - started);
    }
  }
} catch (error) {
  die(`stream failed: ${(error as Error).message}`);
}

/*
  The contract, checked against a real response rather than asserted. These are
  the invariants a consumer relies on, and a live run is the only place a real
  provider can violate them.
*/
const types = chunks.map((chunk) => chunk.type);
const problems: string[] = [];
if (types.at(-1) !== 'finish') problems.push('the stream did not end in finish');
if (types.filter((t) => t === 'finish').length !== 1) problems.push('more than one finish');
const usageAt = types.indexOf('usage');
if (usageAt >= 0 && usageAt !== types.length - 2) problems.push('usage was not immediately before finish');

const usage = chunks.find((c): c is Extract<StreamChunk, { type: 'usage' }> => c.type === 'usage');
const finish = chunks.at(-1) as Extract<StreamChunk, { type: 'finish' }> | undefined;

/*
  The question this run exists to answer: did text arrive in pieces, spread over
  time? Counting deltas is not enough — a buffered response can still be handed
  over as several chunks at once. The gap between the first and last is what
  distinguishes streaming from a fast single write.
*/
const spread = arrivals.length > 1 ? arrivals.at(-1)! - arrivals[0]! : 0;
console.log(`  answer    ${answer.trim().slice(0, 160)}`);
console.log(`  deltas    ${arrivals.length}, first at ${arrivals[0] ?? '-'}ms, last at ${arrivals.at(-1) ?? '-'}ms`);
console.log(`  streamed  ${arrivals.length > 1 && spread > 50 ? `yes — spread over ${spread}ms` : 'no — arrived at once'}`);
console.log(`  chunks    ${types.join(' → ')}`);
if (usage) console.log(`  tokens    in ${usage.usage.inputTokens}, out ${usage.usage.outputTokens}`);
if (finish) console.log(`  finish    ${finish.reason.kind}`);

for (const paid of paidCalls) {
  console.log(`\n  paid      ${formatHbar(paid.amount)} on ${paid.network}`);
  console.log(`  timing    sign ${paid.signingMs}ms, call ${paid.requestMs}ms`);
  if (paid.transaction) {
    console.log(`  tx        ${paid.transaction}`);
    console.log(`  explorer  https://hashscan.io/testnet/transaction/${encodeURIComponent(paid.transaction)}`);
  }
}

if (paidCalls.length !== 1) problems.push(`expected exactly one payment, saw ${paidCalls.length}`);
if (arrivals.length < 2) problems.push('the answer arrived as a single delta — nothing streamed');
if (spread <= 50) problems.push(`all deltas landed within ${spread}ms, which is a buffered write`);
if (answer.trim().length === 0) problems.push('the model returned no text');

console.log('');
if (problems.length > 0) {
  for (const problem of problems) console.log(`  FAIL  ${problem}`);
  process.exit(1);
}
console.log('  The harness adapter paid for its own inference and obeyed the chunk contract.\n');
