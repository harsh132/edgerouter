/**
 * The buyer's wallet, in a browser.
 *
 * ## Why this is not the desktop wallet
 *
 * The DSH plugin keeps a key in a file, which is a hot wallet with a clear
 * boundary: one machine, one user account, and `sweep` as the way out. A browser
 * has no equivalent. `localStorage` is readable by any script that reaches the
 * page, so a key kept there is protected by the absence of an XSS bug rather
 * than by anything structural.
 *
 * That is stated in the UI rather than papered over, and it is why this holds
 * testnet funds and says so. The intended end state is a Privy embedded wallet,
 * where the key is not in the page at all and the signature comes back over an
 * authenticated channel — which is the whole reason to reach for one.
 *
 * So the seam is here from the start: everything downstream takes a `Wallet`,
 * and the local implementation is one of two. Swapping it is a constructor
 * change, not a refactor.
 */
import { privateKeyToAccount } from 'viem/accounts';
import type { Address, Hex } from 'viem';

export type Wallet = {
  address: Address;
  /** Signs EIP-712 typed data. The only capability a payment needs. */
  signTypedData(parameters: unknown): Promise<Hex>;
  /** Present only when the page itself holds the key. Absent for Privy. */
  exportPrivateKey?(): Hex;
  /** How the key is held, for the UI to be honest about. */
  custody: 'this browser' | 'privy';
};

const STORAGE_KEY = 'edgerouter.buyer.key';

const freshKey = (): Hex => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `0x${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
};

/**
 * A key kept in this browser, generated once.
 *
 * Persisted rather than regenerated per load, because a wallet that changes
 * every refresh cannot be funded — and being unfundable would make the honest
 * warning moot by making the thing unusable.
 */
export const localWallet = (): Wallet => {
  let key: Hex;
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    key = stored && /^0x[0-9a-fA-F]{64}$/.test(stored) ? (stored as Hex) : freshKey();
    localStorage.setItem(STORAGE_KEY, key);
  } catch {
    // Private windows and blocked site data both land here. The wallet still
    // works for this page load; it simply will not survive a refresh.
    key = freshKey();
  }

  const account = privateKeyToAccount(key);

  return {
    address: account.address,
    custody: 'this browser',
    signTypedData: (parameters) => account.signTypedData(parameters as never),
    exportPrivateKey: () => key,
  };
};
