/**
 * The check that makes a name load-bearing.
 *
 * Without this, ENS is a label: pretty in a UI, absent from every decision. The
 * authority holds the money and could sign whether or not a name exists, so
 * "each agent has a name" would be decoration. This is the line that makes it
 * structural — a name that stops resolving stops spending.
 *
 * What that buys is a revocation anybody can perform and anybody can verify.
 * Clearing a subregistry pointer is one transaction, it takes a whole subtree
 * with it, and its effect is visible to any observer with an RPC endpoint. The
 * authority's own revocation — emptying a node — remains, and is faster; this
 * adds the version that does not require trusting the authority's word.
 *
 * ## Caching, and why the two directions differ
 *
 * A resolution per payment would put an RPC call in the latency path of every
 * call, so answers are cached. But the two answers are not symmetrical:
 *
 *   resolves      cached, briefly. Being slightly stale means a just-revoked
 *                 name works for a few more seconds — bounded, and the budget
 *                 still bounds the damage.
 *   fails         not cached. A name that has just been minted, or an RPC that
 *                 blipped, must not be locked out for the rest of the TTL.
 *
 * ## What a failure to *check* means
 *
 * Refused, not allowed. An unreachable RPC is indistinguishable from a revoked
 * name, and treating "I could not tell" as "fine" would make the whole
 * mechanism bypassable by taking the RPC offline. The cost is real and worth
 * stating plainly: this makes spending depend on Sepolia being reachable. The
 * escape hatch is not to fail open silently but to run the authority without a
 * guard, which is a visible choice.
 */
import type { NameGuard } from '../../sdk/src/index';
import { createEnsClient, type EnsClient } from './client';

/** How long a resolving name is believed without asking again. */
const DEFAULT_TTL_MS = 30_000;

export type NameGuardOptions = {
  /** Only names ending in this are checked. Others pass untouched. */
  suffix?: string;
  ttlMs?: number;
  client?: EnsClient;
  now?: () => number;
};

/**
 * Requires each node's name to resolve to an address.
 *
 * The address record specifically, not merely the name's existence: a name with
 * no address points at nothing and names nothing that can act. That is also
 * what makes revocation-by-record possible — clearing the address is a lighter
 * touch than clearing a registry, and this treats both as revoked.
 *
 * Nodes that are not names under `suffix` are left alone. The root node is
 * called `root` and always will be, and an authority whose tree predates names
 * should keep working rather than refuse everything.
 */
export const ensNameGuard = (options: NameGuardOptions = {}): NameGuard => {
  const client = options.client ?? createEnsClient();
  const ttl = options.ttlMs ?? DEFAULT_TTL_MS;
  const now = options.now ?? (() => Date.now());
  const suffix = options.suffix ?? '.eth';

  /** Only positives live here; see the note above. */
  const resolved = new Map<string, number>();

  return {
    async check(node) {
      if (!node.endsWith(suffix)) return null;

      const fresh = resolved.get(node);
      if (fresh !== undefined && fresh > now()) return null;

      let address: string | null;
      try {
        address = await client.addressOf(node);
      } catch (error) {
        /*
          Deliberately a refusal. "Could not check" is not "is fine", and an
          authority that treated it as such could be opened by making its RPC
          unreachable.
        */
        return `could not check whether ${node} still resolves: ${(error as Error).message}`;
      }

      if (!address) {
        resolved.delete(node);
        return `${node} does not resolve to an address; it may have been revoked`;
      }

      resolved.set(node, now() + ttl);
      return null;
    },
  };
};
