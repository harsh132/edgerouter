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
import { createClientHederaSigner, PrivateKey } from '@x402/hedera';
import type { PaymentRequirements, PaymentSigner } from './types';

export const HEDERA_TESTNET = 'hedera:testnet';
export const HEDERA_MAINNET = 'hedera:mainnet';
/** x402's identifier for native HBAR. */
export const HBAR = '0.0.0';
/** Tinybars per HBAR. Amounts on Hedera are always in the smaller unit. */
export const TINYBARS_PER_HBAR = 100_000_000n;

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
export const parsePrivateKey = (raw: string): PrivateKey => {
  const text = raw.trim();
  if (!text) throw new Error('private key is empty');

  const attempts: Array<() => PrivateKey> = [
    () => PrivateKey.fromStringED25519(text),
    () => PrivateKey.fromStringECDSA(text),
    () => PrivateKey.fromStringDer(text),
  ];
  for (const attempt of attempts) {
    try {
      return attempt();
    } catch {
      /* try the next encoding */
    }
  }
  throw new Error('private key is not a recognised Hedera key (tried ED25519, ECDSA, DER)');
};

/**
 * Builds a signer for one Hedera account.
 *
 * The key is converted once here and then held only by the underlying signer
 * closure. Nothing in this module returns it, prints it, or puts it in an
 * error message.
 */
export const hederaSigner = (params: {
  accountId: string;
  privateKey: string | PrivateKey;
  network?: string;
}): PaymentSigner => {
  const network = params.network ?? HEDERA_TESTNET;
  const key =
    typeof params.privateKey === 'string' ? parsePrivateKey(params.privateKey) : params.privateKey;

  const inner = createClientHederaSigner(params.accountId, key, { network });

  return {
    network,
    accountId: inner.accountId,
    async createPayload(_x402Version: number, requirements: PaymentRequirements) {
      /*
        `extra.feePayer` is mandatory on Hedera and the reference signer throws
        without it. Checked here so the failure names the missing field rather
        than surfacing from inside a library.
      */
      const feePayer = requirements.extra?.feePayer;
      if (typeof feePayer !== 'string' || feePayer.length === 0) {
        throw new Error('the quote is missing extra.feePayer, which Hedera requires');
      }

      const transaction = await inner.createPartiallySignedTransferTransaction(
        requirements as never,
      );
      return { transaction };
    },
  };
};

/** Formats tinybars for humans. Display only — never round-trip through this. */
export const formatHbar = (tinybars: bigint): string => {
  const whole = tinybars / TINYBARS_PER_HBAR;
  const fraction = (tinybars % TINYBARS_PER_HBAR).toString().padStart(8, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction} ℏ` : `${whole} ℏ`;
};
