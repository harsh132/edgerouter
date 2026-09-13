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

/**
 * Why a wallet cannot pay yet, in the terms the fix differs by.
 *
 * `empty` needs money from somewhere — a faucet on a testnet, a transfer on a
 * mainnet. `undeposited` already has the money and needs one transaction to
 * make it spendable. They look identical in a balance and have nothing in
 * common as instructions, which is the whole reason this is not a boolean.
 */
export type Shortfall = 'empty' | 'undeposited';

export type OpenWallet = {
  signer: PaymentSigner;
  /** The address or account id money leaves from. Public, and shown. */
  account: string;
  /** What is actually spendable, smallest units. The budget ceiling. */
  spendableMinor: bigint;
  network: string;
  /** Present only when it differs from spendable, and only then worth saying. */
  heldMinor?: bigint;
  /** Prepaid at the gate. Already included in `spendableMinor`; broken out so it can be shown. */
  tabMinor?: bigint;
  /**
   * Absent when the wallet can pay.
   *
   * An unfunded wallet used to throw here, which meant the runtime exited
   * before it served anything — so the first thing a new user saw was a process
   * that would not start, with the address they needed to fund printed in a
   * terminal they were not looking at. A wallet that cannot pay is a state the
   * app has to be able to render, not an error that prevents rendering.
   */
  shortfall?: Shortfall;
};

/**
 * What this wallet has prepaid at the gate, in its tab.
 *
 * Counted as spendable because it is: topping a tab up moves money from the
 * Gateway balance to the gate without it leaving the crew, and a wallet that
 * forgot the tab would read every top-up as money lost — refusing to hire
 * against funds the agents can still spend. An unreachable gate reads as zero,
 * which understates rather than invents.
 */
const tabBalance = async (gate: string, network: string, address: string): Promise<bigint> => {
  try {
    const url = new URL('/v1/tab', gate);
    url.searchParams.set('payer', address);
    url.searchParams.set('network', network);
    const response = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    if (!response.ok) return 0n;
    const body = (await response.json()) as { balanceMinor?: unknown };
    return typeof body.balanceMinor === 'string' && /^\d+$/.test(body.balanceMinor) ? BigInt(body.balanceMinor) : 0n;
  } catch {
    return 0n;
  }
};

export const openWallet = async (network: string, gate?: string): Promise<OpenWallet> => {
  if (network.startsWith('hedera:')) {
    const { wallet } = loadOrCreateWallet({ network });
    const funding = await wallet.refresh();
    /*
      An unfunded Hedera wallet has no account id, because an account does not
      exist until something is sent to the address. So the address is what the
      user is shown and what they fund; the id appears afterwards, which is
      itself the confirmation that it worked.
    */
    if (!funding.funded) {
      return {
        signer: wallet.signer(),
        account: wallet.evmAddress,
        spendableMinor: 0n,
        network,
        shortfall: 'empty',
      };
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
    const tabMinor = gate ? await tabBalance(gate, network, wallet.address) : 0n;

    /*
      A tab with money in it can pay even when the Gateway balance cannot — the
      last top-up may have moved everything there. Only a wallet with neither
      is short of anything.
    */
    if (!funding.canPay && tabMinor > 0n) {
      return {
        signer,
        account: wallet.address,
        spendableMinor: tabMinor,
        heldMinor: funding.walletMinor,
        tabMinor,
        network,
      };
    }
    if (funding.canPay) {
      return {
        signer,
        account: wallet.address,
        spendableMinor: funding.availableMinor + tabMinor,
        heldMinor: funding.walletMinor,
        ...(tabMinor > 0n ? { tabMinor } : {}),
        network,
      };
    }
    if (!funding.canPay) {
      /*
        Named precisely, because the two failures look identical from the UI
        and have different fixes. An address with USDC and nothing deposited is
        one transaction away from working; an empty one needs funding.
      */
      return {
        signer,
        account: wallet.address,
        spendableMinor: 0n,
        heldMinor: funding.walletMinor,
        network,
        shortfall: funding.walletMinor > 0n ? 'undeposited' : 'empty',
      };
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
  return {
    signer,
    account: wallet.address,
    spendableMinor: funding.canPay ? funding.tokenMinor : 0n,
    network,
    ...(funding.canPay ? {} : { shortfall: 'empty' as const }),
  };
};
