/**
 * End-to-end against a running `wrangler dev`.
 *
 * Checks the paths a client actually walks: no capability, a bad capability, a
 * good capability with no payment, and one whose ceiling is below the price.
 * The facilitator is deliberately unreachable here, so anything that reaches it
 * proves the gate got that far — and anything refused earlier proves the gate
 * refused before spending anyone's money.
 *
 *   bun apps/gate/smoke.ts [base-url]
 */
import { mint, attenuate, serialize } from '../../packages/core/src/token';
import { deriveRootKey } from './src/env';
import { base64 } from './src/x402';

const BASE = process.argv[2] ?? 'http://127.0.0.1:8787';
const SECRET = 'dev-only-not-a-real-secret';
const ROOT = 'harsh.edgerouter.eth';

let failures = 0;
const check = (c: boolean, m: string) => {
  if (c) console.log(`  ok    ${m}`);
  else { failures += 1; console.log(`  FAIL  ${m}`); }
};

const bearer = (t: unknown) => `er_${base64(serialize(t as never))}`;
type Json = Record<string, any>;
const post = (headers: Record<string, string>, body: unknown) =>
  fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

const key = await deriveRootKey(SECRET, ROOT);
const root = await mint(key, {
  root: ROOT, node: `agent.${ROOT}`,
  ceilingMinor: 5_000n, expiresAt: Date.now() + 3_600_000,
});
const poor = await attenuate(root, [{ kind: 'ceiling', minor: 500n }]);
const expired = await mint(key, {
  root: ROOT, node: `stale.${ROOT}`,
  ceilingMinor: 5_000n, expiresAt: Date.now() - 1_000,
});

const health: Json = await fetch(`${BASE}/health`).then((r) => r.json());
check(health.ok === true, `health responds (x402=${health.x402}, upstream=${health.upstream})`);

const models = await fetch(`${BASE}/v1/models`);
const modelBody: Json = await models.json();
check(models.status === 200, 'GET /v1/models is free');
check(Array.isArray(modelBody.data) && modelBody.data.length > 0, 'models are listed with prices');

const chat = { model: 'deepseek/deepseek-chat', messages: [{ role: 'user', content: 'hi' }] };

/*
  The two halves of the access model, and the reason they differ.

  No capability is not an error: the service is permissionless, so an anonymous
  caller is quoted a price like anyone else. A capability that cannot be read or
  verified IS an error — treating it as anonymous would mean a tampered token
  silently buys what no token buys, and the holder would never learn their
  delegation had stopped working.
*/
const noCap = await post({}, chat);
check(noCap.status === 402, `no capability -> 402, not a refusal (got ${noCap.status})`);

const noCapBody: Json = await noCap.json();
check(
  Array.isArray(noCapBody.accepts) && noCapBody.accepts.length > 0,
  'an anonymous caller is quoted a real price',
);

const badCap = await post({ authorization: 'Bearer er_bm90LWEtdG9rZW4=' }, chat);
check(badCap.status === 401, `garbage capability -> 401, not anonymous (got ${badCap.status})`);

const forged = { ...root, sig: root.sig.replace(/.$/, '0') };
const forgedRes = await post({ authorization: `Bearer ${bearer(forged)}` }, chat);
check(forgedRes.status === 401, `forged signature -> 401 (got ${forgedRes.status})`);

const expiredRes = await post({ authorization: `Bearer ${bearer(expired)}` }, chat);
const expiredBody: Json = await expiredRes.json();
check(
  expiredRes.status === 403 && expiredBody.error?.code === 'policy_expires',
  `expired capability -> 403 policy_expires (got ${expiredRes.status} ${expiredBody.error?.code})`,
);

const poorRes = await post({ authorization: `Bearer ${bearer(poor)}` }, chat);
const poorBody: Json = await poorRes.json();
check(
  poorRes.status === 403 && poorBody.error?.code === 'policy_ceiling',
  `ceiling below price -> 403 policy_ceiling (got ${poorRes.status} ${poorBody.error?.code})`,
);

const unknown = await post({ authorization: `Bearer ${bearer(root)}` }, { ...chat, model: 'nope/nope' });
check(unknown.status === 400, `unknown model -> 400 (got ${unknown.status})`);

const hederaQuote = await fetch(`${BASE}/v1/chat/completions?network=hedera:testnet`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer(root)}` },
  body: JSON.stringify(chat),
});
const hQuote: Json = await hederaQuote.json();
check(hederaQuote.status === 402, `hedera quote -> 402 (got ${hederaQuote.status})`);
check(hQuote.paymentRequired?.network === 'hedera:testnet', 'hedera quote names hedera:testnet');
check(typeof hQuote.paymentRequired?.extra?.feePayer === 'string', 'hedera quote carries a feePayer');
check(
  hQuote.paymentRequired?.extra?.assetTransferMethod === undefined,
  'hedera quote carries no EVM transfer method',
);

const badNet = await fetch(`${BASE}/v1/chat/completions?network=eip155:999999`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer(root)}` },
  body: JSON.stringify(chat),
});
const badNetBody: Json = await badNet.json();
check(
  badNet.status === 400 && badNetBody.error?.code === 'unsupported_network',
  `an unconfigured network is refused (got ${badNet.status} ${badNetBody.error?.code})`,
);

const quoted = await post({ authorization: `Bearer ${bearer(root)}` }, chat);
const quote: Json = await quoted.json();
check(quoted.status === 402, `good capability, no payment -> 402 (got ${quoted.status})`);
check(quote.x402Version === 2, 'quote is x402 v2');
check(quote.paymentRequired?.amount === '1000', `quote prices the model (${quote.paymentRequired?.amount})`);
check(Boolean(quoted.headers.get('Payment-Required')), 'Payment-Required header is set');

const mismatched = base64(JSON.stringify({
  x402Version: 2, resource: quote.resource,
  accepted: { ...quote.paymentRequired, amount: '1' },
  payload: { signature: '0x00', authorization: {} },
}));
const cheat = await post(
  { authorization: `Bearer ${bearer(root)}`, 'PAYMENT-SIGNATURE': mismatched },
  chat,
);
const cheatBody: Json = await cheat.json();
check(
  cheat.status === 402 && cheatBody.error?.code === 'payment_mismatch',
  `underpaying is caught before the facilitator (got ${cheat.status} ${cheatBody.error?.code})`,
);

console.log(failures === 0 ? '\nAll smoke checks pass.' : `\n${failures} FAILED.`);
process.exit(failures === 0 ? 0 : 1);
