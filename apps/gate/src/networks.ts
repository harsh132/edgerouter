/**
 * The networks the gate accepts payment on.
 *
 * Hedera is not "another EVM chain" as far as x402 is concerned, and treating
 * it as one produces a gate that quotes something no Hedera client can pay:
 *
 *   EVM      network `eip155:84532`, asset an ERC-20 address, payload an
 *            EIP-3009 signature plus an authorization object
 *   Hedera   network `hedera:testnet` (CAIP-2, not eip155), asset an entity id
 *            like `0.0.456858` with HBAR as `0.0.0`, payload a base64
 *            partially-signed TransferTransaction, and `extra.feePayer` is
 *            mandatory rather than optional
 *
 * They also price differently, which is the subtler trap. The price table is in
 * USD minor units — millionths of a dollar — because that is the only unit a
 * model price is meaningfully quoted in. USDC happens to have six decimals, so
 * on a USDC network the two coincide and no conversion is visible. HBAR has
 * eight decimals and its own exchange rate, so quoting a USD price directly as
 * tinybars charges about a thousandth of the intended amount and settles
 * perfectly while doing it. Every network therefore declares
 * `unitsPerUsdMinor`, and a network paid in HBAR must declare it explicitly.
 *
 * So the config is a discriminated union and every place that formats or reads
 * a payment branches on `kind`. There is deliberately no "generic" path that
 * papers over the difference — that path would silently produce EVM-shaped
 * quotes for Hedera and fail at the facilitator with something unhelpful.
 *
 * The 402 body carries an `accepts` array, so a server *may* quote several
 * networks at once. This one quotes exactly one per request: a client that
 * asked for Hedera and was handed a list would still have to be told which
 * entry we actually meant, and offering two chains we cannot both settle is
 * worse than offering the one we can. The client asks with `?network=` or the
 * `X-Payment-Network` header; otherwise it gets the configured default.
 */

export type NetworkConfig =
  | {
      kind: 'evm';
      /** CAIP-2 / EIP-155, e.g. `eip155:84532`. */
      id: string;
      /** ERC-20 contract address. */
      asset: string;
      /** Where payment lands. */
      payTo: string;
      /** EIP-712 domain, required for EIP-3009. */
      assetName: string;
      assetVersion: string;
      /** Smallest asset units per USD minor unit. 1 for a six-decimal stablecoin. */
      unitsPerUsdMinor: bigint;
      maxTimeoutSeconds: number;
      /**
       * Which facilitator settles this network, when not the default one.
       *
       * Per network rather than per gate, because no facilitator settles
       * everything and the ones that overlap do not overlap completely. A
       * single global facilitator means the gate can only ever offer that
       * facilitator's intersection with what it wants to accept.
       */
      facilitatorUrl?: string;
    }
  | {
      kind: 'hedera';
      /** `hedera:testnet` or `hedera:mainnet`. */
      id: string;
      /** Entity id. `0.0.0` is HBAR; anything else is an HTS token. */
      asset: string;
      /** Hedera account id, e.g. `0.0.1234`. */
      payTo: string;
      /**
       * Who pays the Hedera transaction fee.
       *
       * Named explicitly because the spec requires it: without a declared fee
       * payer the client could construct a transaction charging fees to someone
       * who never agreed to them.
       */
      feePayer: string;
      /**
       * Smallest asset units per USD minor unit.
       *
       * For an HTS stablecoin with six decimals this is 1. For HBAR it is a
       * rate — 1e8 tinybars per HBAR divided by the HBAR price in USD minor —
       * and it is a fixed number here rather than an oracle read, which is a
       * stated limitation: the quote drifts as the price moves.
       */
      unitsPerUsdMinor: bigint;
      maxTimeoutSeconds: number;
      /** See the EVM variant. Same field, same reason. */
      facilitatorUrl?: string;
    };

export type NetworkId = string;

/**
 * Parses the configured networks.
 *
 * Configuration is JSON in a var rather than a spread of scalar bindings,
 * because a gate that accepts two networks needs two of every field and
 * flat vars stop scaling at the second one.
 */
export const parseNetworks = (raw: string | undefined): Map<NetworkId, NetworkConfig> => {
  const out = new Map<NetworkId, NetworkConfig>();
  if (!raw) return out;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return out;
  }
  if (!Array.isArray(parsed)) return out;

  for (const entry of parsed) {
    const config = narrow(entry);
    if (config) out.set(config.id, config);
  }
  return out;
};

const str = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;

/**
 * Narrows one configured network, or drops it.
 *
 * A half-configured network is not loaded. Serving a quote with a missing
 * `feePayer` or an empty `payTo` would produce payments that cannot settle, or
 * settle to nobody — both worse than the network simply not being on offer.
 */
const narrow = (entry: unknown): NetworkConfig | null => {
  if (!entry || typeof entry !== 'object') return null;
  const e = entry as Record<string, unknown>;

  const id = str(e.id);
  const asset = str(e.asset);
  const payTo = str(e.payTo);
  if (!id || !asset || !payTo) return null;

  const timeout = typeof e.maxTimeoutSeconds === 'number' ? e.maxTimeoutSeconds : null;

  /*
    Accepted as a string so a large rate survives JSON, and refused rather than
    defaulted when it is not a positive integer — a zero or negative scale would
    quote a free or nonsensical price.
  */
  let scale: bigint | null = null;
  if (e.unitsPerUsdMinor !== undefined) {
    const raw = typeof e.unitsPerUsdMinor === 'number'
      ? String(e.unitsPerUsdMinor)
      : str(e.unitsPerUsdMinor);
    if (!raw || !/^\d+$/.test(raw)) return null;
    scale = BigInt(raw);
    if (scale <= 0n) return null;
  }

  /*
    Refused rather than ignored when malformed. A network silently falling back
    to the default facilitator is a network settling somewhere its operator did
    not choose, which is exactly the failure this field exists to prevent.
  */
  const facilitatorUrl = str(e.facilitatorUrl);
  if (e.facilitatorUrl !== undefined && !facilitatorUrl) return null;
  if (facilitatorUrl && !/^https:\/\//.test(facilitatorUrl)) return null;

  if (e.kind === 'hedera') {
    const feePayer = str(e.feePayer);
    if (!feePayer) return null;
    if (!/^hedera:(mainnet|testnet|previewnet)$/.test(id)) return null;
    if (!isEntityId(asset) || !isEntityId(payTo) || !isEntityId(feePayer)) return null;
    /*
      HBAR is not a dollar. A network paid in HBAR must say what a dollar is
      worth in tinybars; defaulting to 1 would quote a thousandth of the price
      and settle cleanly, which is the worst way for a pricing bug to behave.
      An HTS token is assumed to be a six-decimal stablecoin unless told
      otherwise, matching the EVM case.
    */
    if (isHbarAsset(asset) && scale === null) return null;
    // Hedera consensus is slower than a Base block; the spec's own example uses
    // 180 rather than the 60 an EVM quote gets.
    return {
      kind: 'hedera',
      id,
      asset,
      payTo,
      feePayer,
      unitsPerUsdMinor: scale ?? 1n,
      maxTimeoutSeconds: timeout ?? 180,
      ...(facilitatorUrl ? { facilitatorUrl } : {}),
    };
  }

  if (e.kind === 'evm') {
    if (!/^eip155:\d+$/.test(id)) return null;
    if (!isEvmAddress(asset) || !isEvmAddress(payTo)) return null;
    return {
      kind: 'evm',
      id,
      asset,
      payTo,
      assetName: str(e.assetName) ?? 'USDC',
      assetVersion: str(e.assetVersion) ?? '2',
      unitsPerUsdMinor: scale ?? 1n,
      maxTimeoutSeconds: timeout ?? 60,
      ...(facilitatorUrl ? { facilitatorUrl } : {}),
    };
  }

  return null;
};

/** `0.0.0` is x402's identifier for native HBAR, not an HTS token. */
export const isHbarAsset = (value: string): boolean => value === '0.0.0';
export const isEntityId = (value: string): boolean => /^\d+\.\d+\.\d+$/.test(value);
export const isEvmAddress = (value: string): boolean => /^0x[0-9a-fA-F]{40}$/.test(value);

/**
 * Compares two identifiers of the same network kind.
 *
 * EVM addresses are hex and case-insensitive — EIP-55 checksums mean the same
 * address legitimately appears in several casings. Hedera entity ids are
 * numeric and must match exactly; lowercasing them would be meaningless and
 * would hide a genuine mismatch.
 */
export const sameIdentifier = (kind: NetworkConfig['kind'], a: string, b: string): boolean =>
  kind === 'evm' ? a.toLowerCase() === b.toLowerCase() : a === b;

/**
 * Which network to quote for this request.
 *
 * An unknown request is refused rather than silently served on the default: a
 * client that asked to pay on Hedera and received a Base quote would sign
 * something it cannot settle, and would find out only after paying attention to
 * an error it had no way to predict.
 */
export const selectNetwork = (
  networks: Map<NetworkId, NetworkConfig>,
  request: Request,
  fallback: NetworkId | undefined,
): { ok: true; network: NetworkConfig } | { ok: false; asked: string } => {
  const url = new URL(request.url);
  const asked =
    url.searchParams.get('network') ?? request.headers.get('X-Payment-Network') ?? fallback ?? null;

  if (!asked) {
    const first = [...networks.values()][0];
    return first ? { ok: true, network: first } : { ok: false, asked: '(none configured)' };
  }

  const network = networks.get(asked);
  return network ? { ok: true, network } : { ok: false, asked };
};
