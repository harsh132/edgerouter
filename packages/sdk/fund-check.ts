/**
 * The one thing no fake can prove: that a transfer to a generated address
 * really creates the account.
 *
 * Everything else about the local wallet is checked offline in
 * `wallet-check.ts`. This is the load-bearing assumption underneath all of it —
 * auto account creation, HIP-32 as extended by HIP-542 — and if it does not
 * hold, the entire "the user never types anything" design collapses back into
 * asking for an account id.
 *
 * It spends. Testnet only, and the funding account comes from the environment:
 *
 *   HEDERA_ACCOUNT_ID=0.0.x HEDERA_PRIVATE_KEY=... \
 *   bun packages/sdk/fund-check.ts [hbar]
 *
 * Not part of `bun run check`.
 */
import { AccountId, Client, Hbar, TransferTransaction } from '@x402/hedera';
import { generateWallet, openWallet, parsePrivateKey, formatHbar } from './src/index';

const FUNDER = process.env.HEDERA_ACCOUNT_ID;
const KEY = process.env.HEDERA_PRIVATE_KEY;

function die(message: string): never {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

if (!FUNDER) die('set HEDERA_ACCOUNT_ID to a funded testnet account');
if (!KEY) die('set HEDERA_PRIVATE_KEY in the environment — never as an argument');

const hbar = Number(process.argv[2] ?? '1');
if (!Number.isFinite(hbar) || hbar <= 0) die('the amount must be a positive number of hbar');
const tinybars = BigInt(Math.round(hbar * 1e8));

/*
  A fresh wallet every run, deliberately. Re-using one would let a previous
  run's account make this one look like a success — the whole question is
  whether an address that has never existed becomes an account.
*/
const material = generateWallet('hedera:testnet');
const wallet = openWallet(material);

console.log(`\n  address   ${wallet.evmAddress}`);
console.log(`  funder    ${FUNDER}`);
console.log(`  sending   ${formatHbar(tinybars)}\n`);

const before = await wallet.refresh();
if (before.funded) die('a brand new address already has an account, which should be impossible');
console.log('  ok    the address has no account before the transfer');

const client = Client.forTestnet();
client.setOperator(AccountId.fromString(FUNDER), parsePrivateKey(KEY));

/*
  The transfer names the EVM address as the recipient. There is no account to
  name yet — that is the point. The network creates one as a child transaction.
*/
const sent = await new TransferTransaction()
  .addHbarTransfer(AccountId.fromString(FUNDER), Hbar.fromTinybars((-tinybars).toString()))
  .addHbarTransfer(AccountId.fromEvmAddress(0, 0, wallet.evmAddress), Hbar.fromTinybars(tinybars.toString()))
  .execute(client);

const receipt = await sent.getReceipt(client);
console.log(`  ok    the transfer was accepted (${receipt.status.toString()})`);
console.log(`  tx    ${sent.transactionId.toString()}`);

/*
  The mirror node lags consensus by a second or two, so the account exists
  before the query can see it. Polled rather than slept, because the interval
  is not a constant anyone should be guessing at.
*/
let funding = await wallet.refresh();
for (let attempt = 0; attempt < 20 && !funding.funded; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  funding = await wallet.refresh();
}

if (!funding.funded) {
  die('the transfer succeeded but no account appeared — auto account creation did not happen');
}

console.log(`  ok    the account was created by the transfer: ${funding.accountId}`);
console.log(`  ok    it holds ${formatHbar(funding.balanceMinor)}`);

const signer = wallet.signer();
console.log(`  ok    the wallet can now sign, as ${signer.accountId}`);

console.log(`\n  explorer  https://hashscan.io/testnet/account/${funding.accountId}`);
console.log('\n  Auto account creation holds: a generated address, funded once, is a usable wallet.\n');
console.log('  This wallet was thrown away. Its key was never written to disk.');
console.log(`  ${formatHbar(funding.balanceMinor)} of testnet hbar stays in it.\n`);
