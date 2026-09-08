/**
 * The key that signs ENS transactions.
 *
 * The same key everything else uses. That is the point rather than a
 * convenience: the address that owns `edgerouter.eth` is the address the
 * agent's names resolve to and the address that pays for inference, so a name
 * pointing at "the agent" points at something that actually acts. Two keys
 * would mean a name that resolves to an address which never does anything.
 *
 * Nothing here reads the key. `loadOrCreateEvmWallet` owns that, and this asks
 * it for a signer the way any other caller would.
 */
import { createPublicClient, createWalletClient, http, type Account, type PublicClient, type WalletClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import { loadOrCreateEvmWallet } from '../../sdk/src/index';
import { ENS_NETWORK, SEPOLIA_RPC } from './deployment';

export type EnsSigner = {
  account: Account;
  address: `0x${string}`;
  public: PublicClient;
  wallet: WalletClient;
  /** Where the key lives, so a message can tell the user. */
  path: string;
};

export const openEnsSigner = (options: { rpcUrl?: string; home?: string } = {}): EnsSigner => {
  const { wallet, path } = loadOrCreateEvmWallet({
    network: ENS_NETWORK,
    ...(options.home ? { home: options.home } : {}),
  });

  const account = privateKeyToAccount(wallet.exportPrivateKey() as `0x${string}`);
  const transport = http(options.rpcUrl ?? SEPOLIA_RPC);

  return {
    account,
    address: account.address,
    path,
    public: createPublicClient({ chain: sepolia, transport }) as PublicClient,
    wallet: createWalletClient({ account, chain: sepolia, transport }),
  };
};
