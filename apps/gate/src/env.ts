/**
 * Configuration, and how a root key is produced without storing one.
 *
 * The gate is stateless, so it cannot look up a per-user key. Instead each
 * root's key is derived from one service secret and the root's own name:
 *
 *   rootKey = HMAC(SERVICE_SECRET, "edgerouter/root/" + rootName)
 *
 * Two properties fall out. Every root gets a distinct key, so a capability
 * minted for one root cannot verify against another. And nothing has to be
 * remembered, so the Worker can run anywhere without a database behind it.
 */

export type Env = {
  /** Secret. The only thing the gate needs to verify every capability. */
  SERVICE_SECRET?: string;

  /** x402 facilitator. Absent means paid routes are closed, not open. */
  FACILITATOR_URL?: string;
  FACILITATOR_API_KEY?: string;

  /** EIP-155 network, e.g. `eip155:84532`. */
  PAYMENT_NETWORK: string;
  /** ERC-20 contract payments are denominated in. */
  PAYMENT_ASSET: string;
  /** Where payments land. */
  PAYMENT_PAY_TO: string;
  PAYMENT_ASSET_NAME?: string;
  PAYMENT_ASSET_VERSION?: string;

  /** Upstream inference. Any OpenAI-compatible endpoint. */
  OPENROUTER_API_KEY?: string;
  UPSTREAM_URL?: string;
};

const encoder = new TextEncoder();

export const deriveRootKey = async (secret: string, root: string): Promise<Uint8Array> => {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(`edgerouter/root/${root}`));
  return new Uint8Array(sig);
};
