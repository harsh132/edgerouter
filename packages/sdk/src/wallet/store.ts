/**
 * Where the generated key lives.
 *
 * Separate from `local.ts` so that module stays runtime-agnostic — the wallet
 * logic runs anywhere `fetch` does, and only this file needs a filesystem.
 *
 * ## On protecting it
 *
 * The file is written `0600` and its directory `0700`, which on Unix means the
 * user's other accounts cannot read it. On Windows those bits do nothing, and
 * saying otherwise would be worse than saying nothing, so `describe()` reports
 * what protection actually applies rather than a reassuring constant.
 *
 * It is not encrypted at rest. That is a deliberate choice, not an omission:
 * encryption needs a key, and the only key available without prompting the user
 * on every launch would have to sit beside the ciphertext — which protects
 * nothing and merely looks like it does. A passphrase would protect it, and
 * would also mean typing a passphrase before an agent can run unattended, which
 * is the property this whole design exists to provide.
 *
 * So the honest statement is the one in the README: this holds what the user
 * chose to put in it, and `sweep` gets it back out.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import {
  generateWallet,
  openWallet,
  rawKeyOf,
  walletFromKey,
  type LocalWallet,
  type WalletMaterial,
} from './local';
import {
  generateEvmWallet,
  openEvmWallet,
  type EvmWallet,
  type EvmWalletMaterial,
} from './evm-local';
import { HEDERA_TESTNET } from '../pay/hedera';

export const defaultHome = (): string =>
  process.env.EDGEROUTER_HOME ?? join(homedir(), '.edgerouter');

/**
 * One wallet per network — which is right for Hedera and wrong for EVM.
 *
 * A Hedera account id is issued per network, and the key type differs, so a
 * testnet wallet and a mainnet one genuinely are different wallets. On EVM they
 * are not: one secp256k1 key is the same address on every chain, which is a
 * property this codebase already relies on — the same signer pays on Base
 * Sepolia and on Base without a line changing.
 *
 * Kept only to find keys written in that older layout — see `adoptLegacy`.
 * Nothing writes this path any more; `sharedWalletPath` is where a wallet goes.
 */
export const walletPath = (network: string, home = defaultHome()): string =>
  join(home, `${network.replace(/[^\w.-]/g, '-')}.wallet.json`);

/**
 * The one wallet. One key, every chain, Hedera included.
 *
 * Hedera ECDSA keys are secp256k1, the same curve EVM uses — which is not a
 * coincidence this file exploits but the mechanism the whole design already
 * rested on: auto account creation works by deriving an EVM address from the
 * public key, so a Hedera wallet has always *had* an EVM address. Storing two
 * keys meant two addresses to fund, two faucet visits, and two things to back
 * up, for one agent.
 *
 * So there is one key, stored raw, and each chain is a way of asking it a
 * question. The user funds one address; it is their Hedera account and their
 * address on Sepolia and on Base.
 *
 * What this gives up is balance isolation between chains — one leaked key is
 * all of them. That is the same trade already made by storing the key
 * unencrypted: this is a hot wallet holding what you chose to put in it, so the
 * bound is the balance, not the filesystem. A deployment wanting separation
 * should use `EDGEROUTER_HOME` per profile rather than have this file quietly
 * hand out keys that differ by chain.
 */
export const sharedWalletPath = (home = defaultHome()): string => join(home, 'wallet.json');

/**
 * What is on disk.
 *
 * The key is stored raw — 32 bytes of hex — rather than in either SDK's
 * serialisation, because both can read it and neither owns it. `address` is
 * derived and stored only so the file is legible; nothing trusts it.
 */
export type StoredWallet = {
  privateKey: string;
  address: string;
  /**
   * Hedera account ids, keyed by network.
   *
   * A map rather than a field because the id is issued per network: the same
   * key is a different `0.0.x` on testnet and mainnet, and one field would
   * quietly report the wrong one. EVM chains need no entry at all — the address
   * is the account.
   */
  accounts?: Record<string, string>;
};

const readStored = (path: string): StoredWallet | null => {
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(`${path} exists but is not readable JSON; move it aside rather than losing it`);
  }
  const m = parsed as Record<string, unknown>;
  if (typeof m.privateKey !== 'string' || typeof m.address !== 'string') {
    throw new Error(`${path} is not an edgerouter wallet; move it aside rather than losing it`);
  }
  return {
    privateKey: m.privateKey,
    address: m.address,
    ...(m.accounts && typeof m.accounts === 'object'
      ? { accounts: m.accounts as Record<string, string> }
      : {}),
  };
};

const writeStored = (path: string, wallet: StoredWallet): void => {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(wallet, null, 2)}
`, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows. `describe()` is what tells the truth about this.
  }
};

/* ------------------------------------------------------------------ legacy */

/*
  The two shapes written before there was one wallet. Read-only, and used for
  exactly one purpose: finding a key that already holds money. Nothing writes
  these formats any more.
*/

const readMaterial = (path: string): WalletMaterial | null => {
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    /*
      Refused rather than replaced. Silently generating a fresh wallet over an
      unreadable one would abandon whatever the old key held — the file may be
      damaged, but the funds behind it are not.
    */
    throw new Error(`${path} exists but is not readable JSON; move it aside rather than losing it`);
  }
  const m = parsed as Record<string, unknown>;
  if (
    typeof m.privateKey !== 'string' ||
    typeof m.evmAddress !== 'string' ||
    typeof m.network !== 'string'
  ) {
    return null;
  }
  return {
    privateKey: m.privateKey,
    publicKey: typeof m.publicKey === 'string' ? m.publicKey : '',
    evmAddress: m.evmAddress,
    network: m.network,
    ...(typeof m.accountId === 'string' ? { accountId: m.accountId } : {}),
  };
};

const readEvmMaterial = (path: string): EvmWalletMaterial | null => {
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(`${path} exists but is not readable JSON; move it aside rather than losing it`);
  }
  const m = parsed as Record<string, unknown>;
  if (typeof m.privateKey !== 'string' || typeof m.address !== 'string') return null;
  return {
    privateKey: m.privateKey,
    address: m.address,
    network: typeof m.network === 'string' ? m.network : 'eip155:84532',
  };
};

/**
 * Finds a key written before there was one wallet.
 *
 * Earlier versions wrote `hedera-testnet.wallet.json` and `eip155-*.wallet.json`
 * and some of those addresses hold money. A fresh key beside them would not
 * destroy anything — the files remain — but it would put the funds somewhere
 * this code no longer looks, which is near enough to losing them.
 *
 * Hedera first, and deliberately: a Hedera key may already have an account id
 * bound to it by a transfer, and an account id is the one thing here that
 * cannot be re-derived from the key.
 */
const adoptLegacy = (home: string): StoredWallet | null => {
  if (!existsSync(home)) return null;
  const entries = readdirSync(home);

  const hedera = entries.filter((e) => /^hedera-\w+\.wallet\.json$/.test(e)).sort();
  for (const entry of hedera) {
    const material = readMaterial(join(home, entry));
    if (!material) continue;
    const network = material.network;
    return {
      privateKey: rawKeyOf(material.privateKey),
      address: material.evmAddress,
      ...(material.accountId ? { accounts: { [network]: material.accountId } } : {}),
    };
  }

  const evm = ['evm.wallet.json', ...entries.filter((e) => /^eip155-\d+\.wallet\.json$/.test(e))];
  for (const entry of evm) {
    const material = readEvmMaterial(join(home, entry));
    if (material) {
      return { privateKey: rawKeyOf(material.privateKey), address: material.address };
    }
  }
  return null;
};

/** Opens the one wallet, generating a key the first time. */
const openStored = (home: string): { stored: StoredWallet; created: boolean } => {
  const path = sharedWalletPath(home);
  const existing = readStored(path);
  if (existing) return { stored: existing, created: false };

  const adopted = adoptLegacy(home);
  if (adopted) {
    writeStored(path, adopted);
    return { stored: adopted, created: false };
  }

  const fresh = generateWallet();
  const stored: StoredWallet = {
    privateKey: rawKeyOf(fresh.privateKey),
    address: fresh.evmAddress,
  };
  writeStored(path, stored);
  return { stored, created: true };
};

export type WalletHandle = {
  wallet: LocalWallet;
  /** Where it is stored, so a UI can say so and a user can back it up. */
  path: string;
  /** True when this call generated the key. Worth telling the user once. */
  created: boolean;
};

/**
 * Opens the wallet as a Hedera account on one network.
 *
 * The resolved account id is written back as soon as the mirror node reports
 * it, so the id survives a restart and the plugin does not have to re-derive
 * "am I funded" on every launch. It is stored per network, because the same key
 * is a different `0.0.x` on testnet and on mainnet.
 */
export const loadOrCreateWallet = (
  options: { network?: string; home?: string; fetch?: typeof fetch } = {},
): WalletHandle => {
  const network = options.network ?? HEDERA_TESTNET;
  const home = options.home ?? defaultHome();
  const path = sharedWalletPath(home);
  const { stored, created } = openStored(home);

  const material = walletFromKey(stored.privateKey, network, stored.accounts?.[network]);

  const wallet = openWallet(material, {
    ...(options.fetch ? { fetch: options.fetch } : {}),
    onResolved: (accountId) =>
      writeStored(path, {
        ...stored,
        accounts: { ...(stored.accounts ?? {}), [network]: accountId },
      }),
  });

  return { wallet, path, created };
};

/** What protection the stored key actually has here. Not a reassuring guess. */
export const describe = (path: string): string =>
  platform() === 'win32'
    ? `${path} (readable by your Windows user account; not encrypted)`
    : `${path} (mode 0600, your user only; not encrypted)`;

export type EvmWalletHandle = {
  wallet: EvmWallet;
  path: string;
  created: boolean;
};

/**
 * Opens the wallet as an EVM account on one chain.
 *
 * The chain comes from the caller and is never read back out of the file: the
 * key does not belong to a chain, and treating a stored network as authoritative
 * is how a payment ends up signed for the wrong one.
 */
export const loadOrCreateEvmWallet = (
  options: { network: string; home?: string; rpcUrl?: string },
): EvmWalletHandle => {
  const home = options.home ?? defaultHome();
  const { stored, created } = openStored(home);

  return {
    wallet: openEvmWallet(
      { privateKey: `0x${stored.privateKey}`, address: stored.address, network: options.network },
      options.rpcUrl ? { rpcUrl: options.rpcUrl } : {},
    ),
    path: sharedWalletPath(home),
    created,
  };
};

/** True when a CAIP-2 identifier names an EVM chain rather than Hedera. */
export const isEvmNetwork = (network: string): boolean => /^eip155:\d+$/.test(network);
