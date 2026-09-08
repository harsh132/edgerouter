/**
 * The wire between a budget authority and the agents that spend through it.
 *
 * Deliberately tiny, and deliberately not a general RPC. Three verbs — sign,
 * mint, revoke — plus one read. Everything a caller sends is treated as a
 * claim, never as a fact: the authority re-derives the amount, the host, and
 * the destination from what it is asked to sign, because those are the fields
 * the money follows.
 */
import type { PaymentRequirements } from '../pay/types';

/** `POST /sign` — "authorise this exact payment against my budget." */
export type SignRequest = {
  x402Version: number;
  /**
   * The requirement to sign, verbatim from the 402.
   *
   * The authority charges the budget the `amount` in *this* object, so a caller
   * cannot understate what a payment costs: the number it is charged and the
   * number it signs are the same number.
   */
  requirements: PaymentRequirements;
  /**
   * Where the 402 came from. Self-reported, and the only field here that is —
   * the `host` caveat is checked against it, and the authority's own `payTo`
   * allowlist exists because a self-reported URL cannot bind money.
   */
  resourceUrl?: string;
};

export type SignResponse = {
  /** The scheme payload, exactly as a local signer would have produced it. */
  payload: Record<string, unknown>;
  /** What is left in the caller's node after this payment. */
  remainingMinor: string;
};

/** `POST /mint` — "give one of my children part of what I hold." */
export type MintRequest = {
  /** Node id for the child. Any string; unique within the tree. */
  child: string;
  /** How much of the parent's balance to move into it, smallest unit. */
  amountMinor: string;
  /** Unix ms. Clamped down to the parent's expiry, never up. */
  expiresAt: number;
  /** Per-call ceiling. Defaults to the whole budget; clamped to the parent's. */
  ceilingMinor?: string;
  allowHosts?: readonly string[];
  maxDepth?: number;
};

export type MintResponse = {
  /** `er_<base64>` — ready to put straight in an Authorization header. */
  capability: string;
  child: string;
  amountMinor: string;
  expiresAt: number;
};

/** `POST /revoke` — "take it all back, and everything below it." */
export type RevokeRequest = { node: string };

export type RevokeResponse = {
  node: string;
  /** Returned to the revoking node. Includes whatever its descendants held. */
  recoveredMinor: string;
};

/** `GET /balances` — the caller's own node and everything beneath it. */
export type BalancesResponse = {
  account: string;
  network: string;
  nodes: readonly { id: string; parent: string | null; depth: number; balanceMinor: string }[];
};

/**
 * Why the authority refused.
 *
 * Distinct codes because each is a different thing to fix, and because a
 * sub-agent that hits `budget_exhausted` should stop rather than retry, while
 * one that hits `over_ceiling` should ask for less.
 */
export type AuthorityRefusal =
  | 'bad_request'
  | 'bad_capability'
  | 'unknown_node'
  | 'expired'
  | 'over_ceiling'
  | 'host_not_permitted'
  | 'unbounded_capability'
  | 'budget_exhausted'
  | 'name_not_resolving'
  | 'depth_exceeded'
  | 'duplicate_node'
  | 'not_a_descendant'
  | 'pay_to_not_permitted'
  | 'wrong_network'
  | 'signing_failed';

export type AuthorityError = { error: { code: AuthorityRefusal; detail: string } };
