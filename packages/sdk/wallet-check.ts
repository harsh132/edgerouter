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
import { privateKeyToAccount } from 'viem/accounts';
import {
  generateWallet,
  rawKeyOf,
  walletFromKey,
  openWallet,
  loadOrCreateWallet,
  loadOrCreateEvmWallet,
  walletPath,
  sharedWalletPath,
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
  check(first.path === sharedWalletPath(home), 'it lands where it says it does');
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

  /*
    One key covers Hedera's networks too, so this is the same address on
    mainnet — deliberately. What used to be checked here was the opposite, and
    the isolation it described was real: a leaked key is now every network. The
    trade is stated in `sharedWalletPath`, and the bound that actually holds is
    the balance, not the file.
  */
  const other = loadOrCreateWallet({ network: 'hedera:mainnet', home, fetch: mirror('missing') });
  check(
    other.wallet.evmAddress === first.wallet.evmAddress,
    'the same key answers on another Hedera network',
  );
  check(other.wallet.network === 'hedera:mainnet', 'as the network it was asked for');

  const funded = loadOrCreateWallet({
    network: 'hedera:testnet',
    home,
    fetch: mirror({ account: '0.0.5150', tinybars: 100 }),
  });
  await funded.wallet.refresh();
  const onDisk = JSON.parse(readFileSync(funded.path, 'utf8')) as {
    address: string;
    accounts?: Record<string, string>;
  };
  check(
    onDisk.accounts?.['hedera:testnet'] === '0.0.5150',
    'the resolved account id is written back, under its network',
  );
  check(
    onDisk.accounts?.['hedera:mainnet'] === undefined,
    'and only under its network — the same key is a different account elsewhere',
  );
  check(
    onDisk.address.toLowerCase() === first.wallet.evmAddress.toLowerCase(),
    'writing the id back did not replace the key',
  );

  // The failure worth being certain about: a damaged file must never be
  // silently replaced, because the key it held may still hold money.
  writeFileSync(sharedWalletPath(home), 'not json at all');
  await throws('move it aside', 'a damaged wallet file is refused, not overwritten', () =>
    loadOrCreateWallet({ network: 'hedera:testnet', home, fetch: mirror('missing') }),
  );
} finally {
  rmSync(home, { recursive: true, force: true });
}

/* ------------------------------------------------------------------- one key */

section('One key, every chain');

{
  /*
    The assumption the storage layer now rests on, checked rather than trusted:
    a Hedera ECDSA key and an EVM key are the same secp256k1 scalar, so the same
    key yields the same twenty bytes through either derivation. If this ever
    stopped holding, one wallet would silently become two addresses again.
  */
  const material = generateWallet('hedera:testnet');
  const viaViem = privateKeyToAccount(`0x${rawKeyOf(material.privateKey)}`).address;
  check(
    viaViem.toLowerCase() === material.evmAddress.toLowerCase(),
    'Hedera and viem derive the same address from one key',
  );

  const round = walletFromKey(rawKeyOf(material.privateKey), 'hedera:testnet');
  check(round.evmAddress === material.evmAddress, 'a raw key rebuilds the same wallet');
  check(round.privateKey === material.privateKey, 'and the same DER form');
}

{
  const home = mkdtempSync(join(tmpdir(), 'edgerouter-onekey-'));
  try {
    const hedera = loadOrCreateWallet({ network: 'hedera:testnet', home, fetch: mirror('missing') });
    check(hedera.created, 'the first open generates a key');
    check(hedera.path === sharedWalletPath(home), 'stored once, not once per chain');

    const sepolia = loadOrCreateEvmWallet({ network: 'eip155:11155111', home });
    check(!sepolia.created, 'an EVM chain reuses it rather than generating');
    check(
      sepolia.wallet.address.toLowerCase() === hedera.wallet.evmAddress.toLowerCase(),
      'the Hedera address and the EVM address are one address',
    );

    const base = loadOrCreateEvmWallet({ network: 'eip155:84532', home });
    check(base.wallet.address === sepolia.wallet.address, 'and it is the same on every EVM chain');
    check(base.wallet.network === 'eip155:84532', 'while the chain comes from the caller');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

{
  /*
    Adoption. Earlier versions wrote a key per chain and some of those addresses
    hold money; a fresh key beside them would leave the funds where this code no
    longer looks. Hedera is preferred because its account id is the one thing
    here that cannot be re-derived from the key.
  */
  const home = mkdtempSync(join(tmpdir(), 'edgerouter-legacy-'));
  try {
    mkdirSync(home, { recursive: true });
    const legacy = generateWallet('hedera:testnet');
    writeFileSync(
      walletPath('hedera:testnet', home),
      JSON.stringify({ ...legacy, accountId: '0.0.4242' }),
    );
    writeFileSync(
      walletPath('eip155:84532', home),
      JSON.stringify({
        privateKey: `0x${'11'.repeat(32)}`,
        address: '0x9a2E12340000000000000000000000000000BEEF',
        network: 'eip155:84532',
      }),
    );

    const adopted = loadOrCreateWallet({ network: 'hedera:testnet', home, fetch: mirror('missing') });
    check(!adopted.created, 'an existing key is adopted, not replaced');
    check(
      adopted.wallet.evmAddress === legacy.evmAddress,
      'the Hedera key wins over the EVM one, because it may carry an account id',
    );
    check(adopted.wallet.accountId() === '0.0.4242', 'and that account id survives');
    check(existsSync(sharedWalletPath(home)), 'copied to the shared path');
    check(
      existsSync(walletPath('hedera:testnet', home)),
      'and the original is left where it was, not moved out from under a backup',
    );

    const evm = loadOrCreateEvmWallet({ network: 'eip155:84532', home });
    check(
      evm.wallet.address.toLowerCase() === legacy.evmAddress.toLowerCase(),
      'the adopted key answers on EVM chains too',
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

console.log(failures === 0 ? '\nAll checks pass.' : `\n${failures} FAILED.`);
if (failures > 0) process.exit(1);
