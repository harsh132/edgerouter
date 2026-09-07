/**
 * A wallet the user never types.
 *
 * The alternative was asking for an account id and a private key, which is
 * developer UX wearing a product's clothes: it asks the user to handle the one
 * piece of material they must never mishandle, in a text field, in a config
 * file that syncs.
 *
 * So the plugin generates the key instead, and the user only ever sees an
 * address to send funds to. That works on Hedera because of auto account
 * creation (HIP-32, extended by HIP-542/583): an ECDSA public key yields an EVM
 * address, and the *first transfer to that address creates the account*. No
 * existing account has to pay a creation fee, nothing has to be registered, and
 * the key can be generated with no network at all.
 *
 * One consequence shapes everything here. Before the first transfer arrives
 * there is no account id — only an address that could become one. x402 signing
 * needs a real `0.0.x`, so "funded yet?" is a real state this module reports
 * rather than an error it throws from somewhere confusing:
 *
 *   generated  →  address shown, no account exists, cannot pay
 *   funded     →  account auto-created, id resolved, can pay
 *
 * ## What this is not
 *
 * A hot wallet. The key sits on disk so that an agent can spend without a
 * prompt, which is the entire point and also the entire risk. It is bounded the
 * only way that actually holds: by what the user chose to put in it. Treat it
 * like the cash in a coat pocket, not like a savings account — and `sweep`
 * exists so leaving is always possible.
 */
import {
  AccountBalanceQuery,
  AccountId,
  Client,
  Hbar,
  PrivateKey,
  TransferTransaction,
} from '@x402/hedera';
import { hederaSigner, HEDERA_TESTNET, TINYBARS_PER_HBAR } from '../pay/hedera';
import type { PaymentSigner } from '../pay/types';

const MIRROR: Record<string, string> = {
  'hedera:testnet': 'https://testnet.mirrornode.hedera.com',
  'hedera:mainnet': 'https://mainnet-public.mirrornode.hedera.com',
};

const NET: Record<string, 'testnet' | 'mainnet'> = {
  'hedera:testnet': 'testnet',
  'hedera:mainnet': 'mainnet',
};

/** Left behind on a sweep to cover the sweeping transaction's own fee. */
const SWEEP_RESERVE = 5_000_000n; // 0.05 ℏ

export type WalletMaterial = {
  /** DER-encoded. The only secret here, and the only field never displayed. */
  privateKey: string;
  /** Compressed ECDSA public key, hex. Public. */
  publicKey: string;
  /** `0x…`. What the user copies to send funds. */
  evmAddress: string;
  network: string;
  /** Cached once the account exists. Absent means "not funded yet". */
  accountId?: string;
};

/**
 * Generates a wallet. Offline, and ECDSA rather than ED25519.
 *
 * ECDSA because only an ECDSA key yields an EVM address, and the EVM address
 * is what makes this receivable: it is an address any wallet, exchange, or
 * faucet can send to without knowing anything about Hedera accounts. An
 * ED25519 key can be a public-key alias too, but far less software will send
 * to one, which defeats the purpose.
 */
export const generateWallet = (network = HEDERA_TESTNET): WalletMaterial => {
  const key = PrivateKey.generateECDSA();
  return {
    privateKey: key.toStringDer(),
    publicKey: key.publicKey.toStringRaw(),
    evmAddress: `0x${key.publicKey.toEvmAddress()}`,
    network,
  };
};

export type Funding =
  | { funded: false; evmAddress: string; balanceMinor: 0n }
  | { funded: true; accountId: string; evmAddress: string; balanceMinor: bigint };

export type LocalWallet = {
  /** `0x…`. Show this; it is the whole of the user-facing setup. */
  readonly evmAddress: string;
  readonly network: string;
  /** The resolved `0.0.x`, or null while nothing has been sent yet. */
  accountId(): string | null;
  /**
   * Asks the mirror node whether the account exists yet, and what it holds.
   *
   * Cheap and safe to poll — it is a read against a public mirror, not a
   * transaction — which is what lets a settings pane show a live balance while
   * the user is mid-transfer.
   */
  refresh(): Promise<Funding>;
  /** A signer for this wallet. Throws while unfunded, because there is no id. */
  signer(): PaymentSigner;
  /**
   * Moves everything out, minus a reserve for this transaction's own fee.
   *
   * Present because a wallet you cannot leave is a hostage. Whatever else is
   * true of a generated key, the funds in it must always be recoverable to an
   * account the user already controls.
   */
  sweep(to: string): Promise<{ transactionId: string; amountMinor: bigint }>;
  /** The private key, DER. Deliberate, explicit, and never called in passing. */
  exportPrivateKey(): string;
  /** The material, for persisting. Includes the key. */
  material(): WalletMaterial;
};

type MirrorAccount = {
  account?: string;
  balance?: { balance?: number };
};

/**
 * Looks the account up by its EVM address.
 *
 * By address rather than by public key because that endpoint answers for a
 * *hollow* account too — one auto-created by a transfer, before any transaction
 * of its own has completed it. That is precisely the state a freshly funded
 * wallet is in, so the query that works only after completion would report
 * "not funded" for a wallet holding money.
 */
const lookup = async (
  network: string,
  evmAddress: string,
  doFetch: typeof fetch,
): Promise<MirrorAccount | null> => {
  const base = MIRROR[network];
  if (!base) throw new Error(`no mirror node known for ${network}`);

  let response: Response;
  try {
    response = await doFetch(`${base}/api/v1/accounts/${evmAddress}?limit=1`);
  } catch (error) {
    throw new Error(`could not reach the mirror node: ${(error as Error).message}`);
  }
  // 404 is the normal answer for a wallet nobody has funded, not a failure.
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`the mirror node answered ${response.status}`);

  return (await response.json()) as MirrorAccount;
};

export const openWallet = (
  material: WalletMaterial,
  options: { fetch?: typeof fetch; onResolved?: (accountId: string) => void } = {},
): LocalWallet => {
  const doFetch = options.fetch ?? fetch;
  const network = material.network;
  const key = PrivateKey.fromStringDer(material.privateKey);
  let accountId = material.accountId ?? null;

  const client = (): Client => {
    if (!accountId) throw new Error('this wallet has no account yet — send it hbar first');
    const net = NET[network];
    if (!net) throw new Error(`unsupported network ${network}`);
    const c = net === 'mainnet' ? Client.forMainnet() : Client.forTestnet();
    c.setOperator(AccountId.fromString(accountId), key);
    return c;
  };

  return {
    evmAddress: material.evmAddress,
    network,
    accountId: () => accountId,

    async refresh(): Promise<Funding> {
      const found = await lookup(network, material.evmAddress, doFetch);
      if (!found?.account) {
        return { funded: false, evmAddress: material.evmAddress, balanceMinor: 0n };
      }
      if (found.account !== accountId) {
        accountId = found.account;
        options.onResolved?.(found.account);
      }
      return {
        funded: true,
        accountId: found.account,
        evmAddress: material.evmAddress,
        balanceMinor: BigInt(found.balance?.balance ?? 0),
      };
    },

    signer(): PaymentSigner {
      if (!accountId) {
        throw new Error(
          `this wallet is not funded yet — send hbar to ${material.evmAddress} and it will be created`,
        );
      }
      return hederaSigner({ accountId, privateKey: key, network });
    },

    async sweep(to) {
      if (!accountId) throw new Error('nothing to sweep — this wallet has never been funded');

      const c = client();
      const balance = await new AccountBalanceQuery()
        .setAccountId(AccountId.fromString(accountId))
        .execute(c);
      const held = BigInt(balance.hbars.toTinybars().toString());

      const amount = held - SWEEP_RESERVE;
      if (amount <= 0n) {
        throw new Error(
          `holds ${held} tinybars, which does not cover the ${SWEEP_RESERVE} reserved for the transfer fee`,
        );
      }

      const receipt = await (
        await new TransferTransaction()
          // The SDK takes tinybars as a string; a bigint is not one of the
          // types it accepts, and going through Number would silently lose
          // precision above 2^53 tinybars.
          .addHbarTransfer(AccountId.fromString(accountId), Hbar.fromTinybars((-amount).toString()))
          .addHbarTransfer(AccountId.fromString(to), Hbar.fromTinybars(amount.toString()))
          .execute(c)
      ).getReceipt(c);
      if (receipt.status.toString() !== 'SUCCESS') {
        throw new Error(`the sweep did not succeed: ${receipt.status.toString()}`);
      }

      return { transactionId: `${accountId}@sweep`, amountMinor: amount };
    },

    exportPrivateKey: () => material.privateKey,
    material: () => ({ ...material, ...(accountId ? { accountId } : {}) }),
  };
};

/** Tinybars as hbar, for a settings pane. Display only. */
export const hbarOf = (tinybars: bigint): string =>
  (Number(tinybars) / Number(TINYBARS_PER_HBAR)).toFixed(4);
