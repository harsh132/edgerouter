/**
 * Circle Gateway balances, for the chains our gate quotes that way.
 *
 * Kept apart from `evm-local.ts` because it answers a different question about
 * the same wallet. Everywhere else, "can this wallet pay" means "does it hold
 * the token". On a Gateway network it does not: payment comes from a balance
 * deposited into the GatewayWallet contract, so an address holding twenty USDC
 * and nothing deposited can pay for exactly nothing.
 *
 * That distinction has to reach the user, because the failure is otherwise
 * baffling — a funded wallet, a valid signature, and a refusal. Hence a
 * separate reading and a separate deposit step rather than a quiet branch
 * inside the ordinary balance check.
 *
 * ## Which networks
 *
 * Only the ones this project's gate actually quotes through Gateway. Circle
 * supports more, and Base Sepolia is among them — but our gate quotes Base as a
 * plain EIP-3009 transfer, so treating it as Gateway-funded here would report a
 * zero balance for a wallet that can pay perfectly well.
 *
 * The rule is "how does the gate quote it", not "does Circle support it".
 */
import { GatewayClient } from '@circle-fin/x402-batching/client';

/** CAIP-2 to Circle's own chain naming, for the networks quoted through Gateway. */
const GATEWAY_CHAINS: Record<string, 'arcTestnet'> = {
  'eip155:5042002': 'arcTestnet',
};

export const isGatewayNetwork = (network: string): boolean => network in GATEWAY_CHAINS;

export type GatewayFunding = {
  /** Deposited and spendable. This is what "can pay" means here. */
  availableMinor: bigint;
  /** Held by the address but not deposited — visible, and not yet spendable. */
  walletMinor: bigint;
  /** True when there is a deposited balance to pay from. */
  canPay: boolean;
};

const clientFor = (privateKey: string, network: string): GatewayClient => {
  const chain = GATEWAY_CHAINS[network];
  if (!chain) throw new Error(`${network} is not paid through Circle Gateway`);
  return new GatewayClient({
    chain,
    privateKey: (privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`) as `0x${string}`,
  });
};

/**
 * Both balances, because both matter and they mean different things.
 *
 * A user who has funded the address and not deposited is one step from paying,
 * and telling them only "you cannot pay" would hide which step.
 */
export const gatewayFunding = async (params: {
  privateKey: string;
  network: string;
  address: string;
}): Promise<GatewayFunding> => {
  const balances = await clientFor(params.privateKey, params.network).getBalances(
    params.address as `0x${string}`,
  );
  return {
    availableMinor: balances.gateway.available,
    walletMinor: balances.wallet.balance,
    canPay: balances.gateway.available > 0n,
  };
};

/**
 * Moves USDC from the address into the Gateway balance.
 *
 * Two transactions on the first run — an ERC-20 approval and the deposit — and
 * one thereafter. `amount` is in whole USDC as a decimal string, because that
 * is what Circle's client takes and converting twice is a way to be wrong once.
 */
export const depositToGateway = async (params: {
  privateKey: string;
  network: string;
  amount: string;
}): Promise<{ hash: string; amountMinor: bigint }> => {
  const result = await clientFor(params.privateKey, params.network).deposit(params.amount);
  return { hash: result.depositTxHash, amountMinor: result.amount };
};
