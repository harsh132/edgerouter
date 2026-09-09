/**
 * Giving a session or a sub-agent a name.
 *
 * An allowance in the budget authority has always had an id — `researcher`,
 * `session-4f2a` — and that id has always been a string nobody could look up.
 * This makes it a name: `researcher.session-4f2a.edgerouter.eth`, minted in the
 * registry its parent owns, resolving to the address that pays for it, carrying
 * its budget as records anyone can read.
 *
 * ## Why the hierarchy is not decoration
 *
 * Each agent gets a registry of its own, so a sub-agent's name is minted *by
 * its parent*, in the parent's registry, under the parent's rules. That is the
 * same shape as the delegation itself: a parent may hand a child part of what
 * it holds and no more. In ENSv1 this would be one global registry and a
 * convention about dots; here the containment is real, and revoking a parent
 * takes its children with it because the registry they live in is the thing
 * that stops resolving.
 *
 * ## Names are not the money
 *
 * A name says who an agent is and what it was granted. It does not hold funds
 * and cannot authorise a payment — the authority does that, against a budget it
 * alone can spend, and a name that resolves is a necessary condition rather
 * than a sufficient one. Anything else would make an ENS record a bearer
 * instrument.
 */
import {
  keccak256,
  stringToHex,
  type Address,
  type Hash,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { encodeFunctionData } from 'viem';
import { registryAbi } from './abi';
import { sendCalls, type Call } from './batch';
import { ensName } from './client';
import { ALL_ROLES, deployRegistry, deployResolver } from './deploy';
import { clearAddress, describeAgentCalls, profileCalls, type ProfileRecords } from './records';

type Clients = { public: PublicClient; wallet: WalletClient };

/** A name's id inside its parent registry. */
export const labelIdOf = (label: string): bigint => BigInt(keccak256(stringToHex(ensName(label))));

/**
 * The id the registry actually stores a name under.
 *
 * ENSv2 token ids carry a version in their low 32 bits, and the registry
 * canonicalises by clearing them — so `ownerOf(labelIdOf(label))` asks about a
 * token that has never existed and answers with the zero address, for a name
 * that is registered and owned. Every read keyed by id has to canonicalise
 * first, or it quietly reports that nothing is there.
 *
 * This was not a theoretical problem: it made the "already registered to us,
 * carry on" recovery below unreachable, so a mint interrupted between
 * `register` and its records left a name that resolved to nothing, could not
 * be minted again, and could not be seen.
 */
export const canonicalIdOf = (label: string): bigint => labelIdOf(label) & ~((1n << 32n) - 1n);

/**
 * Who delegated to a name.
 *
 * A string split, because the hierarchy already holds this: a name is minted in
 * the registry its parent owns, so the parent is the name with its first label
 * removed. There is nothing to fetch, nothing to keep in sync, and no way for
 * the answer to disagree with the chain — which is more than a text record
 * saying the same thing could offer.
 *
 * Returns null at a name with nowhere above it to point.
 */
export const parentOf = (name: string): string | null => {
  const labels = ensName(name).split('.');
  return labels.length > 2 ? labels.slice(1).join('.') : null;
};

/** Far enough out that an agent does not expire mid-task. */
const DEFAULT_TTL_MS = 90 * 24 * 60 * 60 * 1000;

export type AgentName = {
  /** The full name, `researcher.session-x.edgerouter.eth`. */
  name: string;
  label: string;
  /** The registry this name was minted in — its parent's. */
  parentRegistry: Address;
  /** The registry this name owns, where its own sub-agents will be minted. */
  registry: Address;
  resolver: Address;
  /** Null when the name already existed, which is not a failure. */
  registerHash: Hash | null;
  /**
   * Whether the profile made it on chain.
   *
   * False means a name that works and has no picture — the mint was retried
   * without it. Reported rather than thrown, because the agent is usable and
   * the caller is the one who knows whether anybody needs telling.
   */
  profileWritten: boolean;
};

/**
 * Mints a name for an agent, and gives it what it needs to delegate further.
 *
 * Three steps, in an order that matters: the name is registered first, then
 * pointed at a resolver so records can be written, then given a registry of its
 * own so it can mint children. A name without the third step is a leaf — which
 * is the right shape for an agent that may spend but not sub-delegate, and is
 * why `subdelegate` is a parameter rather than an assumption.
 */
export const mintAgentName = async (
  clients: Clients,
  params: {
    /** The label to mint — `researcher`, not the full name. */
    label: string;
    /** The full name of the parent, whose registry this is minted in. */
    parent: string;
    parentRegistry: Address;
    /** Who owns the resulting name. The account that acts as this agent. */
    owner: Address;
    /** The address the name resolves to. Defaults to the owner. */
    address?: Address;
    resolver?: Address;
    /** Whether this agent may mint names beneath itself. */
    subdelegate?: boolean;
    grantedMinor?: bigint;
    asset?: string;
    expiresAt?: number;
    /**
     * What the name says about itself, written in the same transaction.
     *
     * Optional, and passed here rather than written afterwards because there is
     * no reason for a name and its face to be two transactions once they can be
     * one. See the retry below for what happens when the picture is the thing
     * that fails.
     */
    profile?: Omit<ProfileRecords, 'resolver' | 'name'>;
  },
): Promise<AgentName> => {
  const label = ensName(params.label);
  if (label.includes('.')) {
    throw new Error(`"${params.label}" is a name, not a label — pass "researcher", not the whole name`);
  }

  const name = `${label}.${ensName(params.parent)}`;
  const account = clients.wallet.account!;
  const owner = params.owner;
  const expiresAt = params.expiresAt ?? Date.now() + DEFAULT_TTL_MS;

  /*
    The resolver is per-account and deploys once, so asking for it here is
    cheap after the first time — `deployResolver` recovers the existing address
    rather than failing when the salt is taken.
  */
  const resolver = params.resolver ?? (await deployResolver(clients, { owner: account.address })).address;

  /*
    The registry this name will own. Deployed before registration because
    `register` takes it: a name pointed at its subregistry in one transaction is
    a name that never briefly exists without one.
  */
  const registry = params.subdelegate
    ? (await deployRegistry(clients, { name, owner, version: 1n })).address
    : ('0x0000000000000000000000000000000000000000' as Address);

  const registerArgs = [
    label,
    owner,
    registry,
    resolver,
    ALL_ROLES,
    BigInt(Math.floor(expiresAt / 1000)),
  ] as const;

  /*
    Registration is collected rather than sent, so it can travel with the
    records in one transaction. The simulation still runs first and is still the
    thing that catches a taken name — it is a read, it costs nothing, and
    without it the recovery below would have to distinguish "already ours" from
    every other revert by parsing a failed receipt.
  */
  let registerCall: Call | null = null;
  try {
    await clients.public.simulateContract({
      address: params.parentRegistry,
      abi: registryAbi,
      functionName: 'register',
      args: registerArgs,
      account,
    });
    registerCall = {
      to: params.parentRegistry,
      data: encodeFunctionData({ abi: registryAbi, functionName: 'register', args: registerArgs }),
    };
  } catch (error) {
    /*
      A name this account already minted is not an error — re-running a session
      setup should be safe. A name owned by someone else is, and says so.
    */
    const existing = await clients.public
      .readContract({
        address: params.parentRegistry,
        abi: registryAbi,
        functionName: 'ownerOf',
        args: [canonicalIdOf(label)],
      })
      .catch(() => null);

    /*
      The zero address is what an unregistered name reads as, not an owner.
      Treating it as one turns "register reverted for some other reason" into a
      confident and wrong claim about who holds the name.
    */
    if (!existing || existing === '0x0000000000000000000000000000000000000000') throw error;
    if (existing.toLowerCase() !== owner.toLowerCase()) {
      throw new Error(`${name} is already registered to ${existing}`);
    }
  }

  /*
    The whole mint, in one list: register the name, point it at an address, say
    what it was granted, and — when there is one — put its face on it. Batched
    this is a single receipt and an all-or-nothing outcome; unbatched it is
    exactly the sequence it always was.
  */
  const essential = [
    ...(registerCall ? [registerCall] : []),
    ...describeAgentCalls({
      resolver,
      name,
      address: params.address ?? owner,
      ...(params.grantedMinor === undefined ? {} : { grantedMinor: params.grantedMinor }),
      ...(params.asset ? { asset: params.asset } : {}),
      expiresAt,
    }),
  ];
  const decorative = params.profile ? profileCalls({ resolver, name, ...params.profile }) : [];

  /*
    The profile is attempted with the mint and retried without it.

    Atomicity cuts both ways here. Putting the picture in the batch is free when
    it works, and when it does not it takes the registration down with it — so a
    malformed avatar would cost the name, which is a worse trade than the extra
    transaction ever was. Retrying without the decorative calls means the
    failure mode is an agent that exists and looks plain, which is the same
    outcome the two-transaction version had, at one transaction when nothing is
    wrong.
  */
  let profileWritten = decorative.length > 0;
  let hashes: Hash[];
  try {
    hashes = await sendCalls(clients, [...essential, ...decorative]);
  } catch (error) {
    if (decorative.length === 0) throw error;
    profileWritten = false;
    hashes = await sendCalls(clients, essential);
  }

  return {
    name,
    label,
    parentRegistry: params.parentRegistry,
    registry,
    resolver,
    /*
      The transaction the registration went out in — which, when batched, is
      also the one that wrote every record. Null when the name already existed,
      which is not a failure and never was.
    */
    registerHash: registerCall ? (hashes[0] ?? null) : null,
    profileWritten,
  };
};

/**
 * Takes a name back.
 *
 * Two writes, and both are needed. That took two wrong versions to establish,
 * so the reasoning is worth keeping:
 *
 * Clearing the subregistry — the first attempt — removes the registry a name
 * *owns*. It stops everything beneath the name resolving and leaves the name
 * itself resolving exactly as before. That revokes an agent's children, not the
 * agent.
 *
 * `unregister` removes the registry entry, which ought to be enough and is not.
 * Every name in this project points at one resolver per account, and records
 * there are keyed by the full name. So after `unregister` the entry is gone,
 * resolution falls back to the closest ancestor resolver — which is the same
 * contract — and it still holds an address record for the full name. The name
 * resolves, from a registry entry that no longer exists.
 *
 * So the address record is cleared first, and that is the write that actually
 * revokes: `addressOf` returns nothing, and the guard refuses. `unregister`
 * follows to remove the entry and, with it, any registry the name owned — so
 * the agent's children go too.
 *
 * The order matters. Records first, because that is the half that stops the
 * spending; if the second write fails, the allowance is still revoked.
 *
 * Which is why this is the one sequence in this file that is deliberately *not*
 * batched. Atomicity is the wrong property here: a batch whose `unregister`
 * reverts would roll back the address clear too, and an agent nobody managed to
 * revoke is a worse outcome than a name left registered with nothing behind
 * it.
 *
 * This is the public half of what the authority does when it empties a node.
 * The authority's half is immediate and private; this one is verifiable by
 * anyone with an RPC endpoint and outlives the process that performed it.
 */
export const revokeAgentName = async (
  clients: Clients,
  params: { parentRegistry: Address; label: string; name?: string; resolver?: Address },
): Promise<Hash> => {
  if (params.name && params.resolver) {
    await clearAddress(clients, { resolver: params.resolver, name: params.name });
  }

  const anyId = labelIdOf(params.label);
  const { request } = await clients.public.simulateContract({
    address: params.parentRegistry,
    abi: registryAbi,
    functionName: 'unregister',
    args: [anyId],
    account: clients.wallet.account!,
  });
  const hash = await clients.wallet.writeContract(request);
  await clients.public.waitForTransactionReceipt({ hash });
  return hash;
};
