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
import { generateWallet, openWallet, type LocalWallet, type WalletMaterial } from './local';
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
 * Sepolia and on Base without a line changing. See `evmWalletPath`.
 */
export const walletPath = (network: string, home = defaultHome()): string =>
  join(home, `${network.replace(/[^\w.-]/g, '-')}.wallet.json`);

/**
 * The one EVM wallet, shared by every chain.
 *
 * A key per chain would mean funding a separate address for Base Sepolia,
 * Sepolia, and anywhere else this ever pays or registers a name — three
 * addresses that are all "your wallet" and none of which is. The chain is a
 * property of the *request*, not of the key.
 *
 * What that gives up is balance isolation: one leaked key is every EVM chain,
 * mainnet included. That is a real trade and it is the same one already made by
 * storing the key unencrypted — this is a hot wallet holding what you chose to
 * put in it, so the protection is the balance, not the filesystem. A mainnet
 * deployment wanting isolation should set `EDGEROUTER_HOME` per profile rather
 * than have this file quietly hand out different keys.
 */
export const evmWalletPath = (home = defaultHome()): string => join(home, 'evm.wallet.json');

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
    typeof m.publicKey !== 'string' ||
    typeof m.evmAddress !== 'string' ||
    typeof m.network !== 'string'
  ) {
    throw new Error(`${path} is not an edgerouter wallet; move it aside rather than losing it`);
  }
  return {
    privateKey: m.privateKey,
    publicKey: m.publicKey,
    evmAddress: m.evmAddress,
    network: m.network,
    ...(typeof m.accountId === 'string' ? { accountId: m.accountId } : {}),
  };
};

const write = (path: string, material: WalletMaterial): void => {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(material, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows, or an exotic filesystem. `describe()` is what tells the truth
    // about this; failing the write over it would help nobody.
  }
};

export type WalletHandle = {
  wallet: LocalWallet;
  /** Where it is stored, so a UI can say so and a user can back it up. */
  path: string;
  /** True when this call generated it. Worth telling the user once. */
  created: boolean;
};

/**
 * Opens the wallet for a network, creating one the first time.
 *
 * The resolved account id is written back as soon as the mirror node reports
 * it, so the id survives a restart and the plugin does not have to re-derive
 * "am I funded" from the network on every launch.
 */
export const loadOrCreateWallet = (
  options: { network?: string; home?: string; fetch?: typeof fetch } = {},
): WalletHandle => {
  const network = options.network ?? HEDERA_TESTNET;
  const path = walletPath(network, options.home ?? defaultHome());

  const existing = readMaterial(path);
  const material = existing ?? generateWallet(network);
  if (!existing) write(path, material);

  const wallet = openWallet(material, {
    ...(options.fetch ? { fetch: options.fetch } : {}),
    onResolved: (accountId) => write(path, { ...material, accountId }),
  });

  return { wallet, path, created: existing === null };
};

/** What protection the stored key actually has here. Not a reassuring guess. */
export const describe = (path: string): string =>
  platform() === 'win32'
    ? `${path} (readable by your Windows user account; not encrypted)`
    : `${path} (mode 0600, your user only; not encrypted)`;

/* --------------------------------------------------------------------- EVM */

const readEvmMaterial = (path: string): EvmWalletMaterial | null => {
  if (!existsSync(path)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(`${path} exists but is not readable JSON; move it aside rather than losing it`);
  }
  const m = parsed as Record<string, unknown>;
  if (
    typeof m.privateKey !== 'string' ||
    typeof m.address !== 'string' ||
    typeof m.network !== 'string'
  ) {
    throw new Error(`${path} is not an edgerouter EVM wallet; move it aside rather than losing it`);
  }
  return { privateKey: m.privateKey, address: m.address, network: m.network };
};

export type EvmWalletHandle = {
  wallet: EvmWallet;
  path: string;
  created: boolean;
};

/**
 * Finds a key written before this file kept one wallet per key rather than per
 * chain.
 *
 * Earlier versions stored `eip155-84532.wallet.json` and friends, and some of
 * those addresses hold money. Generating a fresh shared wallet beside them
 * would not lose the funds — the old file is still there — but it would put
 * them somewhere the plugin no longer looks, which is close enough to losing
 * them to be worth this function.
 *
 * The chain being opened wins, and otherwise the lowest chain id, so the answer
 * does not depend on directory ordering.
 */
const adoptLegacyEvmMaterial = (home: string, network: string): EvmWalletMaterial | null => {
  const preferred = readEvmMaterial(walletPath(network, home));
  if (preferred) return preferred;

  if (!existsSync(home)) return null;
  const legacy = readdirSync(home)
    .filter((entry) => /^eip155-\d+\.wallet\.json$/.test(entry))
    .sort((a, b) => Number(/\d+/.exec(a)![0]) - Number(/\d+/.exec(b)![0]));

  for (const entry of legacy) {
    const material = readEvmMaterial(join(home, entry));
    if (material) return material;
  }
  return null;
};

/**
 * Opens the EVM wallet, creating one the first time.
 *
 * One key for every EVM chain: the network is applied to the wallet that is
 * returned, never stored as a property of the key. So the same address pays on
 * Base Sepolia and registers a name on Sepolia, and funding it once is enough.
 *
 * No account id is written back, because an EVM address is the account — the
 * file never changes after it is written, which is one fewer moment at which a
 * key file can be corrupted.
 */
export const loadOrCreateEvmWallet = (
  options: { network: string; home?: string; rpcUrl?: string },
): EvmWalletHandle => {
  const home = options.home ?? defaultHome();
  const path = evmWalletPath(home);

  const shared = readEvmMaterial(path);
  const adopted = shared ?? adoptLegacyEvmMaterial(home, options.network);
  const material = adopted ?? generateEvmWallet(options.network);
  /*
    Written whenever it was not already at the shared path — so adopting an old
    per-chain key copies it here rather than moving it. The original stays put:
    the point is that the plugin can find the money, not that the previous file
    stops existing.
  */
  if (!shared) write(path, material as unknown as WalletMaterial);

  /*
    The chain comes from the caller, not from the file. A key adopted from
    `eip155-84532.wallet.json` says "Base Sepolia" inside it, and using that
    would silently pay on the wrong chain.
  */
  const onNetwork = { ...material, network: options.network };

  return {
    wallet: openEvmWallet(onNetwork, options.rpcUrl ? { rpcUrl: options.rpcUrl } : {}),
    path,
    created: adopted === null,
  };
};

/** True when a CAIP-2 identifier names an EVM chain rather than Hedera. */
export const isEvmNetwork = (network: string): boolean => /^eip155:\d+$/.test(network);
