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
import { hederaSigner, formatHbar } from '../sdk/src/index';
import { EdgerouterAdapter, type Paid } from './src/adapter';

const BASE = process.argv[2] ?? 'http://127.0.0.1:8789';
const ACCOUNT = process.env.HEDERA_ACCOUNT_ID;
const KEY = process.env.HEDERA_PRIVATE_KEY;
const CAPABILITY = process.env.EDGEROUTER_TOKEN;

function die(message: string): never {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

if (!ACCOUNT) die('set HEDERA_ACCOUNT_ID to the payer account');
if (!KEY) die('set HEDERA_PRIVATE_KEY in the environment — never as an argument');
if (!CAPABILITY) die('set EDGEROUTER_TOKEN — run: bun apps/gate/mint-token.ts');

const paidCalls: Paid[] = [];
const adapter = new EdgerouterAdapter({
  connection: () => ({
    baseURL: BASE,
    capability: CAPABILITY,
    maxAmount: BigInt(process.env.MAX_TINYBARS ?? '100000000'),
    network: 'hedera:testnet',
    defaultContextWindow: 128_000,
  }),
  signer: () => hederaSigner({ accountId: ACCOUNT, privateKey: KEY, network: 'hedera:testnet' }),
  onPaid: (paid) => paidCalls.push(paid),
});

console.log(`\n  gate      ${BASE}`);
console.log(`  payer     ${ACCOUNT}`);

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
let answer = '';
try {
  for await (const chunk of adapter.stream(request)) {
    chunks.push(chunk);
    if (chunk.type === 'text-delta') answer += chunk.text;
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

console.log(`  answer    ${answer.trim().slice(0, 160)}`);
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
if (answer.trim().length === 0) problems.push('the model returned no text');

console.log('');
if (problems.length > 0) {
  for (const problem of problems) console.log(`  FAIL  ${problem}`);
  process.exit(1);
}
console.log('  The harness adapter paid for its own inference and obeyed the chunk contract.\n');
