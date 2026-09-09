/**
 * The budget authority: the thing that holds the key and hands out allowances.
 *
 * This is the half of delegation that could not be stateless.
 *
 * A capability token says what a request is *allowed* to do, and the gate can
 * check that with no memory at all — recompute the HMAC chain, read the
 * caveats, decide. But "this sub-agent may spend one hbar in total" is not a
 * property of any single request. It is a running total, and a running total is
 * state. The gate deliberately has none, so the budget lives here instead: in
 * the one process that already had to be stateful, because it is the one
 * holding the key.
 *
 * That split is the whole design:
 *
 *   caveats (stateless, at the gate)   per-call ceiling, expiry, hosts, depth
 *   tree    (stateful, here)           cumulative budget, funding, revocation
 *
 * A sub-agent never sees the key. It asks the authority to sign one payment,
 * the authority charges that payment to the sub-agent's node, and when the node
 * is empty the answer is no. Revoking is emptying: there is no revocation list,
 * because a capability over an empty balance already buys nothing.
 *
 * Two invariants are load-bearing and easy to lose in a refactor:
 *
 *   1. The authority charges the amount it *signs*, read out of the
 *      requirements it was handed — never an amount the caller states
 *      separately. One number, one place, no way to understate a payment.
 *   2. Minting moves money and therefore needs the authority. Attenuating does
 *      not move money and therefore does not: any holder can narrow a token
 *      offline with `attenuate`, and the narrowed token still spends the same
 *      node's budget. Narrowing is not funding.
 */
import {
  deriveRootKey,
  deserialize,
  mint as mintToken,
  serialize,
  verify,
  type Token,
} from '../../../core/src/token';
import { permits, policyOf, type Caveat, type Policy } from '../../../core/src/caveat';
import {
  createTree,
  delegate,
  revoke as revokeNode,
  spend,
  subtree,
  type Tree,
} from '../../../core/src/tree';
import type { PaymentRequirements, PaymentSigner } from '../pay/types';
import type { AuthorityRefusal } from './wire';

/**
 * Something that can say whether a node's name still stands.
 *
 * An interface rather than an ENS client, because the authority must not depend
 * on a chain it does not pay on. The implementation lives in `@edgerouter/ens`;
 * what this file knows is that identity can be checked and can fail.
 */
export type NameGuard = {
  /**
   * @returns why the name is unusable, or null when it resolves.
   *
   * A string rather than a boolean so the refusal can say what happened —
   * "does not resolve" and "could not be checked" are different problems and
   * lead to different actions.
   */
  check(node: string): Promise<string | null>;
};

export type AuthorityOptions = {
  /** Signs every payment this authority authorises. Holds the only key. */
  signer: PaymentSigner;
  /**
   * Secret the capability chain is rooted in. Distinct from the gate's:
   * a token for spending *your* budget is not a token for narrowing what the
   * gate will serve, and one secret for both would let either grant the other.
   */
  secret: string;
  /** Names this authority's root. Part of the key derivation, not a secret. */
  root?: string;
  /** What the root node starts with, in the asset's smallest unit. */
  fundedMinor: bigint;
  /**
   * Accounts this authority will ever pay, when you want that bound.
   *
   * The `host` caveat is checked against a URL the caller reports, so it binds
   * an honest caller and nothing else. This binds the money: it is checked
   * against `payTo` in the requirements actually being signed.
   */
  allowPayTo?: readonly string[];
  /** Deepest delegation chain permitted. Unbounded chains amplify spend. */
  maxDepth?: number;
  /**
   * What the root capability may do besides spend.
   *
   * Everything minted beneath it intersects with this, so it is the ceiling on
   * permissions in the same way `fundedMinor` is the ceiling on money. Left
   * unset it is empty: no agent can read a file or message another until
   * somebody says which permissions exist here, which is the safe direction for
   * a default to fail in.
   */
  scope?: readonly string[];
  /**
   * Checks that a node's name still resolves, before anything is signed.
   *
   * This is what makes a name load-bearing rather than a label. The budget
   * tree already knows what a node may spend; the guard adds the requirement
   * that the node still *exists* as a public name — so revocation can be a
   * registry write anybody can verify, rather than a private deletion only
   * this process can see.
   *
   * Optional, and absent means unchecked: an authority with no guard is the
   * one that existed before names did, and still works.
   */
  names?: NameGuard;
  /** Injectable for tests. */
  now?: () => number;
};

export type Granted = {
  /** `er_<base64>` — ready to hand to a sub-agent. */
  capability: string;
  token: Token;
  child: string;
  amountMinor: bigint;
  expiresAt: number;
};

export type Authorized = {
  payload: Record<string, unknown>;
  amountMinor: bigint;
  remainingMinor: bigint;
};

export class AuthorityRefused extends Error {
  constructor(
    readonly code: AuthorityRefusal,
    message: string,
  ) {
    super(message);
    this.name = 'AuthorityRefused';
  }
}

const ROOT_NODE = 'root';
const DEFAULT_ROOT = 'edgerouter';
const DEFAULT_MAX_DEPTH = 4;
const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

/** Reads a decimal string as a positive bigint, or refuses. */
export const parseMinor = (raw: unknown, field: string): bigint => {
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) {
    throw new AuthorityRefused('bad_request', `${field} must be a whole number as a string`);
  }
  const value = BigInt(raw);
  if (value <= 0n) throw new AuthorityRefused('bad_request', `${field} must be greater than zero`);
  return value;
};

export type NodeBalance = {
  id: string;
  parent: string | null;
  depth: number;
  balanceMinor: bigint;
};

export type Authority = {
  /** The root capability. Held by whoever started the authority. */
  readonly rootCapability: string;
  readonly rootToken: Token;
  readonly root: string;
  /** The account every payment leaves from. Public. */
  readonly account: string;
  readonly network: string;
  /** Verifies a serialized capability and returns the node it speaks for. */
  open(capability: string): Promise<{ token: Token; policy: Policy }>;
  mint(params: {
    parent: Token;
    child: string;
    amountMinor: bigint;
    expiresAt: number;
    ceilingMinor?: bigint;
    allowHosts?: readonly string[];
    maxDepth?: number;
    /**
     * What the child may do besides spend.
     *
     * Intersected with the parent's, like hosts — a parent cannot grant a
     * permission it does not hold, and omitting this inherits the parent's set
     * rather than clearing it. A child that should do nothing but pay is minted
     * with `scope: []`, which is a real and useful state.
     */
    scope?: readonly string[];
  }): Promise<Granted>;
  authorize(params: {
    token: Token;
    policy: Policy;
    x402Version: number;
    requirements: PaymentRequirements;
    resourceUrl?: string;
  }): Promise<Authorized>;
  revoke(params: { token: Token; node: string }): { recoveredMinor: bigint };
  /** The caller's own node and everything beneath it. */
  balances(node: string): readonly NodeBalance[];
  /** Total ever spent through this authority. Only grows. */
  spentMinor(): bigint;
};

export const createAuthority = async (options: AuthorityOptions): Promise<Authority> => {
  const root = options.root ?? DEFAULT_ROOT;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const now = options.now ?? (() => Date.now());
  const rootKey = await deriveRootKey(options.secret, root);

  let tree: Tree = createTree(ROOT_NODE, options.fundedMinor);
  let spent = 0n;

  /*
    The root capability carries an expiry, and that is not ceremony: `permits`
    refuses a capability with no expiry outright, so a root token without one
    could never authorise anything. Constraining it at mint time puts the
    failure here, where it is visible, instead of in the first payment.
  */
  const rootToken = await mintToken(rootKey, {
    root,
    node: ROOT_NODE,
    ceilingMinor: options.fundedMinor,
    expiresAt: now() + YEAR_MS,
    maxDepth,
    ...(options.scope === undefined ? {} : { scope: options.scope }),
  });

  const encode = (token: Token): string => `er_${btoa(serialize(token))}`;

  const open = async (capability: string): Promise<{ token: Token; policy: Policy }> => {
    const text = capability.trim();
    const encoded = text.startsWith('er_') ? text.slice(3) : text;

    let decoded: string;
    try {
      decoded = atob(encoded);
    } catch {
      throw new AuthorityRefused('bad_capability', 'the capability is not base64');
    }
    const token = deserialize(decoded);
    if (!token) throw new AuthorityRefused('bad_capability', 'the capability is not readable');

    const verified = await verify(rootKey, root, token);
    if (!verified.ok) {
      throw new AuthorityRefused(
        'bad_capability',
        `capability failed verification (${verified.reason})`,
      );
    }
    if (!tree.nodes.has(token.node)) {
      /*
        A valid signature over a node that no longer exists is exactly what a
        revoked capability looks like — revocation deletes the node. Reported
        as `unknown_node` rather than a signature failure, because the token is
        genuine and saying otherwise sends the holder debugging the wrong thing.
      */
      throw new AuthorityRefused(
        'unknown_node',
        `no budget node named ${token.node}; it may have been revoked`,
      );
    }
    return { token, policy: verified.policy };
  };

  const requireDescendant = (ancestor: string, node: string): void => {
    if (!subtree(tree, ancestor).some((entry) => entry.id === node)) {
      throw new AuthorityRefused('not_a_descendant', `${node} is not beneath ${ancestor}`);
    }
  };

  return {
    rootToken,
    rootCapability: encode(rootToken),
    root,
    account: options.signer.accountId,
    network: options.signer.network,
    open,

    /**
     * Funds a child and gives it a capability, in one step.
     *
     * Every bound on the child is an intersection with the parent's, computed
     * here rather than trusted from the request. A parent asking for a child
     * that outlives it, or spends more per call than the parent may, gets a
     * child that is clamped — not an error, because the request is not
     * incoherent, and not a grant, because that would be widening.
     */
    async mint(params) {
      if (!/^[\w:.-]{1,64}$/.test(params.child)) {
        throw new AuthorityRefused('bad_request', 'child must be 1-64 chars of [A-Za-z0-9_:.-]');
      }
      if (!tree.nodes.has(params.parent.node)) {
        throw new AuthorityRefused('unknown_node', `no budget node named ${params.parent.node}`);
      }
      if (tree.nodes.has(params.child)) {
        throw new AuthorityRefused('duplicate_node', `${params.child} already exists`);
      }
      if (params.amountMinor <= 0n) {
        throw new AuthorityRefused('bad_request', 'amountMinor must be greater than zero');
      }

      const parentPolicy = policyOf(params.parent.caveats);

      const asked = params.ceilingMinor ?? params.amountMinor;
      const ceiling =
        parentPolicy.ceilingMinor === null
          ? asked
          : asked < parentPolicy.ceilingMinor
            ? asked
            : parentPolicy.ceilingMinor;

      const expiresAt =
        parentPolicy.expiresAt === null
          ? params.expiresAt
          : Math.min(params.expiresAt, parentPolicy.expiresAt);
      if (expiresAt <= now()) {
        throw new AuthorityRefused('expired', 'the requested expiry is already past');
      }

      /*
        Depth counts down. What the parent has left, minus one, is what the
        child may still delegate; a parent with none left cannot mint at all.
        That is the only thing stopping a chain from growing until every level
        holds a live capability.
      */
      const parentDepth = parentPolicy.maxDepth ?? maxDepth;
      if (parentDepth <= 0) {
        throw new AuthorityRefused('depth_exceeded', 'this capability may not delegate further');
      }
      const childDepth = Math.min(params.maxDepth ?? parentDepth - 1, parentDepth - 1);

      const hosts =
        params.allowHosts === undefined
          ? (parentPolicy.allowHosts ?? undefined)
          : parentPolicy.allowHosts === null
            ? params.allowHosts
            : params.allowHosts.filter((host) => parentPolicy.allowHosts!.includes(host));

      /*
        Permissions, narrowed the same way — and narrowed here as well as in the
        caveat algebra on purpose. `restrict` would intersect them anyway when
        the token is read, so this changes no outcome; what it changes is where
        the answer is decided. A capability that carries a permission it can
        never exercise is a capability that reads as more powerful than it is,
        and the first person to debug one will believe the token over the rule.

        A parent with no scope caveat holds *nothing*, so it hands out nothing —
        `?? []` rather than the "null means unconstrained" reading hosts use.
        The two differ because their fallbacks differ: an unrestricted host list
        still has a ceiling behind it, an unrestricted permission set has
        nothing behind it at all. Written the other way this granted
        `files:host` to the child of a root that had never been given it.
      */
      const parentScope = parentPolicy.scope ?? [];
      const scope =
        params.scope === undefined
          ? (parentPolicy.scope ?? undefined)
          : params.scope.filter((granted) => parentScope.includes(granted));

      const moved = delegate(tree, {
        parent: params.parent.node,
        child: params.child,
        amountMinor: params.amountMinor,
        maxDepth,
      });
      if (!moved.ok) {
        if (moved.error.code === 'insufficient_funds') {
          throw new AuthorityRefused(
            'budget_exhausted',
            `holds ${moved.error.have} but tried to delegate ${moved.error.want}`,
          );
        }
        if (moved.error.code === 'depth_exceeded') {
          throw new AuthorityRefused('depth_exceeded', `delegation deeper than ${maxDepth}`);
        }
        throw new AuthorityRefused('bad_request', moved.error.code);
      }
      tree = moved.value;

      const token = await mintToken(rootKey, {
        root,
        node: params.child,
        ceilingMinor: ceiling,
        expiresAt,
        maxDepth: childDepth,
        ...(hosts === undefined ? {} : { allowHosts: hosts }),
        ...(scope === undefined ? {} : { scope }),
      });

      return {
        token,
        capability: encode(token),
        child: params.child,
        amountMinor: params.amountMinor,
        expiresAt,
      };
    },

    /**
     * Authorises one payment: policy, then budget, then signature.
     *
     * The order matters. Everything that can refuse runs before the key is
     * touched, so a refused request costs nothing — and the budget is charged
     * only once a signature exists, so a signer that throws bills nobody.
     */
    async authorize(params) {
      const node = tree.nodes.get(params.token.node);
      if (!node) {
        throw new AuthorityRefused('unknown_node', `no budget node named ${params.token.node}`);
      }

      if (params.requirements.network !== options.signer.network) {
        throw new AuthorityRefused(
          'wrong_network',
          `this authority pays on ${options.signer.network}, not ${params.requirements.network}`,
        );
      }

      const amount = parseMinor(params.requirements.amount, 'requirements.amount');

      if (options.allowPayTo && !options.allowPayTo.includes(params.requirements.payTo)) {
        throw new AuthorityRefused(
          'pay_to_not_permitted',
          `this authority does not pay ${params.requirements.payTo}`,
        );
      }

      /*
        The host comes from a URL the caller reports, so this check binds an
        honest caller and no one else — which is exactly why `allowPayTo` above
        is checked against the field the money actually follows. Both are kept:
        one narrows what a sub-agent may reach, the other bounds what any of
        them can do with a lie.
      */
      let host = '';
      if (params.resourceUrl) {
        try {
          host = new URL(params.resourceUrl).host;
        } catch {
          throw new AuthorityRefused('bad_request', 'resourceUrl is not a URL');
        }
      }

      const decision = permits(params.policy, { amountMinor: amount, host, now: now() });
      if (!decision.ok) {
        const code: AuthorityRefusal =
          decision.rule === 'expires'
            ? 'expired'
            : decision.rule === 'ceiling'
              ? 'over_ceiling'
              : decision.rule === 'host'
                ? 'host_not_permitted'
                : 'unbounded_capability';
        throw new AuthorityRefused(code, decision.detail);
      }

      if (node.balanceMinor < amount) {
        throw new AuthorityRefused(
          'budget_exhausted',
          `${node.id} holds ${node.balanceMinor} but this call costs ${amount}`,
        );
      }

      /*
        Identity last, because it is the only check here that leaves the
        process. Everything decidable from local state has already run, so a
        request that was going to be refused anyway never costs a network call
        — and this one still runs before the key is touched.

        A name that stops resolving stops spending. That is the point: it makes
        revocation something a third party can perform and anyone can verify,
        rather than a deletion visible only inside this process.
      */
      if (options.names) {
        const problem = await options.names.check(node.id);
        if (problem) throw new AuthorityRefused('name_not_resolving', problem);
      }

      let payload: Record<string, unknown>;
      try {
        payload = await options.signer.createPayload(params.x402Version, params.requirements);
      } catch (error) {
        throw new AuthorityRefused('signing_failed', (error as Error).message);
      }

      /*
        Charged once the signature exists, not once the payment lands. The
        authority never sees the settlement, so it errs toward having spent: a
        budget that under-counts is not a budget, and the failure it would
        permit — a sub-agent retrying past its cap on calls that failed — is
        the one this exists to prevent.
      */
      const charged = spend(tree, { node: node.id, amountMinor: amount });
      if (!charged.ok) {
        throw new AuthorityRefused('budget_exhausted', 'the balance moved under this payment');
      }
      tree = charged.value;
      spent += amount;

      return {
        payload,
        amountMinor: amount,
        remainingMinor: tree.nodes.get(node.id)!.balanceMinor,
      };
    },

    /**
     * Revocation, which is just emptying a node and everything below it.
     *
     * Only a strict ancestor may do it. A capability revoking itself would be
     * a way to burn a parent's money from inside a sub-agent, and revoking a
     * sibling is not something a token says anything about.
     */
    revoke(params) {
      requireDescendant(params.token.node, params.node);
      const before = tree.nodes.get(params.token.node)?.balanceMinor ?? 0n;
      const result = revokeNode(tree, params.node);
      if (!result.ok) {
        throw new AuthorityRefused('unknown_node', `no budget node named ${params.node}`);
      }
      tree = result.value;
      const after = tree.nodes.get(params.token.node)?.balanceMinor ?? 0n;

      /*
        What the revoking node got back, not what the subtree held. They differ
        when the revoked node was a grandchild: the money returns to its own
        parent, which is where it came from. Reporting the subtree total would
        claim funds that landed somewhere else.
      */
      return { recoveredMinor: after - before };
    },

    balances(node) {
      const own = tree.nodes.get(node);
      if (!own) throw new AuthorityRefused('unknown_node', `no budget node named ${node}`);
      return [own, ...subtree(tree, node)].map((entry) => ({
        id: entry.id,
        parent: entry.parent,
        depth: entry.depth,
        balanceMinor: entry.balanceMinor,
      }));
    },

    spentMinor: () => spent,
  };
};

export type { Caveat, Policy };
