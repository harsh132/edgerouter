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
 * So the config is a discriminated union and every place that formats or reads
 * a payment branches on `kind`. There is deliberately no "generic" path that
 * papers over the difference — that path would silently produce EVM-shaped
 * quotes for Hedera and fail at the facilitator with something unhelpful.
 *
 * x402 v2 carries a single `paymentRequired` rather than v1's list of accepted
 * options, so the server names one network per request. The client asks for one
 * with `?network=` or the `X-Payment-Network` header; otherwise it gets the
 * configured default.
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
      maxTimeoutSeconds: number;
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
      maxTimeoutSeconds: number;
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

  if (e.kind === 'hedera') {
    const feePayer = str(e.feePayer);
    if (!feePayer) return null;
    if (!/^hedera:(mainnet|testnet|previewnet)$/.test(id)) return null;
    if (!isEntityId(asset) || !isEntityId(payTo) || !isEntityId(feePayer)) return null;
    // Hedera consensus is slower than a Base block; the spec's own example uses
    // 180 rather than the 60 an EVM quote gets.
    return { kind: 'hedera', id, asset, payTo, feePayer, maxTimeoutSeconds: timeout ?? 180 };
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
      maxTimeoutSeconds: timeout ?? 60,
    };
  }

  return null;
};

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
