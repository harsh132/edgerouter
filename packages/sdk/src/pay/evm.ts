/**
 * An EVM signer for the `exact` scheme, over EIP-3009.
 *
 * Thin for the same reason `hedera.ts` is thin: `@x402/evm` is the reference
 * implementation, maintained alongside the protocol, and the details it owns
 * are exactly the ones that fail late and unhelpfully when reimplemented —
 *
 *   - the EIP-712 domain must match the token contract's own `name()` and
 *     `version()`. Get either wrong and the signature is valid over a message
 *     nobody will check, so it verifies against nothing and the facilitator
 *     reports a malformed payment rather than a wrong domain
 *   - `chainId` and `verifyingContract` are part of that domain, which is what
 *     stops a signature for one chain or token being replayed on another
 *   - the authorization carries a random 32-byte `nonce`, `validAfter` and
 *     `validBefore`; the token contract itself enforces single use
 *   - some assets route through Permit2 rather than EIP-3009, selected by
 *     `extra.assetTransferMethod` in the quote — which is the server's call,
 *     not the signer's
 *
 * ## One signer, many chains
 *
 * Nothing here is chain-specific. The chain and the token arrive in the quote,
 * the domain is built from them, and the same key is the same address on every
 * EVM chain — so this signs for Base, Arbitrum, Optimism or mainnet without a
 * line changing. What has to line up per chain is elsewhere: the facilitator
 * must settle it, and the asset must actually implement EIP-3009, which most
 * ERC-20s do not.
 *
 * Hedera and Solana are not "other chains" in this sense. They are different
 * schemes with different payload shapes, which is why they get their own
 * signers rather than a chain id.
 */
import { ExactEvmScheme } from '@x402/evm';
import { privateKeyToAccount } from 'viem/accounts';
import type { PaymentRequirements, PaymentSigner } from './types';

/** CAIP-2 for the chains this has been exercised against. */
export const POLYGON_AMOY = 'eip155:80002';
export const BASE_SEPOLIA = 'eip155:84532';
export const BASE = 'eip155:8453';

/** USDC and every other six-decimal stablecoin. Here for symmetry with HBAR. */
export const USDC_DECIMALS = 6;

/**
 * Reads the chain id out of a CAIP-2 network identifier.
 *
 * Refused rather than defaulted, because the chain id ends up inside the
 * EIP-712 domain: a wrong one produces a signature that is cryptographically
 * fine and semantically for a different chain.
 */
export const chainIdOf = (network: string): number => {
  const match = /^eip155:(\d+)$/.exec(network);
  if (!match) throw new Error(`not an EVM network identifier: ${network}`);
  return Number(match[1]);
};

/**
 * Normalises a private key without echoing it.
 *
 * Keys are handed out with and without `0x`, and viem accepts only the prefixed
 * form. The thrown error deliberately does not include the input — the same
 * rule the Hedera signer follows, for the same reason.
 */
export const parseEvmPrivateKey = (raw: string): `0x${string}` => {
  const text = raw.trim();
  if (!text) throw new Error('private key is empty');
  const hex = text.startsWith('0x') ? text.slice(2) : text;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error('private key is not 32 bytes of hex (with or without a 0x prefix)');
  }
  return `0x${hex}` as `0x${string}`;
};

/**
 * Builds a signer for one EVM account.
 *
 * The key is converted once and then held only by the viem account. Nothing
 * here returns it, prints it, or puts it in an error message.
 */
export const evmSigner = (params: {
  privateKey: string;
  /** CAIP-2, e.g. `eip155:80002`. Determines which quotes this will sign. */
  network: string;
}): PaymentSigner => {
  const network = params.network;
  // Validated at construction rather than at signing time, so a typo in a
  // config file fails while the user is looking at the config file.
  chainIdOf(network);

  const account = privateKeyToAccount(parseEvmPrivateKey(params.privateKey));
  const scheme = new ExactEvmScheme(account);

  return {
    network,
    accountId: account.address,
    async createPayload(x402Version: number, requirements: PaymentRequirements) {
      /*
        The EIP-712 domain comes from `extra`, and an absent one is not a
        recoverable default: signing with a guessed `name` or `version`
        produces a signature over a message the token will never validate.
        Checked here so the failure names the missing field rather than
        surfacing from inside a library as an opaque verification error.
      */
      const extra = requirements.extra ?? {};
      if (typeof extra.name !== 'string' || typeof extra.version !== 'string') {
        throw new Error(
          'the quote is missing extra.name or extra.version, which the EIP-712 domain requires',
        );
      }

      const result = await scheme.createPaymentPayload(x402Version, requirements as never);
      return result.payload as Record<string, unknown>;
    },
  };
};

/** Formats a six-decimal token amount for humans. Display only. */
export const formatUsdc = (units: bigint): string => {
  const whole = units / 1_000_000n;
  const fraction = (units % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction} USDC` : `${whole} USDC`;
};
