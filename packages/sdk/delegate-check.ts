/**
 * Delegation, checked without money.
 *
 * The authority is the one component that can lose funds by being wrong, so
 * every refusal it can produce is exercised here, plus the two properties that
 * are not any single refusal:
 *
 *   attenuation never widens   — a child is bounded by its parent, always
 *   conservation holds         — held + spent equals funded, after every step
 *
 * The signer is a fake that records what it was asked to sign. That is enough,
 * because the authority's job is deciding *whether* to sign; whether the bytes
 * settle is `pay-check.ts` and a funded account.
 *
 *   bun packages/sdk/delegate-check.ts
 */
import {
  createAuthority,
  authorityHandler,
  connectAuthority,
  AuthorityRefused,
  AuthorityDenied,
  payAndFetch,
  type Authority,
  type PaymentRequirements,
  type PaymentSigner,
} from './src/index';
import { attenuate, deserialize, serialize } from '../core/src/token';
import { policyOf, isNarrowerOrEqual } from '../core/src/caveat';

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
const refuses = async (code: string, message: string, run: () => unknown) => {
  try {
    await run();
    check(false, `${message} (nothing was refused)`);
  } catch (error) {
    const actual =
      error instanceof AuthorityRefused || error instanceof AuthorityDenied
        ? error.code
        : `threw ${String(error)}`;
    check(actual === code, `${message} (${actual})`);
  }
};

const PAYER = '0.0.1001';
const RECIPIENT = '0.0.2002';
const NETWORK = 'hedera:testnet';
const SECRET = 'a-secret-that-is-long-enough-to-be-a-secret';
const HOUR = 60 * 60 * 1000;

let signedFor: PaymentRequirements[] = [];
const fakeSigner: PaymentSigner = {
  network: NETWORK,
  accountId: PAYER,
  async createPayload(_version, requirements) {
    signedFor.push(requirements);
    return { transaction: `signed:${requirements.amount}` };
  },
};

const quote = (over: Partial<PaymentRequirements> = {}): PaymentRequirements => ({
  scheme: 'exact',
  network: NETWORK,
  amount: '1000',
  asset: '0.0.0',
  payTo: RECIPIENT,
  maxTimeoutSeconds: 180,
  extra: { feePayer: '0.0.7162784' },
  ...over,
});

const authorityWith = (over: Partial<Parameters<typeof createAuthority>[0]> = {}) =>
  createAuthority({
    signer: fakeSigner,
    secret: SECRET,
    fundedMinor: 100_000n,
    ...over,
  });

/* ------------------------------------------------------------------ minting */

section('Minting');

let authority = await authorityWith();
const rootOpened = await authority.open(authority.rootCapability);
check(rootOpened.token.node === 'root', 'the root capability opens as the root node');

const child = await authority.mint({
  parent: authority.rootToken,
  child: 'researcher',
  amountMinor: 10_000n,
  expiresAt: Date.now() + HOUR,
});
check(child.capability.startsWith('er_'), 'a minted capability is a bearer string');
check(child.amountMinor === 10_000n, 'the child was funded with what was asked');

const balances = authority.balances('root');
const rootBalance = balances.find((entry) => entry.id === 'root')!.balanceMinor;
const childBalance = balances.find((entry) => entry.id === 'researcher')!.balanceMinor;
check(rootBalance === 90_000n, "the parent's balance fell by exactly what it delegated");
check(childBalance === 10_000n, 'the child holds what left the parent');
check(rootBalance + childBalance === 100_000n, 'nothing was created by delegating');

await refuses('budget_exhausted', 'a child cannot be funded beyond the parent', () =>
  authority.mint({
    parent: authority.rootToken,
    child: 'greedy',
    amountMinor: 1_000_000n,
    expiresAt: Date.now() + HOUR,
  }),
);

await refuses('duplicate_node', 'the same child cannot be minted twice', () =>
  authority.mint({
    parent: authority.rootToken,
    child: 'researcher',
    amountMinor: 1n,
    expiresAt: Date.now() + HOUR,
  }),
);

await refuses('expired', 'a child cannot be minted already expired', () =>
  authority.mint({
    parent: authority.rootToken,
    child: 'stale',
    amountMinor: 1n,
    expiresAt: Date.now() - 1,
  }),
);

await refuses('bad_request', 'a child id is not free-form', () =>
  authority.mint({
    parent: authority.rootToken,
    child: 'has spaces/and slashes',
    amountMinor: 1n,
    expiresAt: Date.now() + HOUR,
  }),
);

/* -------------------------------------------------------------- attenuation */

section('Attenuation never widens');

const childToken = child.token;
const rootPolicy = policyOf(authority.rootToken.caveats);
const childPolicy = policyOf(childToken.caveats);
check(isNarrowerOrEqual(childPolicy, rootPolicy), "the child's policy is inside the parent's");

const overreaching = await authority.mint({
  parent: childToken,
  child: 'subagent',
  amountMinor: 1_000n,
  // Asks to outlive its parent and to spend more per call than its parent may.
  expiresAt: Date.now() + 10 * HOUR,
  ceilingMinor: 10_000_000n,
});
const grandPolicy = policyOf(overreaching.token.caveats);
check(
  isNarrowerOrEqual(grandPolicy, childPolicy),
  'a child asking for more than its parent has is clamped, not granted',
);
check(
  grandPolicy.expiresAt !== null &&
    childPolicy.expiresAt !== null &&
    grandPolicy.expiresAt <= childPolicy.expiresAt,
  'a child cannot outlive its parent',
);
check(
  grandPolicy.ceilingMinor !== null &&
    childPolicy.ceilingMinor !== null &&
    grandPolicy.ceilingMinor <= childPolicy.ceilingMinor,
  "a child's per-call ceiling cannot exceed its parent's",
);
check(
  grandPolicy.maxDepth !== null &&
    childPolicy.maxDepth !== null &&
    grandPolicy.maxDepth < childPolicy.maxDepth,
  'each delegation costs one level of remaining depth',
);

/*
  The macaroon property, checked against the authority rather than asserted:
  a holder can narrow their own token offline, with no key and no server, and
  the result still verifies.
*/
const narrowed = await attenuate(childToken, [{ kind: 'ceiling', minor: 5n }]);
const narrowedOpened = await authority.open(`er_${btoa(serialize(narrowed))}`);
check(narrowedOpened.policy.ceilingMinor === 5n, 'a holder can narrow their own token offline');
check(
  narrowedOpened.token.node === childToken.node,
  'narrowing does not create a budget — it still spends the same node',
);

/* ---------------------------------------------------------------- forgeries */

section('Forgeries');

await refuses('bad_capability', 'a token with an edited caveat does not verify', () => {
  const forged = deserialize(serialize(childToken))!;
  const caveats = forged.caveats.map((c) =>
    c.kind === 'ceiling' ? { kind: 'ceiling' as const, minor: 999_999_999n } : c,
  );
  return authority.open(`er_${btoa(serialize({ ...forged, caveats }))}`);
});

await refuses('bad_capability', 'a token whose caveats are dropped does not verify', () =>
  authority.open(`er_${btoa(serialize({ ...childToken, caveats: [] }))}`),
);

await refuses('bad_capability', 'a capability from a different secret does not verify', async () => {
  const other = await authorityWith({ secret: 'a-completely-different-secret-value' });
  const theirs = await other.mint({
    parent: other.rootToken,
    child: 'researcher',
    amountMinor: 10n,
    expiresAt: Date.now() + HOUR,
  });
  return authority.open(theirs.capability);
});

await refuses('bad_capability', 'a capability that is not base64 is refused', () =>
  authority.open('er_!!!!not-base64!!!!'),
);

/* -------------------------------------------------------------- authorising */

section('Authorising a payment');

signedFor = [];
const authorized = await authority.authorize({
  token: childToken,
  policy: childPolicy,
  x402Version: 2,
  requirements: quote({ amount: '1000' }),
});
check(signedFor.length === 1, 'a permitted payment reaches the signer');
check(authorized.amountMinor === 1000n, 'the amount charged is the amount in the requirements');
check(authorized.remainingMinor === 10_000n - 1_000n - 1_000n, 'the budget fell by the payment');

signedFor = [];
await refuses('over_ceiling', 'a payment above the per-call ceiling is refused', () =>
  authority.authorize({
    token: narrowed,
    policy: policyOf(narrowed.caveats),
    x402Version: 2,
    requirements: quote({ amount: '1000' }),
  }),
);
check(signedFor.length === 0, 'a refused payment never reaches the signer');

await refuses('wrong_network', 'a quote on another network is refused', () =>
  authority.authorize({
    token: childToken,
    policy: childPolicy,
    x402Version: 2,
    requirements: quote({ network: 'eip155:8453' }),
  }),
);

await refuses('bad_request', 'a non-numeric amount is refused before anything else', () =>
  authority.authorize({
    token: childToken,
    policy: childPolicy,
    x402Version: 2,
    requirements: quote({ amount: '1e3' }),
  }),
);

await refuses('expired', 'an expired capability cannot pay', async () => {
  const expiring = await authority.mint({
    parent: authority.rootToken,
    child: 'briefly',
    amountMinor: 100n,
    expiresAt: Date.now() + 20,
  });
  await new Promise((resolve) => setTimeout(resolve, 40));
  return authority.authorize({
    token: expiring.token,
    policy: policyOf(expiring.token.caveats),
    x402Version: 2,
    requirements: quote({ amount: '10' }),
  });
});

section('Budgets are cumulative, not per call');

const spender = await authorityWith({ fundedMinor: 10_000n });
const limited = await spender.mint({
  parent: spender.rootToken,
  child: 'capped',
  amountMinor: 250n,
  expiresAt: Date.now() + HOUR,
});
const limitedPolicy = policyOf(limited.token.caveats);
const pay = (amount: string) =>
  spender.authorize({
    token: limited.token,
    policy: limitedPolicy,
    x402Version: 2,
    requirements: quote({ amount }),
  });

await pay('100');
await pay('100');
check(spender.balances('capped')[0]!.balanceMinor === 50n, 'each call draws down the same budget');
await refuses('budget_exhausted', 'the third call exceeds a budget two calls did not', () =>
  pay('100'),
);
check(
  (await pay('50')).remainingMinor === 0n,
  'a payment for exactly the remainder is still permitted',
);
await refuses('budget_exhausted', 'an empty budget buys nothing', () => pay('1'));

/* ------------------------------------------------------------------ hosts */

section('Host restriction');

const hosted = await authorityWith({ fundedMinor: 10_000n, allowPayTo: [RECIPIENT] });
const scoped = await hosted.mint({
  parent: hosted.rootToken,
  child: 'scoped',
  amountMinor: 5_000n,
  expiresAt: Date.now() + HOUR,
  allowHosts: ['gate.example'],
});
const scopedPolicy = policyOf(scoped.token.caveats);

await refuses('host_not_permitted', 'a host outside the caveat is refused', () =>
  hosted.authorize({
    token: scoped.token,
    policy: scopedPolicy,
    x402Version: 2,
    requirements: quote(),
    resourceUrl: 'https://elsewhere.example/v1/chat/completions',
  }),
);

const onHost = await hosted.authorize({
  token: scoped.token,
  policy: scopedPolicy,
  x402Version: 2,
  requirements: quote(),
  resourceUrl: 'https://gate.example/v1/chat/completions',
});
check(onHost.amountMinor === 1000n, 'a permitted host pays normally');

await refuses('pay_to_not_permitted', 'an unlisted payTo is refused whatever the URL claims', () =>
  hosted.authorize({
    token: scoped.token,
    policy: scopedPolicy,
    x402Version: 2,
    requirements: quote({ payTo: '0.0.9999' }),
    resourceUrl: 'https://gate.example/v1/chat/completions',
  }),
);

/* -------------------------------------------------------------- revocation */

section('Revocation');

const revoking = await authorityWith({ fundedMinor: 10_000n });
const parent = await revoking.mint({
  parent: revoking.rootToken,
  child: 'parent',
  amountMinor: 6_000n,
  expiresAt: Date.now() + HOUR,
});
const grandchild = await revoking.mint({
  parent: parent.token,
  child: 'grandchild',
  amountMinor: 2_000n,
  expiresAt: Date.now() + HOUR,
});

check(
  revoking.balances('parent').find((n) => n.id === 'grandchild')!.balanceMinor === 2_000n,
  'a grandchild holds its allocation',
);

const recovered = revoking.revoke({ token: revoking.rootToken, node: 'parent' });
check(recovered.recoveredMinor === 6_000n, 'revoking returns the subtree total to the revoker');
check(revoking.balances('root')[0]!.balanceMinor === 10_000n, 'the tree is whole again');

await refuses('unknown_node', 'a revoked capability stops working immediately', () =>
  revoking.open(parent.capability),
);
await refuses('unknown_node', 'revocation reaches descendants, not just the named node', () =>
  revoking.open(grandchild.capability),
);

const selfRevoke = await authorityWith({ fundedMinor: 100n });
const only = await selfRevoke.mint({
  parent: selfRevoke.rootToken,
  child: 'only',
  amountMinor: 50n,
  expiresAt: Date.now() + HOUR,
});
await refuses('not_a_descendant', 'a capability cannot revoke itself', () =>
  selfRevoke.revoke({ token: only.token, node: 'only' }),
);
await refuses('not_a_descendant', 'a capability cannot revoke its own parent', () =>
  selfRevoke.revoke({ token: only.token, node: 'root' }),
);

/* ------------------------------------------------------------- conservation */

section('Conservation');

const traced = await authorityWith({ fundedMinor: 1_000_000n });
const held = (a: Authority) =>
  a.balances('root').reduce((sum, node) => sum + node.balanceMinor, 0n);

let minted = 0;
for (let i = 0; i < 12; i += 1) {
  const grant = await traced.mint({
    parent: traced.rootToken,
    child: `worker-${i}`,
    amountMinor: 10_000n,
    expiresAt: Date.now() + HOUR,
  });
  minted += 1;
  await traced.authorize({
    token: grant.token,
    policy: policyOf(grant.token.caveats),
    x402Version: 2,
    requirements: quote({ amount: '1234' }),
  });
  check(
    held(traced) + traced.spentMinor() === 1_000_000n,
    `held + spent equals funded after delegation ${i + 1}`,
  );
}
check(minted === 12, 'twelve delegations and twelve payments ran');

/* ------------------------------------------------------------- over HTTP */

section('Over HTTP');

const served = await authorityWith({ fundedMinor: 50_000n });
const handler = authorityHandler(served);
const httpFetch = ((input: string | URL | Request, init?: RequestInit) =>
  handler(new Request(input as string, init))) as typeof fetch;

const grant = await served.mint({
  parent: served.rootToken,
  child: 'remote',
  amountMinor: 3_000n,
  expiresAt: Date.now() + HOUR,
});

const connection = await connectAuthority({
  url: 'http://authority.local',
  capability: grant.capability,
  fetch: httpFetch,
});
check(connection.node === 'remote', 'the connection knows which node it speaks for');
check(connection.account === PAYER, 'a delegated signer reports the payer it actually pays from');
check(connection.signer.network === NETWORK, 'a delegated signer is a PaymentSigner');

signedFor = [];
const payload = await connection.signer.createPayload(2, quote({ amount: '900' }));
check(
  typeof payload.transaction === 'string',
  'the delegated signer returns the payload the authority signed',
);
check(signedFor.length === 1, 'the signature was produced by the authority, not the caller');
check(connection.remainingMinor() === 2_100n, 'the caller learns what is left after paying');

/*
  The whole point, end to end: a sub-agent with no key drives the ordinary
  payment loop, and `payAndFetch` cannot tell the difference.
*/
const gate = ((input: string | URL | Request, init?: RequestInit) => {
  const headers = new Headers(init?.headers);
  if (!headers.has('PAYMENT-SIGNATURE')) {
    return Promise.resolve(
      new Response(
        JSON.stringify({
          x402Version: 2,
          resource: { url: 'https://gate.example/v1/chat/completions' },
          accepts: [quote({ amount: '700' })],
        }),
        { status: 402, headers: { 'content-type': 'application/json' } },
      ),
    );
  }
  return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
}) as typeof fetch;

const paid = await payAndFetch('https://gate.example/v1/chat/completions', {
  signer: connection.signer,
  maxAmount: 10_000n,
  fetch: gate,
});
check(paid.response.status === 200, 'a keyless sub-agent completes the ordinary 402 loop');
check(paid.attempts === 2, 'it took a 402 and a paid retry, like any other client');
check(connection.remainingMinor() === 1_400n, 'the budget fell by the price of the call');

/*
  Above what is left (1400) but below the per-call ceiling (3000), so the
  refusal is unambiguously the budget rather than the caveat. The two bounds
  are separate mechanisms and a check that cannot tell them apart proves
  neither.
*/
await refuses('budget_exhausted', 'the authority refuses over HTTP once the budget is gone', () =>
  connection.signer.createPayload(2, quote({ amount: '2000' })),
);

await refuses('bad_capability', 'an unsigned request to the authority is refused', () =>
  connectAuthority({
    url: 'http://authority.local',
    capability: 'er_' + btoa('{}'),
    fetch: httpFetch,
  }),
);

const remoteMint = await connection.mint({
  child: 'remote-child',
  amountMinor: 500n,
  expiresAt: Date.now() + HOUR,
});
check(remoteMint.child === 'remote-child', 'a sub-agent can delegate onward over HTTP');
check(
  served.balances('remote').find((n) => n.id === 'remote-child')!.balanceMinor === 500n,
  'the onward delegation moved real budget',
);

const health = await handler(new Request('http://authority.local/health'));
const healthBody = (await health.json()) as Record<string, unknown>;
check(health.status === 200, 'health needs no capability');
check(
  !JSON.stringify(healthBody).includes('balance'),
  'health reports liveness, not what anyone holds',
);

/* --------------------------------------------------------------- name guard */

section('A name that stops resolving stops spending');

{
  /*
    The guard is what makes ENS structural rather than decorative. Without it
    the authority signs whether or not a name exists, and "every agent has a
    name" is a caption. These checks pin the three behaviours that matter, none
    of which need a chain: the guard is an interface precisely so it can be
    exercised without one.
  */
  const asked: string[] = [];
  let answer: string | null = null;

  const authority = await authorityWith({
    names: {
      async check(node) {
        asked.push(node);
        return answer;
      },
    },
  });

  const granted = await authority.mint({
    parent: authority.rootToken,
    child: 'agent.edgerouter.eth',
    amountMinor: 10_000n,
    expiresAt: Date.now() + HOUR,
  });
  const opened = await authority.open(granted.capability);

  const pay = () =>
    authority.authorize({
      token: opened.token,
      policy: opened.policy,
      x402Version: 2,
      requirements: quote({ amount: '1000' }),
    });

  const first = await pay();
  check(first.remainingMinor === 9_000n, 'a resolving name spends normally');
  check(asked.includes('agent.edgerouter.eth'), 'and the node was actually checked');

  answer = 'agent.edgerouter.eth does not resolve to an address';
  await refuses('name_not_resolving', 'a revoked name cannot spend', pay);

  /*
    The budget is untouched by the refusal. A name check that charged would
    make revocation a way to drain someone.
  */
  check(
    authority.balances('agent.edgerouter.eth')[0]!.balanceMinor === 9_000n,
    'and the refusal costs the node nothing',
  );

  answer = null;
  const third = await pay();
  check(third.remainingMinor === 8_000n, 'restoring the name restores spending');
}

{
  /*
    The order is load-bearing: everything decidable locally runs first, so a
    request that was already doomed never costs a network call.
  */
  const asked: string[] = [];
  const authority = await authorityWith({
    names: {
      async check(node) {
        asked.push(node);
        return null;
      },
    },
  });

  const granted = await authority.mint({
    parent: authority.rootToken,
    child: 'broke.edgerouter.eth',
    amountMinor: 100n,
    // A ceiling above the call, so the *budget* is what refuses it: an unset
    // ceiling defaults to the amount delegated, and would refuse first.
    ceilingMinor: 5_000n,
    expiresAt: Date.now() + HOUR,
  });
  const opened = await authority.open(granted.capability);

  await refuses('budget_exhausted', 'an unaffordable call is refused on the budget', () =>
    authority.authorize({
      token: opened.token,
      policy: opened.policy,
      x402Version: 2,
      requirements: quote({ amount: '1000' }),
    }),
  );
  check(asked.length === 0, 'and never reaches the network to find that out');
}

{
  // An authority with no guard is the one that existed before names did.
  const authority = await authorityWith();
  const granted = await authority.mint({
    parent: authority.rootToken,
    child: 'nameless',
    amountMinor: 5_000n,
    expiresAt: Date.now() + HOUR,
  });
  const opened = await authority.open(granted.capability);
  const paid = await authority.authorize({
    token: opened.token,
    policy: opened.policy,
    x402Version: 2,
    requirements: quote({ amount: '1000' }),
  });
  check(paid.remainingMinor === 4_000n, 'without a guard, nodes need no name at all');
}

console.log(failures === 0 ? '\nAll checks pass.' : `\n${failures} FAILED.`);
if (failures > 0) process.exit(1);
