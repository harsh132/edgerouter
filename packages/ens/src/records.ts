/**
 * Writing what a name says about itself.
 *
 * Two surprises live here, both of which cost time and neither of which is
 * guessable from ENSv1 experience.
 *
 * **Setters take a DNS-encoded name, not a namehash.** Every ENSv1 tutorial
 * hands the resolver `namehash(name)`; the v2 permissioned resolver wants the
 * wire format — each label length-prefixed, terminated by a zero byte. Reads
 * still go through the Universal Resolver, which takes names. So a name is
 * encoded one way to write and another to read, and `setAddr(bytes32,address)`
 * reverts rather than saying so.
 *
 * **The shared resolver refuses writes.** `PublicResolverV2` is pointed at by
 * default at registration, and every setter on it reverts for an ordinary
 * account — which reads exactly like a wrong ABI. Records are written to a
 * resolver the account deployed for itself; see `deploy.ts`.
 *
 * ## What an agent's name says
 *
 * The address record is the point: it is the account that actually pays, so a
 * name resolving to it names something that acts rather than something that
 * merely exists. The text records carry what the delegation tree knows at mint
 * time — what was granted, by whom, against which gate — so an agent's
 * allowance is legible to anything that can resolve a name, without access to
 * the authority that holds the money. What is *left* of that allowance is not
 * here, because only the authority knows it.
 */
import {
  concat,
  stringToHex,
  toHex,
  type Address,
  type Hash,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { parseAbi } from 'viem';
import { ensName } from './client';

/** Ethereum's SLIP-44 coin type. What `addr(name)` resolves to. */
export const ETH_COIN_TYPE = 60n;

/**
 * The keys this project writes.
 *
 * Namespaced, because a text record is a public key-value store shared with
 * every other application that might ever write to this name.
 */
export const RECORD = {
  /**
   * What this agent was granted at mint time, in the asset's smallest unit.
   *
   * Granted, not remaining — and the distinction is the honest one rather than
   * a nicety. This record is written once and never updated as the agent
   * spends, so calling it a balance would be a claim the chain cannot back. It
   * is worse than stale after a restart: the authority's tree lives in memory,
   * so the allowance may not exist at all while this record still stands.
   *
   * The remaining balance is the authority's to report, because the authority
   * is the only thing that knows it.
   */
  granted: 'er.granted',
  /** The asset that budget is denominated in — a CAIP-19 identifier. */
  asset: 'er.asset',
  /** The name that delegated to this one. Empty at the root. */
  parent: 'er.parent',
  /** Where this agent buys inference. */
  gate: 'er.gate',
  /** Unix seconds after which the allowance is dead. */
  expires: 'er.expires',
} as const;

export const permissionedResolverAbi = parseAbi([
  'function setAddress(bytes name, uint256 coinType, bytes addressBytes)',
  'function setText(bytes name, string key, string value)',
]);

/**
 * DNS wire format: `\x0aedgerouter\x03eth\x00`.
 *
 * Written out rather than imported because viem does not export its own
 * `packetToBytes`, and the encoding is four lines that are easier to read than
 * to depend on.
 */
export const dnsEncode = (name: string): `0x${string}` =>
  concat([
    ...ensName(name)
      .split('.')
      .map((label) => concat([toHex(label.length, { size: 1 }), stringToHex(label)])),
    '0x00',
  ]);

type Clients = { public: PublicClient; wallet: WalletClient };

/** Points a name at the address that acts for it. */
export const setAddress = async (
  clients: Clients,
  params: { resolver: Address; name: string; address: Address; coinType?: bigint },
): Promise<Hash> => {
  const hash = await clients.wallet.writeContract({
    address: params.resolver,
    abi: permissionedResolverAbi,
    functionName: 'setAddress',
    args: [
      dnsEncode(params.name),
      params.coinType ?? ETH_COIN_TYPE,
      params.address.toLowerCase() as `0x${string}`,
    ],
    account: clients.wallet.account!,
    chain: clients.wallet.chain!,
  });
  await clients.public.waitForTransactionReceipt({ hash });
  return hash;
};

/**
 * Removes the address a name points at.
 *
 * An empty value rather than a zero address, because those mean different
 * things: `0x000…0` is an address a name resolves *to*, and a resolver holding
 * one answers with it. Empty bytes are the absence of a record, which is what
 * makes `addressOf` return nothing — and nothing is what the guard refuses on.
 *
 * This is the operative write in a revocation. See `revokeAgentName`.
 */
export const clearAddress = async (
  clients: Clients,
  params: { resolver: Address; name: string; coinType?: bigint },
): Promise<Hash> => {
  const hash = await clients.wallet.writeContract({
    address: params.resolver,
    abi: permissionedResolverAbi,
    functionName: 'setAddress',
    args: [dnsEncode(params.name), params.coinType ?? ETH_COIN_TYPE, '0x'],
    account: clients.wallet.account!,
    chain: clients.wallet.chain!,
  });
  await clients.public.waitForTransactionReceipt({ hash });
  return hash;
};

/** Writes one text record. */
export const setText = async (
  clients: Clients,
  params: { resolver: Address; name: string; key: string; value: string },
): Promise<Hash> => {
  const hash = await clients.wallet.writeContract({
    address: params.resolver,
    abi: permissionedResolverAbi,
    functionName: 'setText',
    args: [dnsEncode(params.name), params.key, params.value],
    account: clients.wallet.account!,
    chain: clients.wallet.chain!,
  });
  await clients.public.waitForTransactionReceipt({ hash });
  return hash;
};

/**
 * Writes an agent's whole record in one pass.
 *
 * Sequential rather than batched, because each is its own transaction on this
 * deployment and a partial write is legible: a name with an address and no
 * grant is an agent that exists and has been given nothing, which is a true
 * statement about a failed mint.
 */
export const describeAgent = async (
  clients: Clients,
  params: {
    resolver: Address;
    name: string;
    address: Address;
    grantedMinor?: bigint;
    asset?: string;
    parent?: string;
    gate?: string;
    expiresAt?: number;
  },
): Promise<{ address: Hash; texts: Hash[] }> => {
  const address = await setAddress(clients, {
    resolver: params.resolver,
    name: params.name,
    address: params.address,
  });

  const entries: [string, string][] = [
    ...(params.grantedMinor === undefined
      ? []
      : ([[RECORD.granted, params.grantedMinor.toString()]] as [string, string][])),
    ...(params.asset ? ([[RECORD.asset, params.asset]] as [string, string][]) : []),
    ...(params.parent ? ([[RECORD.parent, params.parent]] as [string, string][]) : []),
    ...(params.gate ? ([[RECORD.gate, params.gate]] as [string, string][]) : []),
    ...(params.expiresAt
      ? ([[RECORD.expires, String(Math.floor(params.expiresAt / 1000))]] as [string, string][])
      : []),
  ];

  const texts: Hash[] = [];
  for (const [key, value] of entries) {
    texts.push(await setText(clients, { resolver: params.resolver, name: params.name, key, value }));
  }

  return { address, texts };
};
