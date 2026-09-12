/**
 * Sends testnet hbar to an address, the way a user would from their own wallet.
 *
 * Exists so the funding step of the local-wallet flow can be exercised without
 * a faucet in the loop. It sends from the wallet — the same one everything else
 * here pays from — to wherever you name.
 *
 *   bun packages/sdk/send.ts 0xabc… 2
 *
 * It used to read a second account out of the environment, on the reasoning
 * that this script plays "the user's existing wallet" and so should not touch
 * the generated one. That was a second private key to hold, and holding one is
 * the point of the design; `sweep` already covers emptying this wallet into an
 * account you own elsewhere.
 *
 * Not part of `bun run check`: it spends.
 */
import { AccountId, Client, Hbar, TransferTransaction } from '@x402/hedera';
import { parsePrivateKey, formatHbar, loadOrCreateWallet } from './src/index';

function die(message: string): never {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

const { wallet, path } = loadOrCreateWallet({ network: 'hedera:testnet' });
const funding = await wallet.refresh();
if (!funding.funded || !funding.accountId) {
  die(`the wallet has no account yet — send hbar to ${wallet.evmAddress}
  stored at ${path}`);
}
const FUNDER = funding.accountId;
const KEY = wallet.exportPrivateKey();

const to = process.argv[2];
const hbar = Number(process.argv[3] ?? '1');
if (!to) die('usage: send.ts <0x-address | 0.0.account> [hbar]');
if (!Number.isFinite(hbar) || hbar <= 0) die('the amount must be a positive number of hbar');

const tinybars = BigInt(Math.round(hbar * 1e8));
const recipient = to.startsWith('0x') ? AccountId.fromEvmAddress(0, 0, to) : AccountId.fromString(to);

const client = Client.forTestnet();
client.setOperator(AccountId.fromString(FUNDER), parsePrivateKey(KEY));

const sent = await new TransferTransaction()
  .addHbarTransfer(AccountId.fromString(FUNDER), Hbar.fromTinybars((-tinybars).toString()))
  .addHbarTransfer(recipient, Hbar.fromTinybars(tinybars.toString()))
  .execute(client);

const receipt = await sent.getReceipt(client);
console.log(`\n  sent      ${formatHbar(tinybars)} to ${to}`);
console.log(`  status    ${receipt.status.toString()}`);
console.log(`  tx        ${sent.transactionId.toString()}\n`);
