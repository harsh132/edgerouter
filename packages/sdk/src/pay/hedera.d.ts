/**
 * A Hedera signer for the `exact` scheme.
 *
 * Thin on purpose. `@x402/hedera` is the reference implementation, maintained
 * by the same people as the protocol, and reimplementing its transaction
 * construction would mean owning a set of details that are easy to get subtly
 * wrong and only fail at settlement:
 *
 *   - the transaction id is generated for the *fee payer*, not the payer, so
 *     the facilitator pays Hedera's fees and the payer only signs the transfer
 *   - HBAR (`0.0.0`) uses hbar transfers; anything else is an HTS token, which
 *     additionally requires the recipient to be associated with it
 *   - the transaction is frozen before signing and serialized to base64 bytes,
 *     partially signed — the facilitator adds the second signature
 *
 * What this module adds is a key that is read from the environment and never
 * logged, and a signer surface that does not expose the private key to the
 * payment loop at all.
 */
import { PrivateKey } from '@x402/hedera';
import type { PaymentSigner } from './types';
export declare const HEDERA_TESTNET = "hedera:testnet";
export declare const HEDERA_MAINNET = "hedera:mainnet";
/** x402's identifier for native HBAR. */
export declare const HBAR = "0.0.0";
/** Tinybars per HBAR. Amounts on Hedera are always in the smaller unit. */
export declare const TINYBARS_PER_HBAR = 100000000n;
/**
 * Parses a Hedera private key without caring which encoding it arrived in.
 *
 * Hedera accounts are ED25519 or ECDSA, and keys are handed out as raw hex, as
 * DER, and with or without a `0x`. Guessing wrong produces `INVALID_SIGNATURE`
 * at settlement — a long way from the actual mistake — so every form is tried
 * here instead.
 *
 * The thrown error deliberately does not include the input.
 */
export declare const parsePrivateKey: (raw: string) => PrivateKey;
/**
 * Builds a signer for one Hedera account.
 *
 * The key is converted once here and then held only by the underlying signer
 * closure. Nothing in this module returns it, prints it, or puts it in an
 * error message.
 */
export declare const hederaSigner: (params: {
    accountId: string;
    privateKey: string | PrivateKey;
    network?: string;
}) => PaymentSigner;
/** Formats tinybars for humans. Display only — never round-trip through this. */
export declare const formatHbar: (tinybars: bigint) => string;
