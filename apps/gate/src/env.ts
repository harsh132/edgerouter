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
   * Prepaid tabs, one Durable Object per payer per network — see ./tab.
   *
   * Optional so a gate deployed without the binding still serves per-call
   * payments exactly as before; the tab routes answer that they are closed.
   */
  TAB?: DurableObjectNamespace<import('./tab').Tab>;
};

/**
 * Re-exported so the gate has one import for its own configuration surface.
 * The derivation itself lives in `@edgerouter/core`, because the budget
 * authority performs the identical one against its own secret.
 */
export { deriveRootKey } from '../../../packages/core/src/token';
