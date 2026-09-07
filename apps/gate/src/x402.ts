/**
 * x402 v2, resource-server side.
 *
 * Wire format is from the specification rather than memory, because the
 * protocol renamed its headers between v1 and v2 — `X-PAYMENT` became
 * `PAYMENT-SIGNATURE` — and a gate built against the older names is
 * interoperable with nothing.
 *
 *   402 response  →  header `Payment-Required`, body { x402Version, resource,
 *                    paymentRequired }
 *   client sends  →  header `PAYMENT-SIGNATURE`, base64 JSON payload
 *   we answer     →  header `PAYMENT-RESPONSE`, base64 settlement details
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

export type PaymentRequired = {
  scheme: 'exact';
  /** EIP-155 form, e.g. `eip155:84532`. */
  network: string;
  /** Smallest unit, as a string — precision must survive JSON. */
  amount: string;
  /** ERC-20 contract of the token being paid in. */
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: {
    assetTransferMethod: 'eip3009' | 'permit2' | 'erc7710';
    name?: string;
    version?: string;
  };
};

export type Requirements = {
  x402Version: typeof X402_VERSION;
  resource: Resource;
  paymentRequired: PaymentRequired;
};

/** What arrives in `PAYMENT-SIGNATURE`, once decoded. Entirely untrusted. */
export type PaymentPayload = {
  x402Version: number;
  resource: Resource;
  accepted: PaymentRequired;
  payload: Record<string, unknown>;
};

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
  amountMinor: bigint;
  description: string;
  config: {
    network: string;
    asset: string;
    payTo: string;
    assetName: string;
    assetVersion: string;
    maxTimeoutSeconds: number;
  };
}): Requirements => ({
  x402Version: X402_VERSION,
  resource: {
    url: new URL(params.request.url).toString(),
    description: params.description,
    mimeType: 'application/json',
  },
  paymentRequired: {
    scheme: 'exact',
    network: params.config.network,
    amount: params.amountMinor.toString(),
    asset: params.config.asset,
    payTo: params.config.payTo,
    maxTimeoutSeconds: params.config.maxTimeoutSeconds,
    extra: {
      assetTransferMethod: 'eip3009',
      name: params.config.assetName,
      version: params.config.assetVersion,
    },
  },
});

export const paymentRequiredResponse = (reqs: Requirements): Response =>
  new Response(JSON.stringify(reqs), {
    status: 402,
    headers: {
      'content-type': 'application/json',
      [HEADER.required]: base64(JSON.stringify(reqs)),
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
export const matchesQuote = (payment: PaymentPayload, reqs: Requirements): boolean => {
  const a = payment.accepted;
  const r = reqs.paymentRequired;
  return (
    a.scheme === r.scheme &&
    a.network === r.network &&
    a.asset.toLowerCase() === r.asset.toLowerCase() &&
    a.payTo.toLowerCase() === r.payTo.toLowerCase() &&
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
    response = await fetch(new URL(path, base), {
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
    const detail = typeof parsed.invalidReason === 'string' ? parsed.invalidReason : 'rejected';
    return { ok: false, reason: detail };
  }

  return { ok: true, body: parsed };
};

/** Does this signature actually pay these terms? Asked before serving. */
export const verifyPayment = (
  facilitator: { url: string; apiKey?: string },
  payment: PaymentPayload,
  reqs: Requirements,
): Promise<FacilitatorResult> =>
  facilitatorCall(
    facilitator.url,
    '/verify',
    { x402Version: X402_VERSION, paymentPayload: payment, paymentRequirements: reqs },
    facilitator.apiKey,
  );

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
  reqs: Requirements,
): Promise<FacilitatorResult> =>
  facilitatorCall(
    facilitator.url,
    '/settle',
    { x402Version: X402_VERSION, paymentPayload: payment, paymentRequirements: reqs },
    facilitator.apiKey,
  );
