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
 * time and the name itself cannot say — what was granted — so an agent's
 * allowance is legible to anything that can resolve a name, without access to
 * the authority that holds the money. Who granted it is not a record, because
 * the name already spells that out; see `parentOf`. What is *left* of that
 * allowance is not here either, because only the authority knows it.
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
import { encodeFunctionData, parseAbi } from 'viem';
import { ensName } from './client';
import { sendCalls, type Call } from './batch';

/** Ethereum's SLIP-44 coin type. What `addr(name)` resolves to. */
export const ETH_COIN_TYPE = 60n;

/**
 * The keys this project writes.
 *
 * Namespaced, because a text record is a public key-value store shared with
 * every other application that might ever write to this name.
 */
export const RECORD = {
  /*
    Nothing about where an agent buys is written here.
    
    There was an `er.gate` key, holding the gate's URL, and it had no reader:
    the runtime takes the gate from its own configuration, the authority never
    consults it, and the guard only asks whether the name resolves. It cost a
    transaction per mint to publish an operator's endpoint that nothing
    resolved it for. A record with no consumer is not documentation, it is
    disclosure with a gas bill.
  */
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
  /*
    Who delegated to this name is not written here either.

    There was an `er.parent` key holding the delegating name, and it was a copy
    of something the name already says: `researcher.session-x.edgerouter.eth`
    was minted in the registry `session-x.edgerouter.eth` owns, so its parent is
    the name with its first label removed — the exact string the record held.
    The hierarchy is the delegation chain, and unlike a text record it cannot
    disagree with itself: a name's position in the tree is enforced by the
    registry that holds it, while a record is a claim written alongside.

    See `parentOf` in `agent.ts`, which is a string split and costs nothing.
  */
  /** Unix seconds after which the allowance is dead. */
  expires: 'er.expires',
} as const;

/**
 * The keys everyone else already reads.
 *
 * Deliberately not namespaced, unlike `RECORD` above. `display`, `avatar`,
 * `header` and `description` are the conventional ENS profile keys, so an agent
 * named here shows up with its picture in the ENS manager and anywhere else
 * that resolves names — which is the whole argument for these being real names
 * rather than rows in our database. A namespaced `er.avatar` would be correct,
 * private, and invisible.
 *
 * `display` is the odd one out, and worth explaining. It is the one key here
 * that is not a picture: `cto.edgerouter.eth` is what the chain calls the
 * agent, and "Chief Technical Officer" is what a person calls it. ENSIP-5
 * defines `display` as exactly that — "a canonical display name for the ENS
 * name" — and it is the right key even though almost nobody writes it today;
 * `avatar` and `description` are set on every profile worth looking at, and
 * `display` is null on all of them. It is kept anyway rather than namespaced as
 * `er.name`, because the two have the same number of readers right now and only
 * one of them is what a future reader would look for.
 */
export const PROFILE = {
  display: 'display',
  avatar: 'avatar',
  header: 'header',
  description: 'description',
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

/*
  Every write below exists twice: as a call that can be collected, and as a
  function that sends one immediately.

  The split is what lets a mint become a single transaction. A record write is
  just an address and some calldata until somebody decides how to deliver it,
  and once several of them are values rather than actions, sending them together
  is a choice the caller makes rather than a rewrite of everything that writes
  records. `sendCalls` then batches or falls back, and neither of these builders
  needs to know which happened.
*/

/** The call that points a name at the address acting for it. */
export const addressCall = (params: {
  resolver: Address;
  name: string;
  address: Address | '0x';
  coinType?: bigint;
}): Call => ({
  to: params.resolver,
  data: encodeFunctionData({
    abi: permissionedResolverAbi,
    functionName: 'setAddress',
    args: [
      dnsEncode(params.name),
      params.coinType ?? ETH_COIN_TYPE,
      params.address === '0x' ? '0x' : (params.address.toLowerCase() as `0x${string}`),
    ],
  }),
});

/** The call that writes one text record. */
export const textCall = (params: { resolver: Address; name: string; key: string; value: string }): Call => ({
  to: params.resolver,
  data: encodeFunctionData({
    abi: permissionedResolverAbi,
    functionName: 'setText',
    args: [dnsEncode(params.name), params.key, params.value],
  }),
});

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
 * Writes the parts of an agent anyone can see.
 *
 * Separate from `describeAgent` because these change and that does not. A name
 * is minted once with a grant; its picture and its description are
 * edited afterwards, possibly often, and each edit is a transaction the caller
 * chose to pay for. Only the keys actually passed are written, so editing a
 * description does not rewrite an avatar.
 */
export const setProfile = async (
  clients: Clients,
  params: {
    resolver: Address;
    name: string;
    /**
     * The display name — what a person calls this agent, as opposed to what it
     * is registered as. Called `display` here only because `name` above is
     * already taken by the name being written to.
     */
    display?: string;
    /** A URL, an ipfs:// URI, or a data: URI. ENS clients accept all three. */
    avatar?: string;
    header?: string;
    description?: string;
  },
): Promise<Hash[]> => {
  const entries: [string, string][] = [
    ...(params.display === undefined ? [] : ([[PROFILE.display, params.display]] as [string, string][])),
    ...(params.avatar === undefined ? [] : ([[PROFILE.avatar, params.avatar]] as [string, string][])),
    ...(params.header === undefined ? [] : ([[PROFILE.header, params.header]] as [string, string][])),
    ...(params.description === undefined
      ? []
      : ([[PROFILE.description, params.description]] as [string, string][])),
  ];

  return sendCalls(
    clients,
    entries.map(([key, value]) => textCall({ resolver: params.resolver, name: params.name, key, value })),
  );
};

type AgentRecords = {
  resolver: Address;
  name: string;
  address: Address;
  grantedMinor?: bigint;
  asset?: string;
  expiresAt?: number;
};

/** The text records a mint writes, in the order they are written. */
const textEntriesOf = (params: AgentRecords): [string, string][] => [
  ...(params.grantedMinor === undefined
    ? []
    : ([[RECORD.granted, params.grantedMinor.toString()]] as [string, string][])),
  ...(params.asset ? ([[RECORD.asset, params.asset]] as [string, string][]) : []),
  ...(params.expiresAt
    ? ([[RECORD.expires, String(Math.floor(params.expiresAt / 1000))]] as [string, string][])
    : []),
];

/**
 * The calls an agent's whole record is made of.
 *
 * Values rather than transactions, so `mintAgentName` can put its `register` in
 * front of them and hand the entire mint to one transaction. The address record
 * comes first because it is the one that matters — a name that resolves is what
 * the guard checks — and inside a batch the order is now the only thing that
 * distinguishes them, since either all of it lands or none of it does.
 */
export const describeAgentCalls = (params: AgentRecords): Call[] => [
  addressCall({ resolver: params.resolver, name: params.name, address: params.address }),
  ...textEntriesOf(params).map(([key, value]) =>
    textCall({ resolver: params.resolver, name: params.name, key, value }),
  ),
];

/**
 * Writes an agent's whole record.
 *
 * One transaction where the account is delegated, and one per record where it
 * is not. The partial write this used to defend as "legible" turned out to be
 * the expensive failure rather than an honest one: interrupted between the
 * address and the records, it left a name registered, resolving to nothing,
 * invisible to the app and impossible to mint again.
 */
export const describeAgent = async (clients: Clients, params: AgentRecords): Promise<Hash[]> =>
  sendCalls(clients, describeAgentCalls(params));
