/**
 * The same generated-wallet idea, on EVM chains.
 *
 * Simpler than the Hedera one in the one way that matters: an EVM address *is*
 * the account. There is no creation step, no auto-creation to rely on, and no
 * mirror-node lookup to turn an address into an id — a key exists, therefore an
 * address exists, therefore it can receive. The "generated but not funded yet"
 * state that shapes `local.ts` does not exist here.
 *
 * What replaces it is a different asymmetry, and it is worth stating plainly:
 *
 *   paying   costs no gas. EIP-3009 is an authorization the facilitator
 *            submits, so a wallet holding only USDC can pay indefinitely.
 *   leaving  costs gas. `sweep` sends an ordinary ERC-20 transfer, which this
 *            wallet must pay for in the chain's native token.
 *
 * So a wallet funded with USDC and nothing else can spend but cannot withdraw.
 * `sweep` says so rather than failing with an RPC error, because the fix — send
 * a little native token — is not one you would guess from `insufficient funds`.
 */
import { createPublicClient, createWalletClient, erc20Abi, http, type Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { evmSigner, chainIdOf, parseEvmPrivateKey } from '../pay/evm';
import type { PaymentSigner } from '../pay/types';

/**
 * Public RPCs, per chain.
 *
 * Only used for reading a balance and for the sweep. Payment needs none of
 * this — which is why a wrong or missing RPC degrades the wallet's *display*
 * and never its ability to pay.
 */
const RPC: Record<string, string> = {
  'eip155:80002': 'https://polygon-amoy-bor-rpc.publicnode.com',
  'eip155:8453': 'https://base-rpc.publicnode.com',
  'eip155:84532': 'https://base-sepolia-rpc.publicnode.com',
  'eip155:11155111': 'https://ethereum-sepolia-rpc.publicnode.com',
};

/** Circle's USDC, per chain. The asset the gate quotes. */
export const USDC: Record<string, Address> = {
  'eip155:80002': '0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582',
  'eip155:8453': '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  'eip155:84532': '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  /*
    Sepolia is not a chain the gate quotes; it is where ENSv2 lives. The token
    here is that deployment's own MockUSDC, which is what name registration is
    paid in — so a balance read on Sepolia answers the question actually being
    asked there, which is "can I afford to register a name", not "can I pay for
    inference".
  */
  'eip155:11155111': '0xcBFD80F74375c54E545AF34788Ff465F96F66F05',
};

export type EvmWalletMaterial = {
  /** `0x…`, 32 bytes of hex. The only secret here. */
  privateKey: string;
  /** `0x…`. Both the address and the account — there is nothing else. */
  address: string;
  network: string;
};

export const generateEvmWallet = (network: string): EvmWalletMaterial => {
  chainIdOf(network);
  // 32 random bytes is a secp256k1 private key with overwhelming probability;
  // viem rejects the vanishing remainder.
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const privateKey = `0x${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
  return {
    privateKey,
    address: privateKeyToAccount(privateKey as `0x${string}`).address,
    network,
  };
};

export type EvmFunding = {
  address: string;
  /** The token the gate quotes, in its smallest unit. Six decimals for USDC. */
  tokenMinor: bigint;
  /** The chain's own token, in wei. Needed only to leave, never to pay. */
  nativeWei: bigint;
  /** True when this wallet could pay a quote of that size right now. */
  canPay: boolean;
};

export type EvmWallet = {
  readonly address: string;
  readonly network: string;
  readonly asset: Address;
  signer(): PaymentSigner;
  refresh(): Promise<EvmFunding>;
  sweep(to: string): Promise<{ hash: string; amountMinor: bigint }>;
  exportPrivateKey(): string;
  material(): EvmWalletMaterial;
};

export const openEvmWallet = (
  material: EvmWalletMaterial,
  options: { rpcUrl?: string; asset?: Address } = {},
): EvmWallet => {
  const network = material.network;
  const rpcUrl = options.rpcUrl ?? RPC[network];
  const asset = options.asset ?? USDC[network];
  if (!asset) throw new Error(`no default asset known for ${network}; pass one explicitly`);

  const account = privateKeyToAccount(parseEvmPrivateKey(material.privateKey));
  const chain = { id: chainIdOf(network), name: network, nativeCurrency: { name: 'native', symbol: 'NATIVE', decimals: 18 }, rpcUrls: { default: { http: [rpcUrl ?? ''] } } } as const;

  const publicClient = () => {
    if (!rpcUrl) throw new Error(`no RPC configured for ${network}`);
    return createPublicClient({ chain, transport: http(rpcUrl) });
  };

  return {
    address: account.address,
    network,
    asset,

    signer: () => evmSigner({ privateKey: material.privateKey, network }),

    async refresh() {
      const client = publicClient();
      const [tokenMinor, nativeWei] = await Promise.all([
        client.readContract({
          address: asset,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [account.address],
        }) as Promise<bigint>,
        client.getBalance({ address: account.address }),
      ]);
      return { address: account.address, tokenMinor, nativeWei, canPay: tokenMinor > 0n };
    },

    async sweep(to) {
      const funding = await this.refresh();
      if (funding.tokenMinor <= 0n) throw new Error('nothing to sweep — this wallet holds no tokens');
      if (funding.nativeWei === 0n) {
        /*
          The asymmetry, said out loud. Paying needed no gas, so a wallet can
          arrive here having spent happily for weeks and still be unable to
          move. `insufficient funds for gas` would be a true and useless
          message; this one names the fix.
        */
        throw new Error(
          `this wallet holds tokens but no native ${network} balance, and an ERC-20 transfer costs gas — send a small amount of the chain's own token to ${account.address} first`,
        );
      }

      const wallet = createWalletClient({ account, chain, transport: http(rpcUrl!) });
      const hash = await wallet.writeContract({
        address: asset,
        abi: erc20Abi,
        functionName: 'transfer',
        args: [to as Address, funding.tokenMinor],
      });
      return { hash, amountMinor: funding.tokenMinor };
    },

    exportPrivateKey: () => material.privateKey,
    material: () => material,
  };
};
