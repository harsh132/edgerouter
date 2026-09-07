#!/usr/bin/env node
/**
 * Wallet management for people who installed the plugin, not the repository.
 *
 *   npx dsh-plugin-edgerouter            where to send funds
 *   npx dsh-plugin-edgerouter balance    what it holds
 *   npx dsh-plugin-edgerouter watch      wait for funds to land
 *   npx dsh-plugin-edgerouter sweep <to> take it all back out
 *
 * The repository has `bun run wallet`, which is the same thing. This exists
 * because a user who installed a tarball into a DSH profile has no repository
 * and no bun, and telling them to clone one to find out their own address would
 * be an odd definition of "no setup required".
 *
 * It operates on exactly the wallet the plugin spends from — same file, same
 * default network — so what it reports is what the harness will pay with.
 */
import {
  loadOrCreateWallet,
  loadOrCreateEvmWallet,
  isEvmNetwork,
  describe,
  formatAmount,
} from '../../sdk/src/index';

const argv = process.argv.slice(2);
const command = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'address';
const flagAt = argv.indexOf('--network');
const network = flagAt >= 0 ? (argv[flagAt + 1] ?? 'hedera:testnet') : 'hedera:testnet';

const faucet = isEvmNetwork(network)
  ? 'https://faucet.circle.com'
  : 'https://portal.hedera.com/faucet';

const say = (line = '') => console.log(line);

const usage = (): never => {
  console.error('\n  usage: dsh-plugin-edgerouter <command> [--network <caip2>]\n');
  console.error('    address            where to send funds (default)');
  console.error('    balance            what the wallet holds');
  console.error('    watch              poll until funds arrive');
  console.error('    sweep <to>         move everything out');
  console.error('    export --yes       print the private key');
  console.error('    where              the file holding the key\n');
  process.exit(1);
};

/**
 * One shape for two chains.
 *
 * The differences that matter to a person are kept — a Hedera account does not
 * exist until it is funded, an EVM one always does — and the ones that do not
 * are flattened, so `balance` reads the same either way.
 */
type View = {
  address: string;
  path: string;
  created: boolean;
  status(): Promise<{ funded: boolean; line: string; detail?: string }>;
  sweep(to: string): Promise<string>;
  key(): string;
};

const open = (): View => {
  if (isEvmNetwork(network)) {
    const { wallet, path, created } = loadOrCreateEvmWallet({ network });
    return {
      address: wallet.address,
      path,
      created,
      async status() {
        const funding = await wallet.refresh();
        return {
          funded: funding.canPay,
          line: formatAmount(network, funding.tokenMinor),
          /*
            Only worth saying once there is something to sweep. On an empty
            wallet "enough to pay, not enough to sweep" is both true and
            useless — it cannot pay either, and the reader is looking for what
            to do next, not a second problem they do not have yet.
          */
          ...(funding.canPay && funding.nativeWei === 0n
            ? { detail: 'no native balance — enough to pay, not enough to sweep' }
            : {}),
        };
      },
      async sweep(to) {
        const swept = await wallet.sweep(to);
        return `moved ${formatAmount(network, swept.amountMinor)} — ${swept.hash}`;
      },
      key: () => wallet.exportPrivateKey(),
    };
  }

  const { wallet, path, created } = loadOrCreateWallet({ network });
  return {
    address: wallet.evmAddress,
    path,
    created,
    async status() {
      const funding = await wallet.refresh();
      if (!funding.funded) {
        return { funded: false, line: formatAmount(network, 0n), detail: 'no account yet' };
      }
      return {
        funded: true,
        line: formatAmount(network, funding.balanceMinor),
        detail: `account ${funding.accountId}`,
      };
    },
    async sweep(to) {
      const swept = await wallet.sweep(to);
      return `moved ${formatAmount(network, swept.amountMinor)}, keeping a fee reserve`;
    },
    key: () => wallet.exportPrivateKey(),
  };
};

const view = open();

if (view.created) {
  say(`\n  Generated a wallet for ${network}.`);
  say(`  ${describe(view.path)}`);
}

switch (command) {
  case 'address': {
    say('\n  Send funds to this address:\n');
    say(`      ${view.address}\n`);
    if (!isEvmNetwork(network)) {
      say('  The account is created by that first transfer — nothing to');
      say('  register, and no fee to pay before you can receive.');
    } else {
      say('  Paying costs no gas. Only sweeping does.');
    }
    say(`\n  Faucet: ${faucet}`);
    say('  Then: dsh-plugin-edgerouter watch\n');
    break;
  }

  case 'balance':
  case 'status': {
    const status = await view.status();
    say(`\n  network   ${network}`);
    say(`  address   ${view.address}`);
    say(`  balance   ${status.line}${status.detail ? `  (${status.detail})` : ''}`);
    say(`  ready     ${status.funded ? 'yes — the harness can pay' : 'no — send funds'}`);
    if (!status.funded) say(`\n  Faucet: ${faucet}`);
    say();
    break;
  }

  case 'watch': {
    say(`\n  Waiting for funds at ${view.address}`);
    say(`  Faucet: ${faucet}`);
    say('  Ctrl-C to stop.\n');
    for (;;) {
      const status = await view.status();
      if (status.funded) {
        say(`  funded    ${status.line}`);
        say('\n  Restart DSH Desktop if it was already running, and the');
        say('  edgerouter provider will start paying.\n');
        break;
      }
      process.stdout.write(`  waiting   ${new Date().toLocaleTimeString()}\r`);
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
    break;
  }

  case 'sweep': {
    const to = argv[1];
    if (!to || to.startsWith('--')) usage();
    say(`\n  ${await view.sweep(to!)}\n`);
    break;
  }

  /*
    Behind an explicit flag, and prints nothing without one. Exporting a key is
    something to do on purpose, in a terminal you trust — never a side effect of
    running a command for another reason.
  */
  case 'export': {
    if (!argv.includes('--yes')) {
      console.error('\n  This prints your private key to the terminal.');
      console.error('  Anyone who sees it can spend this wallet.');
      console.error('  Re-run with --yes if that is what you want.\n');
      process.exit(1);
    }
    say(`\n  ${view.key()}\n`);
    break;
  }

  case 'where':
    say(`\n  ${describe(view.path)}\n`);
    break;

  default:
    usage();
}
