/**
 * The client half of x402.
 *
 * Shapes here mirror `@x402/core`'s types deliberately rather than importing
 * them, so the payment loop stays readable and the SDK does not force every
 * consumer to take a dependency on the reference implementation. Where they
 * differ from what you might expect from v1, the reason is noted.
 */
/** One payment option out of the 402's `accepts` list. */
export type PaymentRequirements = {
    scheme: string;
    /** CAIP-2: `eip155:84532`, `hedera:testnet`. */
    network: string;
    /** Smallest unit, as a string — tinybars on Hedera, token units elsewhere. */
    amount: string;
    asset: string;
    payTo: string;
    maxTimeoutSeconds: number;
    extra?: Record<string, unknown>;
};
export type ResourceInfo = {
    url: string;
    description?: string;
    mimeType?: string;
};
/**
 * The 402 body.
 *
 * `accepts` is an array. v2 renamed the headers but did not collapse this into
 * a single object — a client that reads a singular field finds nothing.
 */
export type PaymentRequired = {
    x402Version: number;
    error?: string;
    resource: ResourceInfo;
    accepts: PaymentRequirements[];
};
/** What goes back up in `PAYMENT-SIGNATURE`. */
export type PaymentPayload = {
    x402Version: number;
    resource?: ResourceInfo;
    accepted: PaymentRequirements;
    payload: Record<string, unknown>;
};
/**
 * Anything that can authorise one payment.
 *
 * Narrow on purpose: a signer names the one network it can pay on and turns a
 * requirement into a scheme payload. It never sees the HTTP request, never
 * chooses which requirement to accept, and never decides whether the amount is
 * acceptable — those are the caller's decisions, made in `payAndFetch` before
 * anything is signed.
 */
export type PaymentSigner = {
    /** CAIP-2 network this signer can pay on. */
    readonly network: string;
    /** Account the money leaves. Used for reporting and self-payment checks. */
    readonly accountId: string;
    createPayload(x402Version: number, requirements: PaymentRequirements): Promise<Record<string, unknown>>;
};
/** Why a payment was not attempted. Each value names one refusal. */
export type PayRefusal = 'no_matching_network' | 'over_max_amount' | 'self_payment' | 'bad_quote';
export declare class PaymentRefused extends Error {
    readonly reason: PayRefusal;
    constructor(reason: PayRefusal, message: string);
}
