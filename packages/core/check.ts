/**
 * The rules, property-tested. No network, no chain, no API key.
 *
 * This exists because the whole product is one claim — that a delegated budget
 * can only ever narrow — and a claim that important should be checked against
 * randomness rather than against three hand-picked examples that happen to
 * pass. Every property below is run over generated trees and generated caveat
 * orders, and any counterexample is printed with the seed that produced it.
 *
 *   bun packages/core/check.ts [seed]
 */
import {
  allows,
  isNarrowerOrEqual,
  permits,
  policyOf,
  restrict,
  UNRESTRICTED,
  type Caveat,
  type Policy,
} from './src/caveat';
import { attenuate, deserialize, mint, serialize, verify } from './src/token';
import {
  conserves,
  createTree,
  delegate,
  revoke,
  spend,
  subtree,
  totalHeld,
  type Tree,
} from './src/tree';

let failures = 0;
const pass = (m: string) => console.log(`  ok    ${m}`);
const fail = (m: string) => {
  failures += 1;
  console.log(`  FAIL  ${m}`);
};
const check = (condition: boolean, m: string) => (condition ? pass(m) : fail(m));

/* -------------------------------------------------------------------------- */
/* Deterministic randomness, so a failure can be reproduced from its seed      */
/* -------------------------------------------------------------------------- */

const SEED = Number(process.argv[2] ?? 1);
let state = SEED >>> 0 || 1;
const rand = (): number => {
  // xorshift32. Small, seedable, and good enough to shuffle test inputs.
  state ^= state << 13;
  state ^= state >>> 17;
  state ^= state << 5;
  return (state >>> 0) / 0x100000000;
};
const randInt = (n: number): number => Math.floor(rand() * n);
const pick = <T>(xs: readonly T[]): T => xs[randInt(xs.length)]!;

const HOSTS = ['api.openrouter.ai', 'gate.edgerouter.io', 'x.example', 'y.example', 'z.example'];

/*
  Shaped like the real vocabulary rather than as `a`/`b`/`c`, so a generated
  counterexample reads as something that could actually be granted. The
  `project:` entries carry opaque ids on purpose: a permission naming a path
  would put that path in every capability that quotes it.
*/
const PERMISSIONS = [
  'files:read:own',
  'files:write:own',
  'files:host',
  'project:prj_7f3a:read',
  'project:prj_7f3a:write',
  'message:send',
  'message:reply',
  'delegate',
  'budget:request',
];

const randomCaveat = (): Caveat => {
  switch (randInt(5)) {
    case 0:
      return { kind: 'ceiling', minor: BigInt(randInt(100_000) + 1) };
    case 1:
      return { kind: 'expires', at: 1_000_000 + randInt(1_000_000) };
    case 2:
      return { kind: 'depth', max: randInt(6) };
    case 3:
      return {
        kind: 'scope',
        allow: PERMISSIONS.filter(() => rand() < 0.6),
      };
    default:
      return {
        kind: 'host',
        allow: HOSTS.filter(() => rand() < 0.6),
      };
  }
};

const ROOT_KEY = new Uint8Array(32).fill(7);

/* -------------------------------------------------------------------------- */
/* 1. Attenuation never widens                                                 */
/* -------------------------------------------------------------------------- */

console.log(`seed ${SEED}\n\nAttenuation algebra\n`);

{
  let widened: string | null = null;

  for (let trial = 0; trial < 5_000 && widened === null; trial += 1) {
    let policy: Policy = UNRESTRICTED;
    const applied: Caveat[] = [];

    for (let step = 0; step < randInt(8) + 1; step += 1) {
      const caveat = randomCaveat();
      const next = restrict(policy, caveat);
      if (!isNarrowerOrEqual(next, policy)) {
        widened = `after ${JSON.stringify(applied)} adding ${JSON.stringify(caveat)}`;
      }
      applied.push(caveat);
      policy = next;
    }
  }

  check(widened === null, `adding a caveat never widens (5,000 random chains)${widened ? ` — ${widened}` : ''}`);
}

{
  // Order must not matter to the *effective* policy: intersection commutes.
  let mismatch = false;
  for (let trial = 0; trial < 2_000 && !mismatch; trial += 1) {
    const caveats = Array.from({ length: randInt(6) + 2 }, randomCaveat);
    const shuffled = [...caveats].sort(() => rand() - 0.5);
    const a = policyOf(caveats);
    const b = policyOf(shuffled);
    const same =
      a.ceilingMinor === b.ceilingMinor &&
      a.expiresAt === b.expiresAt &&
      a.maxDepth === b.maxDepth &&
      JSON.stringify([...(a.allowHosts ?? [])].sort()) ===
        JSON.stringify([...(b.allowHosts ?? [])].sort());
    if (!same) mismatch = true;
  }
  check(!mismatch, 'effective policy is order-independent (2,000 shuffles)');
}

{
  const policy = policyOf([
    { kind: 'ceiling', minor: 500n },
    { kind: 'expires', at: 10_000 },
    { kind: 'host', allow: ['a', 'b'] },
  ]);
  check(permits(policy, { amountMinor: 500n, host: 'a', now: 0 }).ok, 'a permitted payment passes');
  check(!permits(policy, { amountMinor: 501n, host: 'a', now: 0 }).ok, 'one over the ceiling fails');
  check(!permits(policy, { amountMinor: 1n, host: 'c', now: 0 }).ok, 'an unlisted host fails');
  check(!permits(policy, { amountMinor: 1n, host: 'a', now: 10_000 }).ok, 'expiry is exclusive');

  const unbounded = permits(UNRESTRICTED, { amountMinor: 1n, host: 'a', now: 0 });
  check(!unbounded.ok, 'an unbounded capability is refused, not allowed');

  // A child narrowing a host list must not be able to introduce a new host.
  const narrowed = restrict(policy, { kind: 'host', allow: ['b', 'zzz'] });
  check(
    !(narrowed.allowHosts ?? []).includes('zzz'),
    'a child cannot add a host its parent never had',
  );

  /* ---- scope ------------------------------------------------------------ */

  const scoped = policyOf([
    { kind: 'ceiling', minor: 500n },
    { kind: 'expires', at: 10_000 },
    { kind: 'scope', allow: ['files:read:own', 'message:reply'] },
  ]);
  check(allows(scoped, 'files:read:own'), 'a granted permission is allowed');
  check(!allows(scoped, 'message:send'), 'a permission never granted is refused');

  const reviewer = restrict(scoped, { kind: 'scope', allow: ['message:reply', 'files:host'] });
  check(
    allows(reviewer, 'message:reply') && !allows(reviewer, 'files:host'),
    'a child cannot add a permission its parent never had',
  );
  check(
    !allows(reviewer, 'files:read:own'),
    'a child narrowing scope drops what it left out',
  );

  /*
    The asymmetry with hosts, checked rather than commented. An absent host list
    means "pay anyone" and is survivable because a ceiling still binds; an
    absent scope must mean "do nothing", because nothing else bounds it.
  */
  check(!allows(UNRESTRICTED, 'files:read:own'), 'a capability with no scope caveat may do nothing');

  /*
    An empty intersection is a real state. Special-casing it into "no
    restriction" is the specific bug this guards, and it is one character of
    difference in `restrict`.
  */
  const disjoint = restrict(scoped, { kind: 'scope', allow: ['delegate'] });
  check(
    (disjoint.scope ?? null) !== null && disjoint.scope!.length === 0,
    'an empty intersection is empty, not unrestricted',
  );
  check(!allows(disjoint, 'delegate'), 'and it permits nothing');

  /*
    There is no permission that means "everything". Checked here so that adding
    one has to delete a test rather than merely slip past review — a token
    naming a set that grows after it was signed grants powers nobody consented
    to.
  */
  const wildcard = policyOf([{ kind: 'scope', allow: ['*', 'all'] }]);
  check(
    !allows(wildcard, 'files:host') && !allows(wildcard, 'delegate'),
    'no string is treated as a wildcard over other permissions',
  );
}

/* -------------------------------------------------------------------------- */
/* 2. Tokens: only the holder narrows, nobody widens                           */
/* -------------------------------------------------------------------------- */

console.log('\nCapability tokens\n');

{
  const root = await mint(ROOT_KEY, {
    root: 'harsh.edgerouter.eth',
    node: 'agent.harsh.edgerouter.eth',
    ceilingMinor: 5_000n,
    expiresAt: 2_000_000,
    maxDepth: 3,
  });

  const verified = await verify(ROOT_KEY, 'harsh.edgerouter.eth', root);
  check(verified.ok, 'a freshly minted token verifies');

  const child = await attenuate(root, [{ kind: 'ceiling', minor: 1_000n }]);
  const childVerified = await verify(ROOT_KEY, 'harsh.edgerouter.eth', child);
  check(childVerified.ok, 'an attenuated token verifies');
  check(
    childVerified.ok && childVerified.policy.ceilingMinor === 1_000n,
    'the narrower ceiling wins',
  );

  // Widening by appending is the obvious attack and must not work.
  const widened = await attenuate(child, [{ kind: 'ceiling', minor: 999_999n }]);
  const widenedVerified = await verify(ROOT_KEY, 'harsh.edgerouter.eth', widened);
  check(
    widenedVerified.ok && widenedVerified.policy.ceilingMinor === 1_000n,
    'appending a larger ceiling does not raise it',
  );

  /*
    Scope through the signature chain, not just through `policyOf`. The algebra
    being right is worth nothing if the caveat is not covered by the HMAC —
    that is the difference between a permission and a suggestion.
  */
  const permitted = await mint(ROOT_KEY, {
    root: 'harsh.edgerouter.eth',
    node: 'developer',
    ceilingMinor: 10_000n,
    expiresAt: 10_000,
    scope: ['files:host', 'message:send', 'delegate'],
  });
  const scopedVerified = await verify(ROOT_KEY, 'harsh.edgerouter.eth', permitted);
  check(
    scopedVerified.ok && allows(scopedVerified.policy, 'files:host'),
    'a minted scope survives verification',
  );

  const delegated = await attenuate(permitted, [{ kind: 'scope', allow: ['message:reply'] }]);
  const delegatedVerified = await verify(ROOT_KEY, 'harsh.edgerouter.eth', delegated);
  check(
    delegatedVerified.ok && !allows(delegatedVerified.policy, 'files:host'),
    'attenuating scope removes what was not carried forward',
  );
  check(
    delegatedVerified.ok && !allows(delegatedVerified.policy, 'message:reply'),
    'and a permission the parent never held is not gained by asking for it',
  );

  /*
    `host:x` and `scope:x` must not encode to the same bytes. Two caveats with
    one encoding would be interchangeable inside a chain, which would let a
    permission be spent as a host restriction or the reverse.
  */
  const asHost = await mint(ROOT_KEY, {
    root: 'r',
    node: 'n',
    ceilingMinor: 1n,
    expiresAt: 1,
    allowHosts: ['x'],
  });
  const asScope = await mint(ROOT_KEY, {
    root: 'r',
    node: 'n',
    ceilingMinor: 1n,
    expiresAt: 1,
    scope: ['x'],
  });
  check(asHost.sig !== asScope.sig, 'a host and a permission with the same name sign differently');

  // Removing a caveat is the real attack. It must fail the signature.
  const stripped = { ...child, caveats: child.caveats.slice(0, -1) };
  const strippedVerified = await verify(ROOT_KEY, 'harsh.edgerouter.eth', stripped);
  check(!strippedVerified.ok, 'a token with a caveat removed fails verification');

  const reordered = { ...child, caveats: [...child.caveats].reverse() };
  check(
    !(await verify(ROOT_KEY, 'harsh.edgerouter.eth', reordered)).ok,
    'reordering caveats fails verification',
  );

  const forged = { ...child, sig: child.sig.replace(/.$/, (c) => (c === '0' ? '1' : '0')) };
  check(
    !(await verify(ROOT_KEY, 'harsh.edgerouter.eth', forged)).ok,
    'a forged signature fails verification',
  );

  const wrongKey = await verify(new Uint8Array(32).fill(8), 'harsh.edgerouter.eth', child);
  check(!wrongKey.ok, 'another root key does not verify');

  const wrongRoot = await verify(ROOT_KEY, 'someone.else.eth', child);
  check(!wrongRoot.ok && wrongRoot.reason === 'root', 'a token for another root is refused');

  const round = deserialize(serialize(child));
  check(round !== null && round.sig === child.sig, 'a token round-trips through the wire format');
  check(
    round !== null && (await verify(ROOT_KEY, 'harsh.edgerouter.eth', round)).ok,
    'a deserialized token still verifies',
  );

  for (const bad of ['{}', 'not json', '{"root":1}', JSON.stringify({ ...JSON.parse(serialize(child)), sig: 'zz' })]) {
    check(deserialize(bad) === null, `malformed token rejected: ${bad.slice(0, 28)}`);
  }
}

/* -------------------------------------------------------------------------- */
/* 3. The tree conserves money                                                 */
/* -------------------------------------------------------------------------- */

console.log('\nBudget tree\n');

{
  const FUNDED = 1_000_000n;
  let broken: string | null = null;
  let deepest = 0;

  for (let trial = 0; trial < 500 && broken === null; trial += 1) {
    let tree: Tree = createTree('root', FUNDED);
    let spent = 0n;
    let nextId = 0;

    for (let step = 0; step < 40; step += 1) {
      const ids = [...tree.nodes.keys()];
      const target = pick(ids);

      switch (randInt(3)) {
        case 0: {
          const held = tree.nodes.get(target)!.balanceMinor;
          const amount = held === 0n ? 0n : BigInt(randInt(Number(held)) + 1);
          const result = delegate(tree, {
            parent: target,
            child: `n${(nextId += 1)}`,
            amountMinor: amount,
            maxDepth: 4,
          });
          if (result.ok) tree = result.value;
          break;
        }
        case 1: {
          const held = tree.nodes.get(target)!.balanceMinor;
          const amount = held === 0n ? 0n : BigInt(randInt(Number(held)) + 1);
          const result = spend(tree, { node: target, amountMinor: amount });
          if (result.ok) {
            tree = result.value;
            spent += amount;
          }
          break;
        }
        default: {
          const result = revoke(tree, target);
          if (result.ok) tree = result.value;
          break;
        }
      }

      deepest = Math.max(deepest, ...[...tree.nodes.values()].map((n) => n.depth));

      if (!conserves(tree, FUNDED, spent)) {
        broken = `trial ${trial} step ${step}: held ${totalHeld(tree)} + spent ${spent} != ${FUNDED}`;
        break;
      }
      if ([...tree.nodes.values()].some((n) => n.balanceMinor < 0n)) {
        broken = `trial ${trial} step ${step}: negative balance`;
        break;
      }
    }
  }

  check(broken === null, `money is conserved across 500 random traces${broken ? ` — ${broken}` : ''}`);
  check(deepest <= 4, `depth bound held (deepest observed ${deepest})`);
}

{
  const tree = createTree('root', 100n);
  const over = delegate(tree, { parent: 'root', child: 'a', amountMinor: 101n });
  check(!over.ok && over.error.code === 'insufficient_funds', 'cannot delegate more than held');

  const neg = delegate(tree, { parent: 'root', child: 'a', amountMinor: -1n });
  check(!neg.ok && neg.error.code === 'negative_amount', 'cannot delegate a negative amount');

  const one = delegate(tree, { parent: 'root', child: 'a', amountMinor: 40n });
  const dupe = one.ok ? delegate(one.value, { parent: 'root', child: 'a', amountMinor: 1n }) : null;
  check(dupe !== null && !dupe.ok && dupe.error.code === 'duplicate_node', 'node ids are unique');

  // Revocation is transitive: an orphaned grandchild with a live balance is the
  // failure mode this has to rule out.
  let deep = createTree('root', 100n);
  for (const [parent, child, amount] of [
    ['root', 'a', 60n],
    ['a', 'b', 40n],
    ['b', 'c', 20n],
  ] as const) {
    const r = delegate(deep, { parent, child, amountMinor: amount });
    if (r.ok) deep = r.value;
  }
  check(subtree(deep, 'a').length === 2, 'subtree finds descendants at every depth');

  const revoked = revoke(deep, 'a');
  check(revoked.ok, 'revoking an interior node succeeds');
  if (revoked.ok) {
    check(!revoked.value.nodes.has('c'), 'revocation reaches the grandchild');
    check(revoked.value.nodes.get('root')!.balanceMinor === 100n, 'every penny returns to the parent');
    check(totalHeld(revoked.value) === 100n, 'nothing is lost in revocation');
  }

  const rootRevoke = revoke(deep, 'root');
  check(!rootRevoke.ok, 'the root cannot be revoked — there is nobody above it');
}

console.log(
  failures === 0
    ? `\nAll checks pass (seed ${SEED}).`
    : `\n${failures} FAILED at seed ${SEED}. Reproduce with: bun packages/core/check.ts ${SEED}`,
);

process.exit(failures === 0 ? 0 : 1);
