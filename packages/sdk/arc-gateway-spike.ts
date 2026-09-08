/**
 * Spike: can we pay on Arc through Circle's Gateway?
 *
 *   bun packages/sdk/arc-gateway-spike.ts
 *
 * A spike, not a feature. It exists to answer one question before the third
 * hackathon track is committed to Arc: does the Gateway path actually settle,
 * end to end, from this repo's own wallet?
 *
 * ## Why this is not the path `arc-check` proved
 *
 * `arc-check` verified that a plain EIP-3009 signature would be accepted by
 * Arc's USDC — and it would. What it does not do is settle, because settlement
 * needs somebody to submit the transaction, and no facilitator known to this
 * project covers Arc.
 *
 * Circle's does, and it works differently in one load-bearing respect. The
 * signature is bound to the **GatewayWallet** contract, not to USDC:
 *
 *     name              GatewayWalletBatched
 *     verifyingContract 0x0077777d7EBA4688BDeF3E311b846F25870A19B9
 *
 * so a signature produced for USDC's domain is not a signature Gateway will
 * accept, and vice versa. That is why this uses Circle's `BatchEvmScheme`
 * rather than our own signer — and why adopting it is "using Circle's tools"
 * rather than reimplementing them.
 *
 * ## The other difference: money has to be deposited first
 *
 * Gateway keeps a virtual balance. Holding USDC in the wallet is not enough —
 * it has to be deposited into the GatewayWallet contract, and payments are then
 * signed against that balance and settled in batches. So this spike has three
 * stages, and stops at the first one it cannot complete rather than failing
 * later with something less legible.
 */
import { formatUnits } from 'viem';
import { GatewayClient, BatchEvmScheme, CHAIN_CONFIGS } from '@circle-fin/x402-batching/client';
import { loadOrCreateEvmWallet } from './src/index';

const ARC = 'arcTestnet' as const;
const NETWORK = 'eip155:5042002';
/** Small enough to be repeatable, large enough to be a real payment. */
const DEPOSIT_USDC = '0.5';
const PAY_MINOR = 10_000n; // 0.01 USDC

let failures = 0;
const check = (ok: boolean, label: string, detail = '') => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
};
const stop = (why: string, next: string): never => {
  console.log(`\n  Stopped: ${why}`);
  console.log(`  ${next}\n`);
  process.exit(0);
};

const config = CHAIN_CONFIGS[ARC];
console.log('\n  Circle Gateway on Arc testnet\n');
console.log(`  chain            ${config.chain.id}  domain ${config.domain}`);
console.log(`  usdc             ${config.usdc}`);
console.log(`  gatewayWallet    ${config.gatewayWallet}`);

/*
  The same key as everything else. That is the point of the spike: if this
  works, the wallet the user already funded is the wallet that pays on Arc.
*/
const { wallet } = loadOrCreateEvmWallet({ network: NETWORK });
const privateKey = wallet.exportPrivateKey() as `0x${string}`;
const address = wallet.address as `0x${string}`;
console.log(`  paying from      ${address}\n`);

const gateway = new GatewayClient({ chain: ARC, privateKey });

/* ------------------------------------------------------------------ stage 1 */

const balances = await gateway.getBalances(address);
console.log(`  wallet USDC      ${balances.wallet.formatted}`);
console.log(`  gateway total    ${balances.gateway.formattedTotal}`);
console.log(`  gateway available${' '.repeat(1)}${balances.gateway.formattedAvailable}\n`);

if (balances.wallet.balance === 0n && balances.gateway.available === 0n) {
  stop(
    `${address} holds no USDC on Arc testnet`,
    'Fund it at https://faucet.circle.com (pick Arc testnet), then run this again.',
  );
}

/* ------------------------------------------------------------------ stage 2 */

if (balances.gateway.available < PAY_MINOR) {
  console.log(`  depositing ${DEPOSIT_USDC} USDC into the Gateway…`);
  const deposit = await gateway.deposit(DEPOSIT_USDC);
  console.log(`  approval         ${deposit.approvalTxHash ?? '(already approved)'}`);
  console.log(`  deposit          ${deposit.depositTxHash}`);
  check(Boolean(deposit.depositTxHash), 'the deposit landed', deposit.formattedAmount);

  const after = await gateway.getBalance(address);
  console.log(`  gateway now      ${after.formattedAvailable ?? after.formattedTotal ?? ''}\n`);
}

/* ------------------------------------------------------------------ stage 3 */

/*
  Requirements shaped the way a seller using Circle's middleware would send
  them. The `extra` block is what makes this a Gateway payment rather than a
  plain one — `BatchEvmScheme` reads the domain out of it, and refuses
  requirements that do not carry batching metadata.
*/
const requirements = {
  scheme: 'exact',
  network: NETWORK,
  asset: config.usdc,
  amount: PAY_MINOR.toString(),
  payTo: '0x3f870ECEEE0EcE3a54254C1D364230ABd14aa2d3',
  maxTimeoutSeconds: 180,
  extra: {
    name: 'GatewayWalletBatched',
    version: '1',
    verifyingContract: config.gatewayWallet,
    domain: config.domain,
  },
};

const scheme = new BatchEvmScheme({
  address,
  async signTypedData(parameters: unknown) {
    // Delegated to viem through the same key the wallet uses, so nothing here
    // holds a second copy of it.
    const { privateKeyToAccount } = await import('viem/accounts');
    return privateKeyToAccount(privateKey).signTypedData(parameters as never);
  },
} as never);

const payload = await scheme.createPaymentPayload(2, requirements);
check(Boolean(payload.payload), 'Circle’s scheme signed a payment for Arc');
console.log(`  payload          ${JSON.stringify(payload.payload).slice(0, 140)}…\n`);

/*
  Settlement is the seller's half, and the reason this spike exists. A signature
  that cannot be settled is what we already had.
*/
const { BatchFacilitatorClient } = await import('@circle-fin/x402-batching/server');
/*
  Testnet, explicitly. The facilitator client defaults to
  `https://gateway-api.circle.com`, which is mainnet, and answers
  `unsupported_network` for Arc testnet — a correct answer to the wrong
  question. The client SDK carries the testnet base URL; the server half does
  not default to it.
*/
const facilitator = new BatchFacilitatorClient({ url: 'https://gateway-api-testnet.circle.com' });

/*
  `resource` and `accepted` are optional in the published types and required by
  the API — verify answers 400 without them. `accepted` is the requirements the
  buyer agreed to, which the Gateway re-derives the payment from rather than
  trusting the payload alone; `resource` is what was being bought.
*/
const envelope = {
  ...payload,
  resource: {
    url: 'https://edgerouter-gate.prakashharsh32.workers.dev/v1/chat/completions',
    description: 'edgerouter inference',
    mimeType: 'application/json',
  },
  accepted: requirements,
};

const verified = await facilitator.verify(
  envelope as never,
  requirements as never,
);
console.log('  verify           ', JSON.stringify(verified).slice(0, 200));
check((verified as { isValid?: boolean }).isValid === true, 'the Gateway verifies the payment');

const settled = await facilitator.settle(
  envelope as never,
  requirements as never,
);
console.log('  settle           ', JSON.stringify(settled).slice(0, 240));
check(
  (settled as { success?: boolean }).success === true,
  'and settles it',
  (settled as { transaction?: string }).transaction ?? '',
);

console.log(failures === 0 ? '\n  Spike succeeded.\n' : `\n  ${failures} FAILED.\n`);
if (failures > 0) process.exit(1);
