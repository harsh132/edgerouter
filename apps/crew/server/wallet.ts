/**
 * Opening the one wallet the whole crew spends from.
 *
 * Every agent pays from this address and none of them holds its key — that is
 * the entire point of the delegation tree, and it is what makes a spending
 * limit mean something. An agent with its own key has a limit it could raise;
 * an agent with a capability has one it cannot reach.
 *
 * Three networks, three ways of asking "can this pay", because they genuinely
 * differ. Hedera holds hbar in an account; Base holds USDC at an address; Arc
 * pays from a balance deposited into Circle's GatewayWallet, where holding the
 * token and being able to spend it are different facts.
 */
import {
  evmSigner,
  hederaSigner,
  isGatewayNetwork,
  gatewayFunding,
  loadOrCreateEvmWallet,
  loadOrCreateWallet,
  type PaymentSigner,
} from '../../../packages/sdk/src/index';

export type OpenWallet = {
  signer: PaymentSigner;
  /** The address or account id money leaves from. Public, and shown. */
  account: string;
  /** What is actually spendable, smallest units. The budget ceiling. */
  spendableMinor: bigint;
  network: string;
  /** Present only when it differs from spendable, and only then worth saying. */
  heldMinor?: bigint;
};

export const openWallet = async (network: string): Promise<OpenWallet> => {
  if (network.startsWith('hedera:')) {
    const { wallet } = loadOrCreateWallet({ network });
    const funding = await wallet.refresh();
    if (!funding.funded) {
      throw new Error(`the wallet holds no hbar yet — send some to ${wallet.evmAddress}`);
    }
    return {
      signer: wallet.signer(),
      account: funding.accountId ?? wallet.evmAddress,
      spendableMinor: funding.balanceMinor,
      network,
    };
  }

  const { wallet } = loadOrCreateEvmWallet({ network });
  const privateKey = wallet.exportPrivateKey();
  const signer = evmSigner({ privateKey, network });

  if (isGatewayNetwork(network)) {
    const funding = await gatewayFunding({ privateKey, network, address: wallet.address });
    if (!funding.canPay) {
      /*
        Named precisely, because the two failures look identical from the UI
        and have different fixes. An address with USDC and nothing deposited is
        one transaction away from working; an empty one needs a faucet.
      */
      throw new Error(
        funding.walletMinor > 0n
          ? `this wallet holds USDC but has deposited none of it into the Gateway, which is what payment is drawn from`
          : `this wallet holds no USDC yet — send some to ${wallet.address}`,
      );
    }
    return {
      signer,
      account: wallet.address,
      spendableMinor: funding.availableMinor,
      heldMinor: funding.walletMinor,
      network,
    };
  }

  const funding = await wallet.refresh();
  if (!funding.canPay) {
    throw new Error(`this wallet holds no USDC yet — send some to ${wallet.address}`);
  }
  return { signer, account: wallet.address, spendableMinor: funding.tokenMinor, network };
};
