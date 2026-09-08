/**
 * The payment loop, checked without money.
 *
 * Every refusal in `selectRequirement` is a control the caller is relying on,
 * so each one is exercised here against a fake server and a signer that records
 * what it was asked to sign rather than signing it. What this cannot prove is
 * that a real Hedera transaction settles — that is `pay-check.ts`, which needs
 * a funded account and is run by hand.
 *
 *   bun packages/sdk/check.ts
 */
import {
  base64,
  unbase64,
  payAndFetch,
  selectRequirement,
  readSettlement,
  PaymentRefused,
  formatHbar,
  parsePrivateKey,
  type PaymentRequired,
  type PaymentRequirements,
  type PaymentSigner,
} from './src/index';

let failures = 0;
const check = (condition: boolean, message: string) => {
  if (condition) console.log(`  ok    ${message}`);
  else {
    failures += 1;
    console.log(`  FAIL  ${message}`);
  }
};
const section = (name: string) => console.log(`\n${name}\n`);

/** Asserts that a call refuses, and refuses for the stated reason. */
const refuses = async (reason: string, message: string, run: () => unknown) => {
  try {
    await run();
    check(false, `${message} (nothing was refused)`);
  } catch (error) {
    const actual = error instanceof PaymentRefused ? error.reason : `threw ${String(error)}`;
    check(actual === reason, `${message} (${actual})`);
  }
};

const PAYER = '0.0.1001';
const RECIPIENT = '0.0.2002';

const hederaQuote = (over: Partial<PaymentRequirements> = {}): PaymentRequirements => ({
  scheme: 'exact',
  network: 'hedera:testnet',
  amount: '1000',
  asset: '0.0.0',
  payTo: RECIPIENT,
  maxTimeoutSeconds: 180,
  extra: { feePayer: '0.0.7162784' },
  ...over,
});

const required = (accepts: PaymentRequirements[]): PaymentRequired => ({
  x402Version: 2,
  resource: { url: 'https://gate.test/v1/chat/completions', description: 'test' },
  accepts,
});

const pick = (r: PaymentRequired, maxAmount = 10_000n) =>
  selectRequirement(r, { network: 'hedera:testnet', maxAmount, payerAccountId: PAYER });

/* ------------------------------------------------------------------ base64 */

section('Encoding');

const sample = JSON.stringify({ hello: 'wörld', n: 1 });
check(unbase64(base64(sample)) === sample, 'base64 round-trips non-ASCII');
check(unbase64('not valid base64 !!!') === null, 'undecodable input is null, not a throw');

/* ------------------------------------------------------------- quote choice */

section('Choosing a quote');

check(pick(required([hederaQuote()])).payTo === RECIPIENT, 'a single matching quote is chosen');

check(
  pick(required([{ ...hederaQuote(), network: 'eip155:80002' }, hederaQuote()])).network ===
    'hedera:testnet',
  'the right network is picked out of a mixed list',
);

check(
  pick(required([hederaQuote({ amount: '5000' }), hederaQuote({ amount: '900' })])).amount ===
    '900',
  'the cheapest of two same-network quotes wins, whatever the order',
);

await refuses('no_matching_network', 'a quote on another chain is refused', () =>
  pick(required([{ ...hederaQuote(), network: 'eip155:80002' }])),
);

await refuses('no_matching_network', 'a non-exact scheme is refused', () =>
  pick(required([hederaQuote({ scheme: 'upto' })])),
);

await refuses('bad_quote', 'an empty accepts list is refused', () => pick(required([])));

await refuses('bad_quote', 'a missing accepts list is refused', () =>
  pick({ x402Version: 2, resource: { url: 'x' } } as PaymentRequired),
);

await refuses('bad_quote', 'a non-integer amount is refused', () =>
  pick(required([hederaQuote({ amount: '1.5' })])),
);

await refuses('bad_quote', 'a zero amount is refused', () =>
  pick(required([hederaQuote({ amount: '0' })])),
);

await refuses('over_max_amount', 'a quote above the cap is refused', () =>
  pick(required([hederaQuote({ amount: '10001' })]), 10_000n),
);

check(
  pick(required([hederaQuote({ amount: '10000' })]), 10_000n).amount === '10000',
  'a quote exactly at the cap is allowed',
);

await refuses('self_payment', 'paying your own account is refused', () =>
  pick(required([hederaQuote({ payTo: PAYER })])),
);

/* --------------------------------------------------------- the payment loop */

section('The 402 loop');

/** A signer that records rather than signs. */
const recordingSigner = (): PaymentSigner & { seen: PaymentRequirements[] } => {
  const seen: PaymentRequirements[] = [];
  return {
    network: 'hedera:testnet',
    accountId: PAYER,
    seen,
    async createPayload(_version, requirements) {
      seen.push(requirements);
      return { transaction: 'ZmFrZS10cmFuc2FjdGlvbg==' };
    },
  };
};

/** A server that answers 402 once, then 200 if a payment header arrives. */
const gate = (options: { settlement?: unknown } = {}) => {
  const calls: Array<{ headers: Record<string, string> }> = [];
  const handler = async (_url: string, init?: RequestInit): Promise<Response> => {
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>),
    );
    calls.push({ headers });

    if (!headers['PAYMENT-SIGNATURE']) {
      return new Response(JSON.stringify(required([hederaQuote()])), {
        status: 402,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'PAYMENT-RESPONSE': base64(JSON.stringify(options.settlement ?? { success: true })),
      },
    });
  };
  return { handler: handler as unknown as typeof fetch, calls };
};

{
  const signer = recordingSigner();
  const server = gate({ settlement: { success: true, transaction: '0.0.1@1.2' } });
  const result = await payAndFetch('https://gate.test/v1/chat/completions', {
    signer,
    maxAmount: 10_000n,
    fetch: server.handler,
  });

  check(result.attempts === 2, 'a 402 becomes two requests');
  check(result.response.status === 200, 'the second request is served');
  check(signer.seen.length === 1, 'the signer was asked exactly once');
  check(signer.seen[0]?.payTo === RECIPIENT, 'the signer got the quote that was chosen');
  check(result.quote?.amount === '1000', 'the paid quote is reported back');
  check(
    server.calls[0]?.headers['PAYMENT-SIGNATURE'] === undefined,
    'the first request carries no payment',
  );

  /*
    Both requests say which network they want. Without this the gate quotes its
    own default, a client configured for another chain refuses that quote as
    unpayable, and the error reads as the server offering the wrong thing —
    when the question was simply never asked. The paid retry carries it for a
    sharper reason: re-quoting the default there would have the gate check the
    signature against terms nobody signed.
  */
  check(
    server.calls[0]?.headers['X-Payment-Network'] === signer.network,
    'the first request asks for the signer’s network',
  );
  check(
    server.calls[1]?.headers['X-Payment-Network'] === signer.network,
    'and the paid request asks for the same one',
  );

  const sent = server.calls[1]?.headers['PAYMENT-SIGNATURE'];
  const decoded = sent ? JSON.parse(unbase64(sent)!) : null;
  check(decoded?.x402Version === 2, 'the payload declares x402 v2');
  check(decoded?.accepted?.payTo === RECIPIENT, 'the payload echoes the accepted requirement');
  check(decoded?.payload?.transaction !== undefined, 'the Hedera payload carries a transaction');
  check(
    decoded?.accepted !== undefined && decoded?.paymentRequired === undefined,
    'the payload uses `accepted`, not the envelope',
  );

  check(result.settlement?.success === true, 'PAYMENT-RESPONSE is decoded');
  check(typeof result.signingMs === 'number', 'signing time is measured');
}

{
  const signer = recordingSigner();
  const free = (async () =>
    new Response(JSON.stringify({ ok: true }), { status: 200 })) as unknown as typeof fetch;
  const result = await payAndFetch('https://gate.test/v1/models', {
    signer,
    maxAmount: 1n,
    fetch: free,
  });
  check(result.attempts === 1, 'a free resource costs one request');
  check(result.quote === null, 'nothing is quoted when nothing is owed');
  check(signer.seen.length === 0, 'the signer is never called for a free resource');
}

{
  const signer = recordingSigner();
  const expensive = (async () =>
    new Response(JSON.stringify(required([hederaQuote({ amount: '999999' })])), {
      status: 402,
    })) as unknown as typeof fetch;

  await refuses('over_max_amount', 'the cap stops the loop before signing', () =>
    payAndFetch('https://gate.test/v1/chat/completions', {
      signer,
      maxAmount: 1_000n,
      fetch: expensive,
    }),
  );
  check(signer.seen.length === 0, 'nothing was signed when the cap was exceeded');
}

check(
  readSettlement(new Response('', { status: 200 })) === null,
  'a missing PAYMENT-RESPONSE is null, not a throw',
);

/* ----------------------------------------------------------------- helpers */

section('Hedera helpers');

check(formatHbar(100_000_000n) === '1 ℏ', 'one HBAR formats as one');
check(formatHbar(1n) === '0.00000001 ℏ', 'one tinybar keeps its precision');
check(formatHbar(150_000_000n) === '1.5 ℏ', 'trailing zeros are trimmed');

let keyRejected = false;
try {
  parsePrivateKey('not-a-key');
} catch (error) {
  keyRejected = true;
  check(!String(error).includes('not-a-key'), 'a bad key error does not echo the key back');
}
check(keyRejected, 'a malformed private key is rejected');

console.log(failures === 0 ? '\nAll checks pass.' : `\n${failures} FAILED.`);
if (failures > 0) process.exit(1);
