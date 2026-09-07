/**
 * The wallet, from a terminal.
 *
 *   bun packages/sdk/wallet.ts address          where to send funds
 *   bun packages/sdk/wallet.ts balance          what it holds
 *   bun packages/sdk/wallet.ts watch            poll until funds arrive
 *   bun packages/sdk/wallet.ts sweep <to>       move it all somewhere else
 *   bun packages/sdk/wallet.ts export --yes     print the private key
 *
 * The same wallet the DSH plugin uses, so anything shown here is what the
 * plugin will spend from. `--network` picks one; each network has its own.
 *
 * Two wallet kinds sit behind one command set, because the choice of chain is
 * not something a user should have to hold two mental models for. What actually
 * differs is real and is said where it matters: a Hedera account is created by
 * its first transfer, an EVM address already is an account, and on EVM the
 * asymmetry between paying (gasless) and leaving (not) has to be stated.
 */
import {
  loadOrCreateWallet,
  loadOrCreateEvmWallet,
  isEvmNetwork,
  describe,
  formatHbar,
  formatUsdc,
} from './src/index';

const argv = process.argv.slice(2);
const command = argv[0] ?? 'address';
const flag = (name: string): string | undefined => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 ? argv[at + 1] : undefined;
};

const network = flag('network') ?? 'hedera:testnet';

const unknown = (): never => {
  console.error(`\n  unknown command "${command}"`);
  console.error('  try: address | balance | watch | sweep <to> | export --yes | where\n');
  process.exit(1);
};

/*
  Behind an explicit flag, and it prints nothing without one. Exporting a key is
  a thing to do on purpose, in a terminal you trust, and never something that
  happens because a command was run for another reason.
*/
const refuseExport = (): void => {
  console.error('\n  This prints your private key to the terminal.');
  console.error('  Anyone who sees it can spend this wallet.');
  console.error('  Re-run with --yes if that is what you want.\n');
  process.exit(1);
};

/* --------------------------------------------------------------------- EVM */

async function runEvm(): Promise<void> {
  const { wallet, path, created } = loadOrCreateEvmWallet({ network });
  if (created) {
    console.log(`\n  Generated a new wallet for ${network}.`);
    console.log(`  ${describe(path)}`);
  }

  const faucet = '\n  Testnet USDC: https://faucet.circle.com';

  switch (command) {
    case 'address':
      console.log('\n  Send USDC to this address to fund the wallet:\n');
      console.log(`    ${wallet.address}\n`);
      console.log('  Paying costs no gas — EIP-3009 is an authorization the');
      console.log("  facilitator submits. Only sweeping needs the chain's own");
      console.log(`  token.${faucet}\n`);
      return;

    case 'balance':
    case 'status': {
      const funding = await wallet.refresh();
      console.log(`\n  network   ${network}`);
      console.log(`  address   ${wallet.address}`);
      console.log(`  asset     ${wallet.asset}`);
      console.log(`  balance   ${formatUsdc(funding.tokenMinor)}`);
      console.log(`  gas       ${funding.nativeWei} wei (needed only to sweep)`);
      console.log(`  can pay   ${funding.canPay ? 'yes' : 'no — send USDC'}`);
      if (!funding.canPay) console.log(faucet);
      console.log('');
      return;
    }

    case 'watch':
      console.log(`\n  Waiting for USDC at ${wallet.address}`);
      console.log(`  Ctrl-C to stop.${faucet}\n`);
      for (;;) {
        const funding = await wallet.refresh();
        if (funding.canPay) {
          console.log(`  funded    ${formatUsdc(funding.tokenMinor)}\n`);
          return;
        }
        process.stdout.write(`  waiting   ${new Date().toLocaleTimeString()}\r`);
        await new Promise((resolve) => setTimeout(resolve, 5_000));
      }

    case 'sweep': {
      const to = argv[1];
      if (!to || to.startsWith('--')) {
        console.error('\n  usage: wallet.ts sweep <0x-address> --network eip155:80002\n');
        process.exit(1);
      }
      const swept = await wallet.sweep(to);
      console.log(`\n  moved     ${formatUsdc(swept.amountMinor)} to ${to}`);
      console.log(`  tx        ${swept.hash}\n`);
      return;
    }

    case 'export':
      if (!argv.includes('--yes')) refuseExport();
      console.log(`\n  ${wallet.exportPrivateKey()}\n`);
      return;

    case 'where':
      console.log(`\n  ${describe(path)}\n`);
      return;

    default:
      unknown();
  }
}

/* ------------------------------------------------------------------ Hedera */

async function runHedera(): Promise<void> {
  const { wallet, path, created } = loadOrCreateWallet({ network });
  if (created) {
    console.log(`\n  Generated a new wallet for ${network}.`);
    console.log(`  ${describe(path)}`);
  }

  const faucet =
    network === 'hedera:testnet' ? '\n  Testnet funds: https://portal.hedera.com/faucet' : '';

  switch (command) {
    case 'address':
      console.log('\n  Send hbar to this address to fund the wallet:\n');
      console.log(`    ${wallet.evmAddress}\n`);
      console.log('  The account is created by that first transfer — there is');
      console.log(`  nothing to register and no fee to pay first.${faucet}\n`);
      return;

    case 'balance':
    case 'status': {
      const funding = await wallet.refresh();
      console.log(`\n  network   ${network}`);
      console.log(`  address   ${wallet.evmAddress}`);
      if (!funding.funded) {
        console.log('  account   none yet — nothing has been sent to this address');
        console.log(`  balance   0 ℏ${faucet}\n`);
        return;
      }
      console.log(`  account   ${funding.accountId}`);
      console.log(`  balance   ${formatHbar(funding.balanceMinor)}`);
      console.log(
        `  explorer  https://hashscan.io/${network.split(':')[1]}/account/${funding.accountId}\n`,
      );
      return;
    }

    /*
      Polling exists because funding is the one step that happens outside this
      process, and "did it land?" is otherwise answered by running `balance`
      repeatedly. The mirror node is a public read, so this costs nothing.
    */
    case 'watch':
      console.log(`\n  Waiting for funds at ${wallet.evmAddress}`);
      console.log(`  Ctrl-C to stop.${faucet}\n`);
      for (;;) {
        const funding = await wallet.refresh();
        if (funding.funded) {
          console.log(
            `  funded    ${funding.accountId} holds ${formatHbar(funding.balanceMinor)}\n`,
          );
          return;
        }
        process.stdout.write(`  waiting   ${new Date().toLocaleTimeString()}\r`);
        await new Promise((resolve) => setTimeout(resolve, 5_000));
      }

    case 'sweep': {
      const to = argv[1];
      if (!to || to.startsWith('--')) {
        console.error('\n  usage: wallet.ts sweep <account-id>   e.g. 0.0.1234\n');
        process.exit(1);
      }
      const funding = await wallet.refresh();
      if (!funding.funded) {
        console.error('\n  nothing to sweep — this wallet has never been funded\n');
        process.exit(1);
      }
      console.log(
        `\n  sweeping ${formatHbar(funding.balanceMinor)} from ${funding.accountId} to ${to}`,
      );
      const swept = await wallet.sweep(to);
      console.log(`  moved     ${formatHbar(swept.amountMinor)}`);
      console.log('  kept back a small reserve for the transfer fee\n');
      return;
    }

    case 'export':
      if (!argv.includes('--yes')) refuseExport();
      console.log(`\n  ${wallet.exportPrivateKey()}\n`);
      return;

    case 'where':
      console.log(`\n  ${describe(path)}\n`);
      return;

    default:
      unknown();
  }
}

await (isEvmNetwork(network) ? runEvm() : runHedera());
