/**
 * What a browser needs in order to fund this crew from someone's own wallet.
 *
 * Sent from the runtime rather than compiled into the page, because every value
 * here is a contract address and a page that carries its own copy is a page
 * that can be wrong about where money goes. The runtime already knows these —
 * it pays with them — so it is the one place they cannot drift.
 *
 * ## Why depositing is not a transfer
 *
 * On Arc, payment is drawn from a balance deposited into Circle's GatewayWallet
 * rather than from the token balance of an address. Sending USDC to the crew's
 * address therefore gets it most of the way and leaves it unspendable, and
 * Circle's own docs are blunt about the worse version: transferring USDC
 * directly to the GatewayWallet contract loses it.
 *
 * The right move is `depositFor`, which credits a balance to an address that is
 * not the caller:
 *
 *   function depositFor(address token, address depositor, uint256 value)
 *
 * So a user's wallet approves the GatewayWallet for the amount and then calls
 * `depositFor(USDC, crewAddress, amount)`. Two signatures, and the money lands
 * directly in the balance the crew spends from — never sitting in a hot wallet
 * as loose USDC, only ever as a Gateway balance that can leave through a signed
 * burn intent.
 */

export type FundingRoute = {
  /** EIP-155 chain id, for switching the wallet to the right network. */
  chainId: number;
  chainName: string;
  rpcUrl: string;
  /** The ERC-20 being deposited. */
  token: string;
  tokenSymbol: string;
  tokenDecimals: number;
  /** The contract the deposit goes through, and what gets approved. */
  gatewayWallet: string;
  /** Where the deposited balance should land. The crew's address. */
  depositor: string;
};

const ARC: Omit<FundingRoute, 'depositor'> = {
  chainId: 5042002,
  chainName: 'Arc Testnet',
  rpcUrl: 'https://rpc.testnet.arc.network',
  token: '0x3600000000000000000000000000000000000000',
  tokenSymbol: 'USDC',
  tokenDecimals: 6,
  gatewayWallet: '0x0077777d7EBA4688BDeF3E311b846F25870A19B9',
};

/**
 * How a person funds this crew from their own wallet, if they can.
 *
 * Null everywhere but Arc, and that is honest rather than unfinished. Hedera
 * testnet hbar comes from a faucet and there is no main wallet holding it;
 * Base Sepolia would be a plain transfer, which the address on screen already
 * describes. Offering a Connect Wallet button that leads to neither would be
 * worse than not offering one.
 */
export const fundingRouteFor = (network: string, account: string): FundingRoute | null =>
  network === 'eip155:5042002' ? { ...ARC, depositor: account } : null;

/**
 * The Privy application this page authenticates against.
 *
 * A public identifier rather than a secret — it ships in every client bundle
 * that uses it, and Privy scopes what it can do by the origins configured
 * against it in their dashboard. So it lives in source with an environment
 * override, not in `.env` beside the keys, and confusing the two would mean
 * treating a published string as sensitive while a real key sits next to it.
 *
 * Served from the runtime for the same reason the contract addresses are: one
 * place that knows the configuration, rather than a page that carries its own
 * copy and can disagree with it.
 */
export const privyAppId = (): string | null => process.env.PRIVY_APP_ID ?? 'cmtvmne8l002x0cl9zvp4lgc9';
