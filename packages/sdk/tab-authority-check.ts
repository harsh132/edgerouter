/**
 * The authority's half of tabs, checked against a fake gate.
 *
 * The fake answers one question — what became of this voucher — and each
 * scenario below sets that answer and watches the budget. What is being proved
 * is the accounting: that a reservation comes back exactly once, never for more
 * than was reserved, to the right node, and only on the gate's word.
 *
 *   bun packages/sdk/tab-authority-check.ts
 */
import { createAuthority, AuthorityRefused, type Authority } from './src/delegate/authority';
import { authorityHandler } from './src/delegate/server';
import { connectAuthority } from './src/delegate/client';
import { evmSigner } from './src/pay/evm';
import { recoverVoucherSigner } from './src/tab/voucher';

let failures = 0;
const check = (condition: boolean, message: string) => {
  if (condition) console.log(`  ok    ${message}`);
  else {
    failures += 1;
    console.log(`  FAIL  ${message}`);
  }
};

const refuses = async (label: string, work: () => Promise<unknown>, code: string) => {
  try {
    await work();
    check(false, `${label} (it was allowed)`);
  } catch (error) {
    check(error instanceof AuthorityRefused && error.code === code, `${label} — ${(error as Error).message}`);
  }
};

// A throwaway key. It signs vouchers for a fake gate and nothing else.
const key = `0x${[...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
const ARC = 'eip155:5042002';
const GATE = 'https://gate.example';
const PAY_TO = '0x3f870ECEEE0EcE3a54254C1D364230ABd14aa2d3';

/** What the fake gate says about each nonce. Unset means it has never seen it. */
const gateSays = new Map<string, { status: string; chargedMinor?: string }>();
let gateAsked = 0;
let gateDown = false;
const fakeGate: typeof fetch = (async (input: string | URL | Request) => {
  gateAsked += 1;
  if (gateDown) throw new Error('connection refused');
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
  const nonce = url.pathname.split('/').pop()!;
  // A little latency, so concurrent settles genuinely overlap.
  await new Promise((resolve) => setTimeout(resolve, 5));
  return new Response(JSON.stringify(gateSays.get(nonce) ?? { status: 'unknown' }), {
    headers: { 'content-type': 'application/json' },
  });
}) as typeof fetch;

let clock = Date.UTC(2026, 8, 13);
const now = () => clock;

const quote = { network: ARC, payTo: PAY_TO, reserveMinor: 10_000n };

const setup = async (overrides: Partial<Parameters<typeof createAuthority>[0]> = {}) => {
  const authority = await createAuthority({
    signer: evmSigner({ privateKey: key, network: ARC }),
    secret: 'tab-check',
    fundedMinor: 1_000_000n,
    tabOrigins: [GATE],
    fetch: fakeGate,
    now,
    ...overrides,
  });
  const agent = await authority.mint({
    parent: authority.rootToken,
    child: 'dev.alex.eth',
    amountMinor: 100_000n,
    expiresAt: clock + 86_400_000,
  });
  const opened = await authority.open(agent.capability);
  return { authority, agent, ...opened };
};

const balanceOf = (authority: Authority, node: string) =>
  authority.balances('root').find((entry) => entry.id === node)?.balanceMinor ?? null;

console.log('Issuing vouchers\n');

{
  const plain = await setup({ tabOrigins: [] });
  await refuses(
    'an authority with no tab origins signs no vouchers',
    () => plain.authority.voucher({ token: plain.token, policy: plain.policy, quote, resourceUrl: `${GATE}/v1/chat/completions` }),
    'tabs_disabled',
  );

  const { authority, token, policy } = await setup();
  await refuses(
    'a voucher for a gate the authority does not keep a tab with is refused',
    () => authority.voucher({ token, policy, quote, resourceUrl: 'https://evil.example/v1/chat/completions' }),
    'tab_origin_not_permitted',
  );
  await refuses(
    'a voucher on another network is refused',
    () => authority.voucher({ token, policy, quote: { ...quote, network: 'eip155:84532' }, resourceUrl: GATE }),
    'wrong_network',
  );
  await refuses(
    "a reserve above the capability's per-call ceiling is refused before the budget is looked at",
    () => authority.voucher({ token, policy, quote: { ...quote, reserveMinor: 100_001n }, resourceUrl: GATE }),
    'over_ceiling',
  );

  {
    const drained = await setup();
    for (let i = 0; i < 9; i += 1) {
      await drained.authority.voucher({ token: drained.token, policy: drained.policy, quote, resourceUrl: GATE });
    }
    await refuses(
      'a reserve larger than what the node still holds is refused',
      () =>
        drained.authority.voucher({
          token: drained.token,
          policy: drained.policy,
          quote: { ...quote, reserveMinor: 10_001n },
          resourceUrl: GATE,
        }),
      'budget_exhausted',
    );
  }

  const issued = await authority.voucher({ token, policy, quote, resourceUrl: `${GATE}/v1/chat/completions` });
  check(issued.reservedMinor === 10_000n, 'the voucher reserves the quoted ceiling');
  check(balanceOf(authority, 'dev.alex.eth') === 90_000n, "the ceiling leaves the agent's node at once");
  check(authority.spentMinor() === 10_000n, 'and counts as spent until the gate says otherwise');
  check(issued.voucher.voucher.node === 'dev.alex.eth', 'the voucher names the node that asked');
  check(issued.voucher.voucher.payee === PAY_TO, "the voucher pays the gate's own address");

  const signer = await recoverVoucherSigner(issued.voucher, 5042002);
  check(
    signer?.toLowerCase() === authority.account.toLowerCase(),
    "it is signed by the wallet's key, which the agent never holds",
  );
}

console.log('\nSettling\n');

{
  const { authority, token, policy } = await setup();
  const issued = await authority.voucher({ token, policy, quote, resourceUrl: GATE });
  const nonce = issued.voucher.voucher.nonce;

  const early = await authority.settleVoucher({ token, nonce });
  check(early.status === 'pending', 'a voucher the gate has not seen yet stays pending');
  check(balanceOf(authority, 'dev.alex.eth') === 90_000n, 'and nothing is released on a guess');

  gateSays.set(nonce, { status: 'reserved' });
  check((await authority.settleVoucher({ token, nonce })).status === 'pending', 'a call still streaming stays pending');

  gateSays.set(nonce, { status: 'charged', chargedMinor: '123' });
  const settled = await authority.settleVoucher({ token, nonce });
  check(
    settled.status === 'settled' && settled.chargedMinor === 123n && settled.releasedMinor === 9_877n,
    'once charged, the unused part of the ceiling comes back',
  );
  check(balanceOf(authority, 'dev.alex.eth') === 100_000n - 123n, 'the agent is down exactly what the call cost');
  check(authority.spentMinor() === 123n, 'and so is the authority');

  gateSays.set(nonce, { status: 'charged', chargedMinor: '0' });
  const again = await authority.settleVoucher({ token, nonce });
  check(
    again.status === 'settled' && again.chargedMinor === 123n && balanceOf(authority, 'dev.alex.eth') === 100_000n - 123n,
    'settling twice changes nothing — even if the gate now tells a different story',
  );
}

{
  const { authority, token, policy } = await setup();
  const issued = await authority.voucher({ token, policy, quote, resourceUrl: GATE });
  const nonce = issued.voucher.voucher.nonce;
  gateSays.set(nonce, { status: 'charged', chargedMinor: '500' });

  await Promise.all(Array.from({ length: 8 }, () => authority.settleVoucher({ token, nonce })));
  check(
    balanceOf(authority, 'dev.alex.eth') === 100_000n - 500n,
    'eight concurrent settles of one voucher release it once',
  );
}

{
  const { authority, token, policy } = await setup();
  const issued = await authority.voucher({ token, policy, quote, resourceUrl: GATE });
  const nonce = issued.voucher.voucher.nonce;
  gateSays.set(nonce, { status: 'charged', chargedMinor: '999999' });
  await authority.settleVoucher({ token, nonce });
  check(
    balanceOf(authority, 'dev.alex.eth') === 90_000n,
    'a gate reporting more than the ceiling is held to the ceiling',
  );
}

{
  const { authority, token, policy } = await setup();
  const issued = await authority.voucher({ token, policy, quote, resourceUrl: GATE });
  const nonce = issued.voucher.voucher.nonce;
  gateSays.set(nonce, { status: 'charged', chargedMinor: '100' });
  gateDown = true;
  check((await authority.settleVoucher({ token, nonce })).status === 'pending', 'an unreachable gate decides nothing');
  check(balanceOf(authority, 'dev.alex.eth') === 90_000n, 'and the reservation holds meanwhile');
  gateDown = false;
}

console.log('\nExpiry\n');

{
  const { authority, token, policy } = await setup();
  const never = await authority.voucher({ token, policy, quote, resourceUrl: GATE });
  const stuck = await authority.voucher({ token, policy, quote, resourceUrl: GATE });
  gateSays.set(stuck.voucher.voucher.nonce, { status: 'reserved' });

  const before = clock;
  clock += 10 * 60 * 1000 + 1_000; // past expiry, inside the grace period
  check((await authority.sweepVouchers()) === 0, 'nothing is decided inside the grace period after expiry');

  clock += 6 * 60 * 1000;
  check((await authority.sweepVouchers()) === 2, 'past it, both vouchers are decided');
  check(
    balanceOf(authority, 'dev.alex.eth') === 100_000n - 20_000n + 10_000n,
    'one never presented is released in full; one presented and never settled keeps its ceiling',
  );
  void never;
  clock = before;
}

console.log('\nRevocation\n');

{
  const { authority, token, policy } = await setup();
  const issued = await authority.voucher({ token, policy, quote, resourceUrl: GATE });
  authority.revoke({ token: authority.rootToken, node: 'dev.alex.eth' });
  const rootAfterRevoke = balanceOf(authority, 'root')!;

  gateSays.set(issued.voucher.voucher.nonce, { status: 'charged', chargedMinor: '1000' });
  await authority.settleVoucher({ token: authority.rootToken, nonce: issued.voucher.voucher.nonce });
  check(
    balanceOf(authority, 'root') === rootAfterRevoke + 9_000n,
    "a revoked agent's unused reservation returns to the node above it",
  );
  check(authority.spentMinor() === 1_000n, 'and only the real charge stays spent');
}

{
  const { authority, token, policy } = await setup();
  const sibling = await authority.mint({
    parent: authority.rootToken,
    child: 'qa.alex.eth',
    amountMinor: 1_000n,
    expiresAt: clock + 86_400_000,
  });
  const issued = await authority.voucher({ token, policy, quote, resourceUrl: GATE });
  const other = await authority.open(sibling.capability);
  await refuses(
    "one agent cannot settle another agent's voucher",
    () => authority.settleVoucher({ token: other.token, nonce: issued.voucher.voucher.nonce }),
    'not_a_descendant',
  );
}

console.log('\nOver the wire\n');

{
  const { authority, agent } = await setup();
  const handler = authorityHandler(authority);
  const connection = await connectAuthority({
    url: 'http://authority.local',
    capability: agent.capability,
    resourceUrl: `${GATE}/v1/chat/completions`,
    fetch: (async (input: string | URL | Request, init?: RequestInit) =>
      handler(new Request(typeof input === 'string' ? input : input.toString(), init))) as typeof fetch,
  });

  const issued = await connection.voucher(quote);
  check(issued.remainingMinor === 90_000n, 'a voucher is issued through the HTTP surface');

  gateSays.set(issued.voucher.voucher.nonce, { status: 'charged', chargedMinor: '42' });
  const settled = await connection.settleVoucher(issued.voucher.voucher.nonce);
  check(
    settled.status === 'settled' && settled.chargedMinor === '42' && connection.remainingMinor() === 100_000n - 42n,
    'and settled through it, with the remainder updated',
  );
}

void gateAsked;
console.log(failures === 0 ? '\nAll checks pass.' : `\n${failures} FAILED.`);
process.exit(failures === 0 ? 0 : 1);
