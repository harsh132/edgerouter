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
import { type PaymentRequired, type PaymentRequirements, type PaymentSigner } from './types';
export declare const HEADER: {
    readonly signature: "PAYMENT-SIGNATURE";
    readonly response: "PAYMENT-RESPONSE";
};
export declare const base64: (text: string) => string;
export declare const unbase64: (encoded: string) => string | null;
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
    init?: RequestInit & {
        body?: string;
    };
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
export declare const selectRequirement: (required: PaymentRequired, options: {
    network: string;
    maxAmount: bigint;
    payerAccountId: string;
}) => PaymentRequirements;
/**
 * Fetch a resource, paying for it if asked.
 *
 * A non-402 response is returned untouched on the first attempt, so this is
 * safe to use as a drop-in for `fetch` on endpoints that are sometimes free.
 */
export declare const payAndFetch: (url: string, options: PayOptions) => Promise<PayResult>;
/** Decodes `PAYMENT-RESPONSE`, tolerating its absence. */
export declare const readSettlement: (response: Response) => Record<string, unknown> | null;
