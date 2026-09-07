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

  /**
   * Accepted networks, as a JSON array of NetworkConfig — see ./networks.
   *
   * A list rather than a spread of scalars, because Hedera and EVM need
   * different fields and flat vars stop scaling at the second network.
   */
  NETWORKS?: string;
  /** Which one to quote when the client does not ask for a specific network. */
  DEFAULT_NETWORK?: string;

  /** Upstream inference. Any OpenAI-compatible endpoint. */
  OPENROUTER_API_KEY?: string;
  UPSTREAM_URL?: string;

  /**
   * Unsettled-debt ledger.
   *
   * The only state the gate keeps, and it is deliberately the kind that can be
   * lost without harm: losing it forgets who owes what, which costs the
   * operator money but never wrongly refuses a paying user. KV's eventual
   * consistency is acceptable for the same reason — a debtor slipping through
   * for a few seconds after a write is a bounded loss, and the alternative is
   * a strongly consistent store in the hot path of every request.
   */
  DEBT?: KVNamespace;
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
