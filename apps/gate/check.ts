/**
 * The gate's decisions, checked without a network.
 *
 * Everything here is a pure function over a request: parsing what a client
 * sent, deciding whether it matches what we quoted, and deriving the key a
 * capability verifies against. The parts that genuinely need the outside world
 * — the facilitator and the upstream — are exercised by `smoke.ts` against a
 * running `wrangler dev`, not faked here.
 *
 *   bun apps/gate/check.ts
 */
import { mint, attenuate, serialize } from '../../packages/core/src/token';
import { deriveRootKey } from './src/env';
import {
  HEADER,
  X402_VERSION,
  base64,
  matchesQuote,
  parsePayment,
  requirements,
  unbase64,
  type Requirements,
} from './src/x402';
import { priceFor, MODELS } from './src/pricing';

let failures = 0;
const pass = (m: string) => console.log(`  ok    ${m}`);
const fail = (m: string) => {
  failures += 1;
  console.log(`  FAIL  ${m}`);
};
const check = (c: boolean, m: string) => (c ? pass(m) : fail(m));

/* -------------------------------------------------------------------------- */
/* 1. Wire format matches the specification                                    */
/* -------------------------------------------------------------------------- */

console.log('x402 v2 wire format\n');

const REQUEST = new Request('https://gate.edgerouter.io/v1/chat/completions', { method: 'POST' });

const reqs = requirements({
  request: REQUEST,
  amountMinor: 1_000n,
  description: 'edgerouter inference: deepseek/deepseek-chat',
  config: {
    network: 'eip155:84532',
    asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    payTo: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C',
    assetName: 'USDC',
    assetVersion: '2',
    maxTimeoutSeconds: 60,
  },
});

check(reqs.x402Version === 2, 'x402Version is 2, not 1');
check(HEADER.signature === 'PAYMENT-SIGNATURE', 'client header is PAYMENT-SIGNATURE');
check(HEADER.response === 'PAYMENT-RESPONSE', 'settlement header is PAYMENT-RESPONSE');
check(HEADER.required === 'Payment-Required', 'quote header is Payment-Required');
check(reqs.paymentRequired.scheme === 'exact', 'scheme is exact');
check(typeof reqs.paymentRequired.amount === 'string', 'amount is a string, preserving precision');
check(reqs.paymentRequired.network.startsWith('eip155:'), 'network is EIP-155 form');
check(
  reqs.paymentRequired.extra.assetTransferMethod === 'eip3009',
  'transfer method defaults to eip3009',
);
check(
  Object.hasOwn(reqs, 'resource') && Object.hasOwn(reqs, 'paymentRequired'),
  'body is { x402Version, resource, paymentRequired }',
);

check(unbase64(base64('hello ünïcode')) === 'hello ünïcode', 'base64 round-trips non-ASCII');
check(unbase64('!!!not base64!!!') === null, 'malformed base64 returns null');

/* -------------------------------------------------------------------------- */
/* 2. Payment parsing refuses anything it did not fully understand             */
/* -------------------------------------------------------------------------- */

console.log('\nPayment parsing\n');

const validPayment = {
  x402Version: X402_VERSION,
  resource: reqs.resource,
  accepted: reqs.paymentRequired,
  payload: {
    signature: `0x${'ab'.repeat(65)}`,
    authorization: {
      from: '0x857b06519E91e3A54538791bDbb0E22373e36b66',
      to: reqs.paymentRequired.payTo,
      value: '1000',
      validAfter: '1740672089',
      validBefore: '1740672154',
      nonce: `0x${'11'.repeat(32)}`,
    },
  },
};

const encoded = base64(JSON.stringify(validPayment));
check(parsePayment(encoded) !== null, 'a well-formed payment parses');
check(parsePayment(null) === null, 'a missing header parses to null');
check(parsePayment('not-base64!!') === null, 'non-base64 is refused');
check(parsePayment(base64('not json')) === null, 'non-JSON is refused');
check(parsePayment(base64('{}')) === null, 'an empty object is refused');

for (const [label, mutate] of [
  ['a non-exact scheme', (p: any) => (p.accepted.scheme = 'upto')],
  ['a non-numeric amount', (p: any) => (p.accepted.amount = '1e3')],
  ['a numeric amount as a number', (p: any) => (p.accepted.amount = 1000)],
  ['a missing payload', (p: any) => delete p.payload],
  ['a missing version', (p: any) => delete p.x402Version],
] as const) {
  const broken = JSON.parse(JSON.stringify(validPayment));
  mutate(broken);
  check(parsePayment(base64(JSON.stringify(broken))) === null, `refused: ${label}`);
}

/* -------------------------------------------------------------------------- */
/* 3. The quote check — the one a facilitator cannot do for us                 */
/* -------------------------------------------------------------------------- */

console.log('\nQuote matching\n');

const parsed = parsePayment(encoded)!;
check(matchesQuote(parsed, reqs), 'a payment on our terms matches');

const overpaid = JSON.parse(JSON.stringify(validPayment));
overpaid.accepted.amount = '2000';
check(matchesQuote(parsePayment(base64(JSON.stringify(overpaid)))!, reqs), 'overpaying is accepted');

/*
  Each of these is a payload a facilitator would happily verify — the signature
  is valid for the terms *inside it*. Only the resource server knows those terms
  are not the ones it quoted.
*/
for (const [label, mutate] of [
  ['underpaying by one unit', (p: any) => (p.accepted.amount = '999')],
  ['paying on another chain', (p: any) => (p.accepted.network = 'eip155:1')],
  ['paying in another token', (p: any) => (p.accepted.asset = `0x${'99'.repeat(20)}`)],
  ['paying someone else', (p: any) => (p.accepted.payTo = `0x${'42'.repeat(20)}`)],
] as const) {
  const cheated = JSON.parse(JSON.stringify(validPayment));
  mutate(cheated);
  const p = parsePayment(base64(JSON.stringify(cheated)));
  check(p !== null && !matchesQuote(p, reqs), `rejected: ${label}`);
}

const caseChanged = JSON.parse(JSON.stringify(validPayment));
caseChanged.accepted.payTo = (reqs.paymentRequired.payTo as string).toUpperCase();
caseChanged.accepted.asset = (reqs.paymentRequired.asset as string).toLowerCase();
check(
  matchesQuote(parsePayment(base64(JSON.stringify(caseChanged)))!, reqs),
  'address comparison is case-insensitive',
);

/* -------------------------------------------------------------------------- */
/* 4. Root keys are derived, distinct, and stable                              */
/* -------------------------------------------------------------------------- */

console.log('\nRoot key derivation\n');

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

const keyA = await deriveRootKey('service-secret', 'harsh.edgerouter.eth');
const keyA2 = await deriveRootKey('service-secret', 'harsh.edgerouter.eth');
const keyB = await deriveRootKey('service-secret', 'someone.edgerouter.eth');
const keyOther = await deriveRootKey('different-secret', 'harsh.edgerouter.eth');

check(hex(keyA) === hex(keyA2), 'derivation is deterministic');
check(hex(keyA) !== hex(keyB), 'two roots get different keys');
check(hex(keyA) !== hex(keyOther), 'a different service secret gives a different key');
check(keyA.length === 32, 'the key is 32 bytes');

/*
  The property that matters: a capability minted for one root must not verify
  against another. Without distinct derived keys, every user could spend every
  other user's budget.
*/
const tokenA = await mint(keyA, {
  root: 'harsh.edgerouter.eth',
  node: 'agent.harsh.edgerouter.eth',
  ceilingMinor: 5_000n,
  expiresAt: Date.now() + 3_600_000,
});
const { verify: verifyToken } = await import('../../packages/core/src/token');
check((await verifyToken(keyA, 'harsh.edgerouter.eth', tokenA)).ok, 'a token verifies under its own root');
check(
  !(await verifyToken(keyB, 'harsh.edgerouter.eth', tokenA)).ok,
  "a token does not verify under another root's key",
);

/* -------------------------------------------------------------------------- */
/* 5. Bearer encoding, as a client will actually send it                       */
/* -------------------------------------------------------------------------- */

console.log('\nBearer encoding\n');

const child = await attenuate(tokenA, [{ kind: 'ceiling', minor: 1_000n }]);
const bearer = `er_${base64(serialize(child))}`;
check(bearer.startsWith('er_'), 'bearer carries the er_ prefix');
check(bearer.length < 8_000, `bearer fits in a header (${bearer.length} chars)`);

/* -------------------------------------------------------------------------- */
/* 6. Pricing refuses to guess                                                 */
/* -------------------------------------------------------------------------- */

console.log('\nPricing\n');

check(priceFor('deepseek/deepseek-chat') === 1_000n, 'a known model has a price');
check(priceFor('not/a-model') === null, 'an unknown model has no default price');
check(MODELS.every((m) => m.minorPerCall > 0n), 'every listed model costs something');

console.log(failures === 0 ? '\nAll checks pass.' : `\n${failures} FAILED.`);
process.exit(failures === 0 ? 0 : 1);
