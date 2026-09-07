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
  | { kind: 'depth'; max: number };

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
};

export const UNRESTRICTED: Policy = {
  ceilingMinor: null,
  expiresAt: null,
  allowHosts: null,
  maxDepth: null,
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
  return true;
};

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
