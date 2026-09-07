/**
 * Sends testnet hbar to an address, the way a user would from their own wallet.
 *
 * Exists so the funding step of the local-wallet flow can be exercised without
 * a faucet in the loop. It is the *other side* of the wallet — what a user's
 * existing account does — so it deliberately reads the funding key from the
 * environment and never touches the generated wallet at all.
 *
 *   HEDERA_ACCOUNT_ID=0.0.x HEDERA_PRIVATE_KEY=... \
 *   bun packages/sdk/send.ts 0xabc… 2
 *
 * Not part of `bun run check`: it spends.
 */
import { AccountId, Client, Hbar, TransferTransaction } from '@x402/hedera';
import { parsePrivateKey, formatHbar } from './src/index';

const FUNDER = process.env.HEDERA_ACCOUNT_ID;
const KEY = process.env.HEDERA_PRIVATE_KEY;

function die(message: string): never {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

if (!FUNDER) die('set HEDERA_ACCOUNT_ID to the funding account');
if (!KEY) die('set HEDERA_PRIVATE_KEY in the environment — never as an argument');

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
