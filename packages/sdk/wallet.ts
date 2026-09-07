/**
 * The wallet, from a terminal.
 *
 *   bun packages/sdk/wallet.ts address          where to send funds
 *   bun packages/sdk/wallet.ts balance          what it holds, and its id
 *   bun packages/sdk/wallet.ts watch            poll until funds arrive
 *   bun packages/sdk/wallet.ts sweep 0.0.1234   move it all somewhere else
 *   bun packages/sdk/wallet.ts export --yes     print the private key
 *
 * The same wallet the DSH plugin uses, so anything shown here is what the
 * plugin will spend from. `--network` picks one; each network has its own.
 */
import { loadOrCreateWallet, describe, formatHbar } from './src/index';

const argv = process.argv.slice(2);
const command = argv[0] ?? 'address';
const flag = (name: string): string | undefined => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 ? argv[at + 1] : undefined;
};

const network = flag('network') ?? 'hedera:testnet';
const { wallet, path, created } = loadOrCreateWallet({ network });

if (created) {
  console.log(`\n  Generated a new wallet for ${network}.`);
  console.log(`  ${describe(path)}`);
}

const faucet =
  network === 'hedera:testnet'
    ? '\n  Testnet funds: https://portal.hedera.com/faucet'
    : '';

switch (command) {
  case 'address': {
    console.log(`\n  Send hbar to this address to fund the wallet:\n`);
    console.log(`    ${wallet.evmAddress}\n`);
    console.log(`  The account is created by that first transfer — there is`);
    console.log(`  nothing to register and no fee to pay first.${faucet}\n`);
    break;
  }

  case 'balance':
  case 'status': {
    const funding = await wallet.refresh();
    console.log(`\n  network   ${network}`);
    console.log(`  address   ${wallet.evmAddress}`);
    if (!funding.funded) {
      console.log(`  account   none yet — nothing has been sent to this address`);
      console.log(`  balance   0 ℏ${faucet}\n`);
      break;
    }
    console.log(`  account   ${funding.accountId}`);
    console.log(`  balance   ${formatHbar(funding.balanceMinor)}`);
    console.log(`  explorer  https://hashscan.io/${network.split(':')[1]}/account/${funding.accountId}\n`);
    break;
  }

  /*
    Polling exists because funding is the one step that happens outside this
    process, and "did it land?" is otherwise answered by running `balance`
    repeatedly. The mirror node is a public read, so this costs nothing.
  */
  case 'watch': {
    console.log(`\n  Waiting for funds at ${wallet.evmAddress}`);
    console.log(`  Ctrl-C to stop.${faucet}\n`);
    for (;;) {
      const funding = await wallet.refresh();
      if (funding.funded) {
        console.log(`  funded    ${funding.accountId} holds ${formatHbar(funding.balanceMinor)}\n`);
        break;
      }
      process.stdout.write(`  waiting   ${new Date().toLocaleTimeString()}\r`);
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
    break;
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
    console.log(`\n  sweeping ${formatHbar(funding.balanceMinor)} from ${funding.accountId} to ${to}`);
    const swept = await wallet.sweep(to);
    console.log(`  moved     ${formatHbar(swept.amountMinor)}`);
    console.log(`  kept back a small reserve for the transfer fee\n`);
    break;
  }

  /*
    Behind an explicit flag, and it prints nothing without one. Exporting a key
    is a thing to do on purpose, in a terminal you trust, and never something
    that happens because a command was run for another reason.
  */
  case 'export': {
    if (!argv.includes('--yes')) {
      console.error('\n  This prints your private key to the terminal.');
      console.error('  Anyone who sees it can spend this wallet.');
      console.error('  Re-run with --yes if that is what you want.\n');
      process.exit(1);
    }
    console.log(`\n  ${wallet.exportPrivateKey()}\n`);
    break;
  }

  case 'where': {
    console.log(`\n  ${describe(path)}\n`);
    break;
  }

  default:
    console.error(`\n  unknown command "${command}"`);
    console.error('  try: address | balance | watch | sweep <to> | export --yes | where\n');
    process.exit(1);
}
