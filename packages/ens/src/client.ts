/**
 * Reading names on the ENSv2 hackathon deployment.
 *
 * Two things happen here and nothing else: a viem client pointed at the right
 * chain, and resolution that goes through *this* deployment's Universal
 * Resolver rather than the one viem assumes.
 *
 * ## Why the override is the whole file
 *
 * viem knows ENS. It knows it as mainnet's contracts, and `getEnsAddress` with
 * no `universalResolverAddress` will call a contract that does not know about
 * anything registered here. The answer comes back `null`, which is also what a
 * genuinely unregistered name returns — so the failure mode is a name you just
 * registered appearing not to exist, with no error anywhere to say why. Stating
 * the override once, here, is what stops that from being debugged repeatedly.
 *
 * ## Names, not namehashes
 *
 * Callers pass `researcher.session-x.edgerouter.eth` and never a namehash.
 * Normalisation (UTS-46, via viem's `normalize`) happens on the way in, because
 * a name that differs from its normalised form hashes differently and would
 * resolve to nothing at all.
 */
import { createPublicClient, http, type Address, type PublicClient } from 'viem';
import { normalize } from 'viem/ens';
import { sepolia } from 'viem/chains';
import { ENS, SEPOLIA_RPC } from './deployment';

export type EnsClient = {
  /** The underlying viem client, for callers that need to go further. */
  readonly client: PublicClient;
  /** The address a name points at, or null when nothing does. */
  addressOf(name: string): Promise<Address | null>;
  /** One text record, or null when the name or the key is absent. */
  textOf(name: string, key: string): Promise<string | null>;
  /** The resolver a name resolves through — the deepest one in the hierarchy. */
  resolverOf(name: string): Promise<Address | null>;
};

/**
 * Normalises, and says which name failed when it cannot.
 *
 * viem's `normalize` throws a message about a codepoint, which is accurate and
 * useless three call frames later — the caller wants to know which of the names
 * it passed was the bad one.
 */
export const ensName = (name: string): string => {
  try {
    return normalize(name.trim());
  } catch (error) {
    throw new Error(`"${name}" is not a usable ENS name: ${(error as Error).message}`);
  }
};

export const createEnsClient = (options: { rpcUrl?: string } = {}): EnsClient => {
  const client = createPublicClient({
    chain: sepolia,
    transport: http(options.rpcUrl ?? SEPOLIA_RPC),
  }) as PublicClient;

  /*
    Every read carries the override. It is not a client-level setting in viem,
    so leaving it off one call is a silent fall back to mainnet's resolver
    rather than an error — which is exactly the bug this module exists to make
    impossible to write.
  */
  const universalResolverAddress = ENS.universalResolver;

  return {
    client,

    async addressOf(name) {
      const value = await client.getEnsAddress({ name: ensName(name), universalResolverAddress });
      return value ?? null;
    },

    async textOf(name, key) {
      const value = await client.getEnsText({ name: ensName(name), key, universalResolverAddress });
      return value ?? null;
    },

    async resolverOf(name) {
      const value = await client.getEnsResolver({ name: ensName(name), universalResolverAddress });
      return value ?? null;
    },
  };
};
