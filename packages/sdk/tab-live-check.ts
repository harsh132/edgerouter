/**
 * A tab, end to end, with real money on Arc testnet.
 *
 *   top up  →  voucher  →  streamed call  →  receipt  →  the gate's own record
 *
 * Pays from the one wallet (`~/.edgerouter/wallet.json`), which must hold a
 * deposited Gateway balance on Arc. It spends testnet USDC: a top-up, and one
 * call charged out of it. Not part of `bun run check`.
 *
 *   bun packages/sdk/tab-live-check.ts [gate-url]
 *
 * Signs its own voucher with the wallet key rather than going through an
 * authority — `tab-authority-check.ts` covers the authority against a fake
 * gate. What only a live run can prove is the part neither fake can: that the
 * gate's Durable Object, OpenRouter's usage report and Circle's settlement
 * agree with each other.
 */
import {
  ARC_TESTNET,
  evmSigner,
  fetchTabTerms,
  formatUsdc,
  gatewayFunding,
  loadOrCreateEvmWallet,
  payAndFetch,
  payFromTab,
  newNonce,
  signVoucher,
  encodeVoucher,
  TAB_HEADER,
  type SignedVoucher,
} from './src/index';

const GATE = process.argv[2] ?? 'http://127.0.0.1:8787';
const TOPUP_MINOR = 20_000n; // $0.02 — two calls at the largest reserve

let failures = 0;
const check = (condition: boolean, message: string) => {
  if (condition) console.log(`  ok    ${message}`);
  else {
    failures += 1;
    console.log(`  FAIL  ${message}`);
  }
};
function die(message: string): never {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

const { wallet, path } = loadOrCreateEvmWallet({ network: ARC_TESTNET });
const privateKey = wallet.exportPrivateKey();
const signer = evmSigner({ privateKey, network: ARC_TESTNET });
const funding = await gatewayFunding({ privateKey, network: ARC_TESTNET, address: wallet.address });

console.log(`\n  gate      ${GATE}`);
console.log(`  payer     ${wallet.address}`);
console.log(`  gateway   ${formatUsdc(funding.availableMinor)} available`);

const terms = await fetchTabTerms(GATE, ARC_TESTNET);
if (!terms) die(`${GATE} keeps no tab on ${ARC_TESTNET} — is the TAB binding deployed?`);
console.log(`  payTo     ${terms.payTo}`);
console.log(`  reserves  ${[...terms.reserves].map(([id, minor]) => `${id} ${formatUsdc(minor)}`).join(', ')}\n`);

const tabBalance = async (): Promise<bigint> => {
  const url = new URL('/v1/tab', GATE);
  url.searchParams.set('payer', wallet.address);
  url.searchParams.set('network', ARC_TESTNET);
  const body = (await (await fetch(url)).json()) as { balanceMinor?: string };
  return BigInt(body.balanceMinor ?? '0');
};

const before = await tabBalance();
console.log(`  tab       ${formatUsdc(before)} before\n`);

/* ---------------------------------------------------------------- top up */

if (before < 10_000n) {
  if (funding.availableMinor < TOPUP_MINOR) {
    die(`the Gateway balance cannot cover a ${formatUsdc(TOPUP_MINOR)} top-up — deposit USDC for ${wallet.address}
  wallet stored at ${path}`);
  }
  const topupUrl = new URL('/v1/tab/topup', GATE);
  topupUrl.searchParams.set('amount', TOPUP_MINOR.toString());
  const topped = await payAndFetch(topupUrl.toString(), {
    signer,
    network: ARC_TESTNET,
    maxAmount: TOPUP_MINOR,
    init: { method: 'POST' },
  });
  const body = (await topped.response.json()) as { creditedMinor?: string; balanceMinor?: string; error?: unknown };
  check(topped.response.ok, `a top-up settles through Gateway (${topped.response.status}) ${topped.response.ok ? '' : JSON.stringify(body)}`);
  check(body.creditedMinor === TOPUP_MINOR.toString(), `and credits exactly what was paid (${body.creditedMinor})`);
  check((await tabBalance()) === before + TOPUP_MINOR, 'the tab holds it');
}

/* ------------------------------------------------------------- one call */

const model = 'deepseek/deepseek-v4-flash';
const reserve = terms.reserves.get(model)!;
const atCall = await tabBalance();

/*
  Kept so it can be presented a second time below. A voucher is spendable once,
  and the only honest test of that is spending the same one again.
*/
let presented: SignedVoucher | null = null;

const paid = await payFromTab(new URL('/v1/chat/completions', GATE).toString(), {
  terms,
  init: {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: true,
      messages: [{ role: 'user', content: 'Reply with the single word: tabbed.' }],
    }),
  },
  voucherFor: async (quote) => {
    presented = await signVoucher(signer.voucherSigner!, {
      chainId: 5042002,
      voucher: {
        payee: quote.payTo as `0x${string}`,
        nonce: newNonce(),
        maxAmount: quote.reserveMinor.toString(),
        expiresAt: Math.floor(Date.now() / 1000) + 300,
        node: 'tab-live-check',
      },
    });
    return presented;
  },
});

check(paid.response.ok, `a call paid by voucher is served (${paid.response.status})`);

// Read the stream to the end, the way an agent loop would, keeping only the words.
let answer = '';
let usageCost: number | null = null;
const reader = paid.response.body!.getReader();
const decoder = new TextDecoder();
let partial = '';
for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  const lines = (partial + decoder.decode(value, { stream: true })).split('\n');
  partial = lines.pop() ?? '';
  for (const line of lines) {
    if (!line.startsWith('data:') || line.includes('[DONE]')) continue;
    try {
      const event = JSON.parse(line.slice(5)) as {
        choices?: { delta?: { content?: string } }[];
        usage?: { cost?: number };
      };
      answer += event.choices?.[0]?.delta?.content ?? '';
      if (typeof event.usage?.cost === 'number') usageCost = event.usage.cost;
    } catch {
      /* not every data line is JSON */
    }
  }
}

const receipt = await paid.receipt;
console.log(`\n  answer    ${answer.trim().slice(0, 60)}`);
console.log(`  reserved  ${formatUsdc(reserve)}`);
console.log(`  upstream  $${usageCost ?? '?'}`);
console.log(`  charged   ${receipt ? formatUsdc(BigInt(receipt.chargedMinor)) : '(no receipt)'}\n`);

check(receipt !== null, 'the stream ends with a receipt');
check(receipt !== null && BigInt(receipt.chargedMinor) < reserve, 'the charge is below the ceiling — the tab paid for what was used');
if (usageCost !== null && receipt) {
  check(
    BigInt(receipt.chargedMinor) === BigInt(Math.ceil(Math.round(usageCost * 1e12) / 1e6)),
    "the charge is OpenRouter's reported cost, in USDC base units, rounded up",
  );
}

const after = await tabBalance();
check(receipt !== null && after === atCall - BigInt(receipt.chargedMinor), 'the tab fell by exactly the charge');

const stateUrl = new URL(`/v1/tab/vouchers/${paid.nonce}`, GATE);
stateUrl.searchParams.set('payer', wallet.address);
stateUrl.searchParams.set('network', ARC_TESTNET);
const state = (await (await fetch(stateUrl)).json()) as { status?: string; chargedMinor?: string };
check(state.status === 'charged' && state.chargedMinor === receipt?.chargedMinor, "the gate's record agrees with the receipt");

/* ------------------------------------------------------------- replay */

const beforeReplay = await tabBalance();
const replayed = await fetch(new URL('/v1/chat/completions', GATE), {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'X-Payment-Network': ARC_TESTNET,
    [TAB_HEADER.voucher]: encodeVoucher(presented!),
  },
  body: JSON.stringify({ model, messages: [{ role: 'user', content: 'again' }] }),
});
const replayBody = (await replayed.json().catch(() => null)) as { error?: { code?: string } } | null;
check(
  replayed.status === 402 && replayBody?.error?.code === 'voucher_used',
  `the same voucher presented twice is refused as used (${replayed.status} ${replayBody?.error?.code ?? ''})`,
);
check((await tabBalance()) === beforeReplay, 'and the refused replay took nothing from the tab');

console.log(`\n  tab       ${formatUsdc(after)} after`);
console.log(failures === 0 ? '\n  All checks pass.\n' : `\n  ${failures} FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
