/**
 * The 402 loop: ask, get quoted, pay, ask again.
 *
 *   request  →  402 + accepts[]  →  choose  →  check  →  sign  →  retry
 *
 * Every decision that could cost money is made here, in the open, before the
 * signer is ever called. The signer's only job is to authorise the transfer it
 * is handed; it has no opinion about whether that transfer is a good idea. That
 * split is what makes a spend cap meaningful — a signer that also chose its own
 * amounts could not be capped by its caller.
 */
import {
  PaymentRefused,
  type PaymentPayload,
  type PaymentRequired,
  type PaymentRequirements,
  type PaymentSigner,
} from './types';

export const HEADER = {
  signature: 'PAYMENT-SIGNATURE',
  response: 'PAYMENT-RESPONSE',
} as const;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const base64 = (text: string): string => {
  const bytes = encoder.encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

export const unbase64 = (encoded: string): string | null => {
  try {
    const binary = atob(encoded.trim());
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return decoder.decode(bytes);
  } catch {
    return null;
  }
};

export type PayOptions = {
  signer: PaymentSigner;
  /**
   * The most this call may cost, in the asset's smallest unit.
   *
   * Required rather than optional. An uncapped payment client is one bad quote
   * away from signing whatever it is asked for, and the caller is the only
   * party that knows what this request is worth to them.
   */
  maxAmount: bigint;
  /** Standard `fetch` init. A body is read once and replayed on the retry. */
  init?: RequestInit & { body?: string };
  /** Override the network asked for. Defaults to the signer's. */
  network?: string;
  fetch?: typeof fetch;
};

export type PayResult = {
  response: Response;
  /** The requirement that was paid, or null when nothing was owed. */
  quote: PaymentRequirements | null;
  /** Decoded `PAYMENT-RESPONSE`, when the server sent one. */
  settlement: Record<string, unknown> | null;
  /** How many HTTP requests it took. 1 means the resource was free. */
  attempts: number;
  /** Milliseconds spent building and signing the payment. */
  signingMs: number;
  /** Milliseconds the paid request itself took, settlement included. */
  paidRequestMs: number;
};

/**
 * Picks the requirement to pay.
 *
 * Refuses rather than falls back. A client that quietly pays on a different
 * chain than it asked for, or at a price above its cap, has removed the only
 * two controls its caller has.
 */
export const selectRequirement = (
  required: PaymentRequired,
  options: { network: string; maxAmount: bigint; payerAccountId: string },
): PaymentRequirements => {
  if (!Array.isArray(required.accepts) || required.accepts.length === 0) {
    throw new PaymentRefused(
      'bad_quote',
      'the 402 body has no accepts[] — x402 v2 quotes are a list, even of one',
    );
  }

  const candidates = required.accepts.filter(
    (entry) => entry.scheme === 'exact' && entry.network === options.network,
  );
  if (candidates.length === 0) {
    const offered = required.accepts.map((entry) => `${entry.scheme}/${entry.network}`).join(', ');
    throw new PaymentRefused(
      'no_matching_network',
      `nothing payable on ${options.network}; the server offers ${offered || '(nothing)'}`,
    );
  }

  // Cheapest first, so a server offering the same network twice cannot make the
  // client pay the higher of the two by ordering them that way.
  candidates.sort((a, b) => (BigInt(a.amount) < BigInt(b.amount) ? -1 : 1));
  const chosen = candidates[0]!;

  let amount: bigint;
  try {
    amount = BigInt(chosen.amount);
  } catch {
    throw new PaymentRefused('bad_quote', `amount is not an integer: ${chosen.amount}`);
  }
  if (amount <= 0n) {
    throw new PaymentRefused('bad_quote', `amount must be positive, got ${chosen.amount}`);
  }
  if (amount > options.maxAmount) {
    throw new PaymentRefused(
      'over_max_amount',
      `quoted ${amount} but the cap for this call is ${options.maxAmount}`,
    );
  }

  /*
    Paying yourself is not a payment. Worth catching because it is the shape a
    misconfigured test takes — the same account in payTo and in the signer —
    and it would otherwise appear to succeed while proving nothing.
  */
  if (chosen.payTo === options.payerAccountId) {
    throw new PaymentRefused(
      'self_payment',
      `payTo is the payer's own account (${chosen.payTo})`,
    );
  }

  return chosen;
};

/**
 * Fetch a resource, paying for it if asked.
 *
 * A non-402 response is returned untouched on the first attempt, so this is
 * safe to use as a drop-in for `fetch` on endpoints that are sometimes free.
 */
export const payAndFetch = async (url: string, options: PayOptions): Promise<PayResult> => {
  const doFetch = options.fetch ?? fetch;
  const network = options.network ?? options.signer.network;
  const init = options.init ?? {};

  /*
    The network is asked for, not assumed.

    A gate that accepts several networks quotes exactly one per request and
    picks its own default when nobody says otherwise — so a client configured
    for Arc that sends nothing gets a Hedera quote, refuses it as unpayable, and
    reports that the server offers the wrong thing. The server was answering the
    question it was asked; the question was never posed.

    A header rather than a query parameter, so the caller's URL is handed back
    unchanged. The gate reads either.
  */
  const asking = {
    ...init,
    headers: { ...((init.headers ?? {}) as Record<string, string>), 'X-Payment-Network': network },
  };

  const first = await doFetch(url, asking);
  if (first.status !== 402) {
    return {
      response: first,
      quote: null,
      settlement: null,
      attempts: 1,
      signingMs: 0,
      paidRequestMs: 0,
    };
  }

  let required: PaymentRequired;
  try {
    required = (await first.clone().json()) as PaymentRequired;
  } catch {
    throw new PaymentRefused('bad_quote', 'the 402 response body was not JSON');
  }

  const quote = selectRequirement(required, {
    network,
    maxAmount: options.maxAmount,
    payerAccountId: options.signer.accountId,
  });

  const signStarted = Date.now();
  const payload = await options.signer.createPayload(required.x402Version, quote);
  const signingMs = Date.now() - signStarted;

  const payment: PaymentPayload = {
    x402Version: required.x402Version,
    resource: required.resource,
    accepted: quote,
    payload,
  };

  const paidStarted = Date.now();
  /*
    The same network header goes back with the payment. Without it the gate
    re-quotes its default and the terms it checks the signature against are not
    the terms that were signed — a mismatch, reported as a refused payment.
  */
  const second = await doFetch(url, {
    ...asking,
    headers: {
      ...asking.headers,
      [HEADER.signature]: base64(JSON.stringify(payment)),
    },
  });
  const paidRequestMs = Date.now() - paidStarted;

  return {
    response: second,
    quote,
    settlement: readSettlement(second),
    attempts: 2,
    signingMs,
    paidRequestMs,
  };
};

/** Decodes `PAYMENT-RESPONSE`, tolerating its absence. */
export const readSettlement = (response: Response): Record<string, unknown> | null => {
  const header = response.headers.get(HEADER.response);
  if (!header) return null;
  const json = unbase64(header);
  if (json === null) return null;
  try {
    const value = JSON.parse(json) as unknown;
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};
