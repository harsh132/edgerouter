/**
 * Paying the gate from a browser.
 *
 * The whole x402 exchange, and it is short enough to read in one sitting:
 *
 *   1. ask for something, unpaid
 *   2. the gate answers 402 with what it will accept
 *   3. sign one of those terms
 *   4. ask again with the signature in a header
 *
 * The gate settles before it serves, so a 200 means the money already moved.
 * There is no account, no key, and nothing to sign up for — which is the claim
 * this page exists to make legible.
 *
 * ## Why the payload is built by Circle's scheme
 *
 * On Arc the quote is a Gateway quote: the signature binds to the GatewayWallet
 * rather than to USDC, and Gateway settles it out of a deposited balance. That
 * is not a variation this code should implement from a spec — `BatchEvmScheme`
 * is the reference, and using it is the difference between paying and producing
 * a signature that verifies against nothing.
 */
import { BatchEvmScheme } from '@circle-fin/x402-batching/client';
import type { Wallet } from './wallet';

/** One payment option out of the 402's `accepts` list. */
export type Quote = {
  scheme: string;
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra?: Record<string, unknown>;
};

export type PaymentRequired = {
  x402Version: number;
  resource?: { url: string; description: string; mimeType: string };
  accepts: Quote[];
};

export type Paid = {
  /** What the gate returned once paid. */
  body: unknown;
  quote: Quote;
  /** Circle returns a batch id here rather than a transaction hash. */
  settlement: string | null;
  /** How long the whole exchange took, including both requests. */
  elapsedMs: number;
};

const HEADER = 'PAYMENT-SIGNATURE';
const RESPONSE_HEADER = 'PAYMENT-RESPONSE';

const encode = (value: unknown): string =>
  btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value))));

const decode = (value: string): unknown => {
  try {
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(value), (c) => c.charCodeAt(0))));
  } catch {
    return null;
  }
};

export class PaymentDeclined extends Error {}

/**
 * Buys one response.
 *
 * `onStep` exists because the interesting part of this is the sequence, not the
 * result — a demo that shows only the answer has hidden the thing worth seeing.
 */
export const payAndFetch = async (
  wallet: Wallet,
  params: {
    url: string;
    body: unknown;
    /** Which network to ask for, when the gate offers a choice. */
    network?: string;
    onStep?: (step: string, detail?: string) => void;
  },
): Promise<Paid> => {
  const started = Date.now();
  const step = params.onStep ?? (() => {});
  const target = params.network
    ? `${params.url}${params.url.includes('?') ? '&' : '?'}network=${encodeURIComponent(params.network)}`
    : params.url;

  step('Asking the gate', 'unpaid');
  const unpaid = await fetch(target, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params.body),
  });

  if (unpaid.ok) {
    // A gate that serves without payment is not this gate, but a client that
    // assumes otherwise would throw away a perfectly good response.
    step('Served without payment');
    return { body: await unpaid.json(), quote: null as never, settlement: null, elapsedMs: Date.now() - started };
  }
  if (unpaid.status !== 402) {
    throw new PaymentDeclined(`the gate answered ${unpaid.status}, not 402`);
  }

  const required = (await unpaid.json()) as PaymentRequired;
  const quote = required.accepts?.[0];
  if (!quote) throw new PaymentDeclined('the 402 carried no terms to accept');
  step('Quoted', `${quote.amount} on ${quote.network}`);

  /*
    The signature. `BatchEvmScheme` reads `extra` to decide what it is signing
    over — pass it a quote without batching metadata and it refuses, which is
    the correct failure and the reason this does not hand-roll the payload.
  */
  const scheme = new BatchEvmScheme({
    address: wallet.address,
    signTypedData: (parameters: unknown) => wallet.signTypedData(parameters),
  } as never);

  step('Signing', 'nothing is broadcast');
  const signed = await scheme.createPaymentPayload(required.x402Version ?? 2, quote as never);

  /*
    `resource` and `accepted` travel with the payload. Gateway requires both —
    they are optional in the published types and a 400 without them — and the
    gate needs to see the same terms it issued.
  */
  const payment = encode({
    ...signed,
    resource: required.resource,
    accepted: quote,
  });

  step('Paying', 'the gate settles before it serves');
  const paid = await fetch(target, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [HEADER]: payment },
    body: JSON.stringify(params.body),
  });

  if (!paid.ok) {
    const detail = await paid.text();
    throw new PaymentDeclined(`payment refused (${paid.status}): ${detail.slice(0, 300)}`);
  }

  const receipt = paid.headers.get(RESPONSE_HEADER);
  const settlement = receipt
    ? ((decode(receipt) as { transaction?: string } | null)?.transaction ?? null)
    : null;

  step('Served', settlement ? `settled ${settlement}` : 'settled');
  return { body: await paid.json(), quote, settlement, elapsedMs: Date.now() - started };
};
