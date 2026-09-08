import { sameIdentifier, type NetworkConfig } from './networks';

/**
 * x402 v2, resource-server side.
 *
 * Wire format is taken from `@x402/core`'s own types rather than from memory,
 * because two details are easy to get wrong and neither fails loudly:
 *
 *   1. v2 renamed the headers. `X-PAYMENT` became `PAYMENT-SIGNATURE`, and a
 *      gate built against the older name is interoperable with nothing.
 *   2. v2 did *not* collapse `accepts` into a single object. The 402 body still
 *      carries an array of requirements the client may choose between, exactly
 *      as v1 did. An earlier version of this file emitted a singular
 *      `paymentRequired`, which no standard client can read — `@x402/core`'s
 *      client looks for `paymentRequired.accepts` and would find nothing.
 *
 *   402 response  →  header `Payment-Required`, body { x402Version, resource,
 *                    accepts: [ ... ] }
 *   client sends  →  header `PAYMENT-SIGNATURE`, base64 JSON payload
 *   we answer     →  header `PAYMENT-RESPONSE`, base64 settlement details
 *
 * The facilitator is handed one *flat* `PaymentRequirements` — the entry the
 * client actually accepted — not the whole envelope. Sending the envelope makes
 * every verification fail with something unhelpful.
 *
 * Verification and settlement both go to a facilitator. This Worker never
 * touches a chain: it holds no key, signs nothing, and keeps no record of what
 * it has served. That is what lets it stay a stateless edge function.
 */

export const X402_VERSION = 2;

export const HEADER = {
  required: 'Payment-Required',
  signature: 'PAYMENT-SIGNATURE',
  response: 'PAYMENT-RESPONSE',
} as const;

export type Resource = {
  url: string;
  description: string;
  mimeType: string;
};

/**
 * One payment option. Flat, and the unit the facilitator speaks in.
 */
export type PaymentRequirements = {
  scheme: 'exact';
  /** CAIP-2. `eip155:84532` or `hedera:testnet` — the prefixes differ. */
  network: string;
  /** Smallest unit, as a string — precision must survive JSON. */
  amount: string;
  /** ERC-20 address on EVM; a Hedera entity id such as `0.0.456858` otherwise. */
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: EvmExtra | HederaExtra | GatewayExtra;
};

/** EIP-712 domain, so the client can build an EIP-3009 authorization. */
export type EvmExtra = {
  assetTransferMethod: 'eip3009' | 'permit2' | 'erc7710';
  name?: string;
  version?: string;
};

/**
 * What a Circle Gateway payment is signed against.
 *
 * `verifyingContract` is the GatewayWallet, not the token — that single field
 * is the difference between a signature Gateway accepts and one it does not,
 * and it is why this cannot be folded into `EvmExtra` with an optional flag.
 * `domain` is Circle's own chain numbering, which is not the chain id.
 */
export type GatewayExtra = {
  name: string;
  version: string;
  verifyingContract: string;
  domain: number;
};

/**
 * Hedera carries a fee payer instead of a transfer method.
 *
 * Mandatory rather than optional: the client builds the transaction, so without
 * a declared fee payer it could charge Hedera fees to an account that never
 * agreed to pay them.
 */
export type HederaExtra = {
  feePayer: string;
};

/** The 402 body. `accepts` is a list even when we only ever offer one entry. */
export type PaymentRequired = {
  x402Version: typeof X402_VERSION;
  resource: Resource;
  accepts: PaymentRequirements[];
};

/** What arrives in `PAYMENT-SIGNATURE`, once decoded. Entirely untrusted. */
export type PaymentPayload = {
  x402Version: number;
  resource?: Resource;
  accepted: PaymentRequirements;
  payload: Record<string, unknown>;
};

/**
 * The single option we are quoting.
 *
 * We offer one network per request, so this is `accepts[0]`. Named rather than
 * indexed inline so that the day we quote two, every caller that assumed one
 * shows up here instead of silently pricing the wrong chain.
 */
export const quoteOf = (required: PaymentRequired): PaymentRequirements => required.accepts[0]!;

/**
 * Builds the 402 a client needs in order to pay.
 *
 * `amount` is the price *this* request was quoted at. It is computed before the
 * upstream call and never re-derived afterwards, so a model that turns out to
 * be more expensive than quoted is the operator's loss rather than a surprise
 * charge — the alternative is billing for something the user never agreed to.
 */
export const requirements = (params: {
  request: Request;
  /** The price in USD minor units. Converted to the asset's units below. */
  amountMinor: bigint;
  description: string;
  network: NetworkConfig;
}): PaymentRequired => {
  /*
    The one conversion in the gate. Prices are quoted in USD minor units, but a
    payment is denominated in the asset — the same number means a thousandth of
    the price in tinybars as it does in USDC. Done here, once, so no caller has
    to remember which unit it is holding.
  */
  const amount = params.amountMinor * params.network.unitsPerUsdMinor;

  const common = {
    scheme: 'exact' as const,
    network: params.network.id,
    amount: amount.toString(),
    asset: params.network.asset,
    payTo: params.network.payTo,
    maxTimeoutSeconds: params.network.maxTimeoutSeconds,
  };

  const accepted: PaymentRequirements =
    params.network.kind === 'hedera'
      ? { ...common, extra: { feePayer: params.network.feePayer } }
      : params.network.kind === 'gateway'
        ? {
            ...common,
            extra: {
              name: params.network.assetName,
              version: params.network.assetVersion,
              verifyingContract: params.network.gatewayWallet,
              domain: params.network.gatewayDomain,
            },
          }
        : {
            ...common,
            extra: {
              assetTransferMethod: 'eip3009' as const,
              name: params.network.assetName,
              version: params.network.assetVersion,
            },
          };

  return {
    x402Version: X402_VERSION,
    resource: {
      url: new URL(params.request.url).toString(),
      description: params.description,
      mimeType: 'application/json',
    },
    accepts: [accepted],
  };
};

export const paymentRequiredResponse = (required: PaymentRequired): Response =>
  new Response(JSON.stringify(required), {
    status: 402,
    headers: {
      'content-type': 'application/json',
      [HEADER.required]: base64(JSON.stringify(required)),
    },
  });

/* ----------------------------------------------------------------- encoding */

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
    const binary = atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return decoder.decode(bytes);
  } catch {
    return null;
  }
};

/**
 * Parses `PAYMENT-SIGNATURE`.
 *
 * Narrowed rather than cast. Everything here was written by whoever called us,
 * and a payload we "repaired" into something plausible is a payment nobody
 * actually authorised.
 */
export const parsePayment = (header: string | null): PaymentPayload | null => {
  if (!header) return null;
  const json = unbase64(header.trim());
  if (json === null) return null;

  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object') return null;

  const p = value as Record<string, unknown>;
  if (typeof p.x402Version !== 'number') return null;
  if (!p.accepted || typeof p.accepted !== 'object') return null;
  if (!p.payload || typeof p.payload !== 'object') return null;

  const accepted = p.accepted as Record<string, unknown>;
  if (accepted.scheme !== 'exact') return null;
  if (typeof accepted.amount !== 'string' || !/^\d+$/.test(accepted.amount)) return null;
  if (typeof accepted.network !== 'string' || typeof accepted.payTo !== 'string') return null;
  if (typeof accepted.asset !== 'string') return null;

  /*
    The inner payload is shaped by the network, and an empty object would sail
    past a check that only looked at `accepted`. Hedera sends one base64 blob;
    EVM sends a signature plus the authorization it signs over.
  */
  const payload = p.payload as Record<string, unknown>;
  if (accepted.network.startsWith('hedera:')) {
    if (typeof payload.transaction !== 'string' || payload.transaction.length === 0) return null;
  } else {
    if (typeof payload.signature !== 'string' || !/^0x[0-9a-fA-F]+$/.test(payload.signature)) {
      return null;
    }
    if (!payload.authorization || typeof payload.authorization !== 'object') return null;
  }

  return value as PaymentPayload;
};

/**
 * Whether what the client agreed to matches what we asked for.
 *
 * Checked here, before the facilitator, because a facilitator verifies that a
 * signature is valid for the terms *in the payload* — not that those terms are
 * ours. A client that signs a correct payment for one cent against a request we
 * priced at one dollar produces a payload that verifies perfectly and underpays.
 */
export const matchesQuote = (
  payment: PaymentPayload,
  required: PaymentRequired,
  kind: NetworkConfig['kind'],
): boolean => {
  const a = payment.accepted;
  const r = quoteOf(required);
  return (
    a.scheme === r.scheme &&
    a.network === r.network &&
    sameIdentifier(kind, a.asset, r.asset) &&
    sameIdentifier(kind, a.payTo, r.payTo) &&
    // At least the quoted amount. Overpaying is the payer's business.
    BigInt(a.amount) >= BigInt(r.amount)
  );
};

/* -------------------------------------------------------------- facilitator */

export type FacilitatorResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; reason: string };

const facilitatorCall = async (
  base: string,
  path: '/verify' | '/settle',
  body: unknown,
  apiKey?: string,
): Promise<FacilitatorResult> => {
  let response: Response;
  try {
    /*
      Joined rather than resolved. `new URL('/verify', base)` discards any path
      on the base, so a facilitator hosted under one — x402.org/facilitator, for
      instance — would be called at the origin's root instead. That was
      invisible while every configured facilitator lived at a bare origin.
    */
    response = await fetch(`${base.replace(/\/+$/, '')}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    return { ok: false, reason: `facilitator unreachable: ${(error as Error).message}` };
  }

  const text = await response.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* a non-JSON body is reported through the status below */
  }

  if (!response.ok) {
    return { ok: false, reason: `facilitator ${response.status}: ${text.slice(0, 200)}` };
  }
  // Facilitators signal a rejected payment in the body, not the status.
  if (parsed.isValid === false || parsed.success === false) {
    const detail =
      typeof parsed.invalidReason === 'string'
        ? parsed.invalidReason
        : typeof parsed.errorReason === 'string'
          ? parsed.errorReason
          : 'rejected';
    return { ok: false, reason: detail };
  }

  return { ok: true, body: parsed };
};

/**
 * The body both facilitator endpoints take.
 *
 * `paymentRequirements` is the flat accepted entry, not the 402 envelope —
 * see the note at the top of this file.
 */
const facilitatorBody = (payment: PaymentPayload, required: PaymentRequired) => ({
  x402Version: X402_VERSION,
  /*
    Gateway wants `resource` and `accepted` inside the payload, and answers 400
    without them — they are optional in Circle's published types and required
    by the API. `accepted` is the entry the buyer agreed to, which Gateway
    re-derives the payment from rather than trusting the payload alone.

    Sent to every facilitator rather than only to Gateway: both fields are
    already in the 402 this gate issued, so they are true everywhere, and a
    facilitator that does not want them ignores them. The alternative is a
    branch on network kind inside the one function that should not care.
  */
  paymentPayload: {
    ...payment,
    resource: required.resource,
    accepted: quoteOf(required),
  },
  paymentRequirements: quoteOf(required),
});

/** Does this signature actually pay these terms? Asked before serving. */
export const verifyPayment = (
  facilitator: { url: string; apiKey?: string },
  payment: PaymentPayload,
  required: PaymentRequired,
): Promise<FacilitatorResult> =>
  facilitatorCall(facilitator.url, '/verify', facilitatorBody(payment, required), facilitator.apiKey);

/**
 * Move the money. Called *after* the upstream call succeeds.
 *
 * Ordering is deliberate. Settling first and then failing upstream charges for
 * something never delivered, and a refund path is state — which this service
 * does not have. Verify before, settle after: the failure mode becomes a
 * verified-but-unsettled payment, which costs the operator a call rather than
 * costing the user money.
 */
export const settlePayment = (
  facilitator: { url: string; apiKey?: string },
  payment: PaymentPayload,
  required: PaymentRequired,
): Promise<FacilitatorResult> =>
  facilitatorCall(facilitator.url, '/settle', facilitatorBody(payment, required), facilitator.apiKey);
