/**
 * The generated wallet, checked without money.
 *
 * The one thing that cannot be faked here is whether Hedera really creates an
 * account on the first transfer to an EVM address — that is `wallet.ts fund`
 * and a faucet. What *can* be checked is everything around it, and the states
 * that only exist because of it: an address before there is an account, an
 * account id that appears without anyone registering it, and a signer that
 * refuses rather than improvises while the wallet is empty.
 *
 *   bun packages/sdk/wallet-check.ts
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  generateWallet,
  openWallet,
  loadOrCreateWallet,
  loadOrCreateEvmWallet,
  walletPath,
  evmWalletPath,
  hbarOf,
} from './src/index';

let failures = 0;
const check = (condition: boolean, message: string) => {
  if (condition) console.log(`  ok    ${message}`);
  else {
    failures += 1;
    console.log(`  FAIL  ${message}`);
  }
};
const section = (name: string) => console.log(`\n${name}\n`);

const throws = async (fragment: string, message: string, run: () => unknown) => {
  try {
    await run();
    check(false, `${message} (nothing was thrown)`);
  } catch (error) {
    const text = (error as Error).message;
    check(text.includes(fragment), `${message} (${text.slice(0, 60)})`);
  }
};

/** A mirror node that answers whatever this test needs it to. */
const mirror = (answer: 'missing' | { account: string; tinybars: number }): typeof fetch =>
  ((url: string | URL | Request) => {
    const text = String(url);
    if (!text.includes('/api/v1/accounts/')) throw new Error(`unexpected request to ${text}`);
    if (answer === 'missing') return Promise.resolve(new Response('', { status: 404 }));
    return Promise.resolve(
      new Response(
        JSON.stringify({ account: answer.account, balance: { balance: answer.tinybars } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
  }) as typeof fetch;

/* ---------------------------------------------------------------- generation */

section('Generation');

const material = generateWallet('hedera:testnet');
check(/^0x[0-9a-f]{40}$/i.test(material.evmAddress), 'an EVM address is generated, offline');
check(material.privateKey.length > 0, 'a private key is generated');
check(material.accountId === undefined, 'a fresh wallet has no account id — nothing exists yet');
check(
  !material.evmAddress.includes(material.privateKey),
  'the address does not contain the key',
);

const second = generateWallet('hedera:testnet');
check(second.evmAddress !== material.evmAddress, 'two wallets are two wallets');

/* ------------------------------------------------------------------- unfunded */

section('Before anyone sends anything');

const cold = openWallet(material, { fetch: mirror('missing') });
const before = await cold.refresh();
check(before.funded === false, 'the mirror node 404 means unfunded, not broken');
check(before.balanceMinor === 0n, 'an account that does not exist holds nothing');
check(cold.accountId() === null, 'there is no account id to report');

await throws('not funded yet', 'signing refuses while unfunded, and says why', () => cold.signer());
await throws('never been funded', 'sweeping an unfunded wallet refuses', () =>
  cold.sweep('0.0.1234'),
);

/* --------------------------------------------------------------------- funded */

section('After a transfer arrives');

let resolvedTo: string | null = null;
const warm = openWallet(material, {
  fetch: mirror({ account: '0.0.987654', tinybars: 250_000_000 }),
  onResolved: (id) => {
    resolvedTo = id;
  },
});
const after = await warm.refresh();
check(after.funded === true, 'the account exists once something was sent to the address');
check(after.funded && after.accountId === '0.0.987654', 'the account id came from the network');
check(after.balanceMinor === 250_000_000n, 'the balance is read in tinybars');
check(resolvedTo === '0.0.987654', 'the caller is told the id so it can be persisted');
check(warm.accountId() === '0.0.987654', 'the wallet remembers it');

const signer = warm.signer();
check(signer.accountId === '0.0.987654', 'the signer pays from the account that was created');
check(signer.network === 'hedera:testnet', 'on the network the wallet was made for');

check(hbarOf(250_000_000n) === '2.5000', 'tinybars display as hbar');

/* -------------------------------------------------------------------- storage */

section('Storage');

const home = mkdtempSync(join(tmpdir(), 'edgerouter-wallet-'));
try {
  const first = loadOrCreateWallet({ network: 'hedera:testnet', home, fetch: mirror('missing') });
  check(first.created, 'the first open generates a wallet');
  check(first.path === walletPath('hedera:testnet', home), 'it lands where it says it does');
  // The basename, not the whole path — on Windows the path starts `C:`.
  check(
    !first.path.split(/[\\/]/).at(-1)!.includes(':'),
    'the filename is not a CAIP-2 id, which would be an illegal name on Windows',
  );

  const again = loadOrCreateWallet({ network: 'hedera:testnet', home, fetch: mirror('missing') });
  check(!again.created, 'the second open loads rather than generating');
  check(
    again.wallet.evmAddress === first.wallet.evmAddress,
    'it is the same wallet, so funds sent to it are still reachable',
  );

  const other = loadOrCreateWallet({ network: 'hedera:mainnet', home, fetch: mirror('missing') });
  check(
    other.wallet.evmAddress !== first.wallet.evmAddress,
    'a different network gets a different wallet, so testnet play cannot touch mainnet',
  );

  const funded = loadOrCreateWallet({
    network: 'hedera:testnet',
    home,
    fetch: mirror({ account: '0.0.5150', tinybars: 100 }),
  });
  await funded.wallet.refresh();
  const onDisk = JSON.parse(readFileSync(funded.path, 'utf8')) as Record<string, unknown>;
  check(onDisk.accountId === '0.0.5150', 'the resolved account id is written back');
  check(
    onDisk.evmAddress === first.wallet.evmAddress,
    'writing the id back did not replace the key',
  );

  // The failure worth being certain about: a damaged file must never be
  // silently replaced, because the key it held may still hold money.
  const { writeFileSync } = await import('node:fs');
  writeFileSync(walletPath('hedera:testnet', home), 'not json at all');
  await throws('move it aside', 'a damaged wallet file is refused, not overwritten', () =>
    loadOrCreateWallet({ network: 'hedera:testnet', home, fetch: mirror('missing') }),
  );
} finally {
  rmSync(home, { recursive: true, force: true });
}

/* ------------------------------------------------------------------ EVM keys */

section('One EVM key, every EVM chain');

{
  const home = mkdtempSync(join(tmpdir(), 'edgerouter-evm-'));
  try {
    const base = loadOrCreateEvmWallet({ network: 'eip155:84532', home });
    check(base.created, 'the first open generates a wallet');
    check(base.path === evmWalletPath(home), 'stored once, not once per chain');

    /*
      The property the whole change rests on: asking for a different chain is
      asking the same key a different question. A second address here would mean
      a second address to fund, which is what this replaced.
    */
    const sepolia = loadOrCreateEvmWallet({ network: 'eip155:11155111', home });
    check(!sepolia.created, 'a second chain does not generate a second wallet');
    check(
      sepolia.wallet.address === base.wallet.address,
      'the same address answers on every EVM chain',
    );
    check(sepolia.wallet.network === 'eip155:11155111', 'and it is on the chain that was asked for');
    check(base.wallet.network === 'eip155:84532', 'while the first handle keeps its own');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

{
  /*
    Adoption. An earlier version wrote a key per chain and some of those
    addresses hold money; a fresh shared wallet beside them would leave the
    funds somewhere the plugin no longer looks.
  */
  const home = mkdtempSync(join(tmpdir(), 'edgerouter-legacy-'));
  try {
    const legacy = {
      privateKey: `0x${'11'.repeat(32)}`,
      address: '0x9a2E12340000000000000000000000000000BEEF',
      network: 'eip155:84532',
    };
    mkdirSync(home, { recursive: true });
    writeFileSync(walletPath('eip155:84532', home), JSON.stringify(legacy));

    const adopted = loadOrCreateEvmWallet({ network: 'eip155:11155111', home });
    check(!adopted.created, 'an existing per-chain key is adopted, not replaced');
    check(
      adopted.wallet.exportPrivateKey().toLowerCase() === legacy.privateKey,
      'and it is the same key, so the money is still reachable',
    );
    check(existsSync(evmWalletPath(home)), 'copied to the shared path');
    check(
      existsSync(walletPath('eip155:84532', home)),
      'and the original is left where it was, not moved out from under a backup',
    );
    check(
      adopted.wallet.network === 'eip155:11155111',
      'the chain comes from the caller, never from the adopted file',
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

console.log(failures === 0 ? '\nAll checks pass.' : `\n${failures} FAILED.`);
if (failures > 0) process.exit(1);
