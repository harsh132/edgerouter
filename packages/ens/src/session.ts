/**
 * A name for this run, minted once and then found rather than re-minted.
 *
 * Every session getting a name is the goal; every session getting a
 * *transaction* is not. Minting costs gas and takes a block, so the first thing
 * this does is ask whether the name already resolves — which is both the cheap
 * path and the correct one, since a session that restarts is the same session
 * as far as its allowances are concerned.
 *
 * ## Where the label comes from
 *
 * Derived from the wallet, not random. Two properties follow, and both matter:
 * the same wallet always claims the same session name, so restarting DSH does
 * not litter the registry with abandoned names; and the label is not guessable
 * as a sequence, so it does not advertise how many sessions have existed.
 *
 * It is deliberately *not* derived from anything secret. A name is public the
 * moment it is minted, so deriving it from the key would leak nothing — but it
 * would make the label look like a commitment to the key, which it is not.
 */
import { keccak256, stringToHex, type Address, type PublicClient, type WalletClient } from 'viem';
import { registryAbi } from './abi';
import { createEnsClient, ensName, type EnsClient } from './client';
import { ENS } from './deployment';
import { mintAgentName, type AgentName } from './agent';

/** The name every agent name hangs from. */
export const ROOT_NAME = 'edgerouter.eth';

type Clients = { public: PublicClient; wallet: WalletClient };

/**
 * A short, stable label for a wallet's session.
 *
 * Eight hex characters of a hash — enough that two wallets colliding is not a
 * practical concern, short enough to read aloud in a demo.
 */
export const sessionLabelFor = (address: Address, seed = ''): string =>
  `s-${keccak256(stringToHex(`${address.toLowerCase()}/${seed}`)).slice(2, 10)}`;

/** The registry a name mints its children in, or null when it has none. */
export const registryOf = async (
  client: PublicClient,
  name: string,
): Promise<Address | null> => {
  const labels = ensName(name).replace(/\.eth$/, '').split('.').reverse();

  let registry: Address = ENS.ethRegistry;
  for (const label of labels) {
    const next: Address = await client.readContract({
      address: registry,
      abi: registryAbi,
      functionName: 'getSubregistry',
      args: [label],
    });
    if (next === '0x0000000000000000000000000000000000000000') return null;
    registry = next;
  }
  return registry;
};

export type EnsuredName = AgentName & {
  /** False when the name was already there — the common case after the first run. */
  minted: boolean;
};

/**
 * Makes sure a name exists, without minting one that already does.
 *
 * The resolution check is the whole point. `mintAgentName` is idempotent too,
 * but only by catching a revert *after* paying to simulate and by writing the
 * records again; asking first is one read and usually the end of it.
 */
export const ensureAgentName = async (
  clients: Clients,
  params: {
    label: string;
    parent?: string;
    owner: Address;
    subdelegate?: boolean;
    grantedMinor?: bigint;
    asset?: string;
    gate?: string;
    ens?: EnsClient;
  },
): Promise<EnsuredName> => {
  const parent = params.parent ?? ROOT_NAME;
  const name = `${ensName(params.label)}.${ensName(parent)}`;
  const ens = params.ens ?? createEnsClient();

  const existing = await ens.addressOf(name);
  if (existing) {
    const registry = (await registryOf(clients.public, name)) ?? ('0x0000000000000000000000000000000000000000' as Address);
    const resolver = (await ens.resolverOf(name))!;
    return {
      name,
      label: ensName(params.label),
      parentRegistry: (await registryOf(clients.public, parent))!,
      registry,
      resolver,
      registerHash: null,
      minted: false,
    };
  }

  const parentRegistry = await registryOf(clients.public, parent);
  if (!parentRegistry) {
    throw new Error(
      `${parent} owns no registry, so nothing can be minted under it — mint it with subdelegate first`,
    );
  }

  const agent = await mintAgentName(clients, {
    label: params.label,
    parent,
    parentRegistry,
    owner: params.owner,
    ...(params.subdelegate === undefined ? {} : { subdelegate: params.subdelegate }),
    ...(params.grantedMinor === undefined ? {} : { grantedMinor: params.grantedMinor }),
    ...(params.asset ? { asset: params.asset } : {}),
    ...(params.gate ? { gate: params.gate } : {}),
  });

  return { ...agent, minted: true };
};

/**
 * The name for this wallet's session, minted if it is not already there.
 *
 * Given a registry of its own, because a session's whole reason for having a
 * name is to hand names to the sub-agents it delegates to.
 */
export const ensureSessionName = async (
  clients: Clients,
  params: { owner: Address; seed?: string; gate?: string; ens?: EnsClient },
): Promise<EnsuredName> =>
  ensureAgentName(clients, {
    label: sessionLabelFor(params.owner, params.seed ?? ''),
    parent: ROOT_NAME,
    owner: params.owner,
    subdelegate: true,
    ...(params.gate ? { gate: params.gate } : {}),
    ...(params.ens ? { ens: params.ens } : {}),
  });
