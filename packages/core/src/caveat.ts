/**
 * Caveats, and the rule that adding one can only ever narrow.
 *
 * A caveat is a restriction attached to a capability. The whole product rests
 * on a single property: `restrict(policy, caveat)` must never return something
 * more permissive than `policy`. If that holds, a parent cannot be tricked into
 * granting a child more than it holds, and a child cannot widen what it was
 * given — not because anyone checks, but because the operation has no way to
 * express it.
 *
 * So every caveat kind reduces to an intersection, and every intersection is
 * written as a `min` or a set intersection. There is deliberately no caveat
 * whose combination rule is anything else.
 */

export type Caveat =
  /** Maximum total spend, in the smallest currency unit. */
  | { kind: 'ceiling'; minor: bigint }
  /** Unix milliseconds after which the capability is dead. */
  | { kind: 'expires'; at: number }
  /**
   * Hosts this capability may pay.
   *
   * Combination is set intersection, so a child can narrow the list but can
   * never introduce a host its parent could not reach. An empty intersection is
   * a capability that can pay nobody — which is a valid, if useless, state and
   * must not be special-cased into "no restriction".
   */
  | { kind: 'host'; allow: readonly string[] }
  /**
   * How many further delegations this capability may produce.
   *
   * Zero means a leaf. Without this a chain can grow without bound, and an
   * unbounded chain is a spend amplifier: each level costs the attacker nothing
   * and multiplies the number of live capabilities.
   */
  | { kind: 'depth'; max: number }
  /**
   * What this capability may do, beyond spending.
   *
   * Reading a file, messaging another agent, granting a project to a third —
   * the things an agent does that are not payments. Deliberately the same shape
   * as `host`, and for the same reason: combination is set intersection, so a
   * child can narrow the list but can never introduce a permission its parent
   * did not hold. That property is not re-argued here, it is the one
   * `check.ts` already tests over generated caveat orders.
   *
   * ## Exact strings, no patterns
   *
   * `files:read:notes` and `files:read:*` are two unrelated strings, and there
   * is no rule that makes the second imply the first. A wildcard would have to
   * be interpreted at intersection time, and an interpretation is exactly the
   * place a widening can hide — `a ∩ b` is a proof, `matches(a, b)` is an
   * opinion. Grant the permissions you mean.
   *
   * ## Why nothing here means "all"
   *
   * There is no permission that grants future permissions. A capability is
   * signed over the caveats it carries, and a token naming a set that grows
   * after signing would hand its holder powers nobody consented to — the
   * consent was to the set as it stood. Adding a permission kind must reach
   * nobody until somebody grants it.
   */
  | { kind: 'scope'; allow: readonly string[] };

export type CaveatKind = Caveat['kind'];

/**
 * The effective policy of a capability: every caveat on it, intersected.
 *
 * `null` for a field means unconstrained *by the caveats seen so far*. The root
 * mint is expected to constrain ceiling and expiry, so an unconstrained policy
 * reaching the gate is a bug in minting rather than a licence to spend freely —
 * see `token.ts`, which refuses to verify one.
 */
export type Policy = {
  ceilingMinor: bigint | null;
  expiresAt: number | null;
  allowHosts: readonly string[] | null;
  maxDepth: number | null;
  /** Permissions granted, or null when no scope caveat has been seen. */
  scope: readonly string[] | null;
};

export const UNRESTRICTED: Policy = {
  ceilingMinor: null,
  expiresAt: null,
  allowHosts: null,
  maxDepth: null,
  scope: null,
};

const minBig = (a: bigint | null, b: bigint): bigint => (a === null || b < a ? b : a);
const minNum = (a: number | null, b: number): number => (a === null || b < a ? b : a);

/**
 * Applies one caveat.
 *
 * Every branch is a narrowing. There is no branch that can raise a bound, and
 * that is the invariant `check.ts` property-tests rather than trusts.
 */
export const restrict = (policy: Policy, caveat: Caveat): Policy => {
  switch (caveat.kind) {
    case 'ceiling':
      return { ...policy, ceilingMinor: minBig(policy.ceilingMinor, caveat.minor) };

    case 'expires':
      return { ...policy, expiresAt: minNum(policy.expiresAt, caveat.at) };

    case 'depth':
      return { ...policy, maxDepth: minNum(policy.maxDepth, caveat.max) };

    case 'scope': {
      // Intersection, exactly as `host` below. Written out rather than shared
      // with it because the two are the same operation on different meanings,
      // and a helper taking a field name would make a future widening a typo
      // rather than a rewrite.
      const incoming = new Set(caveat.allow);
      const allow =
        policy.scope === null ? [...incoming] : policy.scope.filter((granted) => incoming.has(granted));
      return { ...policy, scope: allow };
    }

    case 'host': {
      // Intersection, not replacement. A child listing a host its parent never
      // had must not gain it, so the incoming list is filtered *by* the existing
      // one rather than the other way round.
      const incoming = new Set(caveat.allow);
      const allow =
        policy.allowHosts === null
          ? [...incoming]
          : policy.allowHosts.filter((host) => incoming.has(host));
      return { ...policy, allowHosts: allow };
    }
  }
};

export const policyOf = (caveats: readonly Caveat[]): Policy =>
  caveats.reduce(restrict, UNRESTRICTED);

/** True when `a` permits nothing that `b` does not. Used only by the tests. */
export const isNarrowerOrEqual = (a: Policy, b: Policy): boolean => {
  if (b.ceilingMinor !== null && (a.ceilingMinor === null || a.ceilingMinor > b.ceilingMinor)) {
    return false;
  }
  if (b.expiresAt !== null && (a.expiresAt === null || a.expiresAt > b.expiresAt)) return false;
  if (b.maxDepth !== null && (a.maxDepth === null || a.maxDepth > b.maxDepth)) return false;
  if (b.allowHosts !== null) {
    if (a.allowHosts === null) return false;
    const permitted = new Set(b.allowHosts);
    if (a.allowHosts.some((host) => !permitted.has(host))) return false;
  }
  if (b.scope !== null) {
    if (a.scope === null) return false;
    const permitted = new Set(b.scope);
    if (a.scope.some((granted) => !permitted.has(granted))) return false;
  }
  return true;
};

/**
 * Whether a policy carries one permission.
 *
 * Fail-closed on the unconstrained case, and that is the one deliberate
 * asymmetry with `host`. An absent host list means "pay anyone", which is
 * survivable because a payment still has to clear a ceiling. An absent scope
 * would mean "do anything", which nothing else bounds — so a capability minted
 * without a scope caveat can read no files, message nobody, and grant nothing.
 *
 * The cost of that choice is that forgetting to mint a scope produces an agent
 * that cannot act rather than one that can act freely, which is the failure
 * that gets noticed in the first ten seconds instead of the one that gets
 * noticed by someone else.
 */
export const allows = (policy: Policy, permission: string): boolean =>
  policy.scope !== null && policy.scope.includes(permission);

export type Denial =
  | { ok: true }
  | { ok: false; rule: CaveatKind | 'unbounded'; detail: string };

/**
 * Whether a policy permits one payment.
 *
 * Denials name the rule that fired and nothing else. An agent that can read the
 * whole policy back out of its refusals can be walked through it one rejection
 * at a time by whoever is injecting it, until it finds the gap.
 */
export const permits = (
  policy: Policy,
  request: { amountMinor: bigint; host: string; now: number },
): Denial => {
  if (policy.ceilingMinor === null || policy.expiresAt === null) {
    // Refused rather than allowed. An unbounded capability reaching this point
    // means minting failed to constrain it, and the safe reading of "no limit
    // was recorded" is not "any limit is fine".
    return { ok: false, rule: 'unbounded', detail: 'capability carries no ceiling or expiry' };
  }
  if (request.now >= policy.expiresAt) {
    return { ok: false, rule: 'expires', detail: 'capability has expired' };
  }
  if (request.amountMinor > policy.ceilingMinor) {
    return { ok: false, rule: 'ceiling', detail: 'amount exceeds the ceiling' };
  }
  if (policy.allowHosts !== null && !policy.allowHosts.includes(request.host)) {
    return { ok: false, rule: 'host', detail: 'host is not permitted' };
  }
  return { ok: true };
};
