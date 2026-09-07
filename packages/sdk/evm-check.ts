/**
 * The EVM signer, checked offline.
 *
 * All of it can be checked offline, and that is a property of the scheme rather
 * than a compromise: EIP-3009 is an *authorization*, signed by the payer and
 * submitted later by somebody else. No RPC, no balance, no chain — so the real
 * signature over the real quote is produced here and inspected.
 *
 * What is not checked here is whether a facilitator accepts it, which needs
 * testnet USDC and is `evm-pay-check.ts`.
 *
 *   bun packages/sdk/evm-check.ts
 */
import {
  chainIdOf,
  parseEvmPrivateKey,
  evmSigner,
  formatUsdc,
  type PaymentRequirements,
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

/*
  Hardhat's first account, published in their documentation and funded on
  nothing. A test key in a repository is a real key whatever the file is called,
  so the only safe one to commit is a famously public one.
*/
const TEST_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const TEST_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const AMOY_USDC = '0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582';
const PAY_TO = '0x3f870ECEEE0EcE3a54254C1D364230ABd14aa2d3';

/* --------------------------------------------------------------- identifiers */

section('Network identifiers');

check(chainIdOf('eip155:80002') === 80002, 'a CAIP-2 network yields its chain id');
check(chainIdOf('eip155:8453') === 8453, 'and so does another');

for (const bad of ['hedera:testnet', 'eip155:', '80002', 'eip155:0x1', 'solana:abc']) {
  let refused = false;
  try {
    chainIdOf(bad);
  } catch {
    refused = true;
  }
  check(refused, `"${bad}" is not accepted as an EVM network`);
}

/* ---------------------------------------------------------------------- keys */

section('Keys');

check(parseEvmPrivateKey(TEST_KEY).startsWith('0x'), 'a 0x-prefixed key parses');
check(
  parseEvmPrivateKey(TEST_KEY.slice(2)) === TEST_KEY,
  'a key without the prefix parses to the same thing',
);

let rejected = false;
try {
  parseEvmPrivateKey('deadbeef');
} catch (error) {
  rejected = true;
  check(!String(error).includes('deadbeef'), 'a bad key error does not echo the key back');
}
check(rejected, 'a short key is rejected');

/* -------------------------------------------------------------------- signer */

section('Signing');

const signer = evmSigner({ privateKey: TEST_KEY, network: 'eip155:80002' });
check(signer.accountId === TEST_ADDRESS, 'the signer reports its checksummed address');
check(signer.network === 'eip155:80002', 'and the network it signs for');

const quote = (over: Partial<PaymentRequirements> = {}): PaymentRequirements => ({
  scheme: 'exact',
  network: 'eip155:80002',
  amount: '1000',
  asset: AMOY_USDC,
  payTo: PAY_TO,
  maxTimeoutSeconds: 60,
  extra: { assetTransferMethod: 'eip3009', name: 'USDC', version: '2' },
  ...over,
});

/*
  The EIP-712 domain is not guessable, and a plausible default is the dangerous
  answer: the signature would be valid over a message the token contract never
  validates, so it verifies against nothing and surfaces at the facilitator as
  a malformed payment rather than as a missing field.
*/
let domainRefused = false;
try {
  await signer.createPayload(2, quote({ extra: { assetTransferMethod: 'eip3009' } }));
} catch (error) {
  domainRefused = true;
  check(
    String(error).includes('extra.name') || String(error).includes('extra.version'),
    'a quote with no EIP-712 domain is refused, naming the missing field',
  );
}
check(domainRefused, 'a quote with no EIP-712 domain is not signed anyway');

type Eip3009 = {
  signature?: string;
  authorization?: Record<string, string>;
};

const payload = (await signer.createPayload(2, quote())) as Eip3009;
check(typeof payload.signature === 'string', 'signing produces a signature');
check(/^0x[0-9a-f]{130}$/i.test(payload.signature ?? ''), 'the signature is 65 bytes of hex');

const auth = payload.authorization ?? {};
check(auth.from?.toLowerCase() === TEST_ADDRESS.toLowerCase(), 'the money leaves the signer');
check(auth.to?.toLowerCase() === PAY_TO.toLowerCase(), 'and goes to the payTo in the quote');
check(auth.value === '1000', 'for the amount in the quote, not one the signer chose');
check(/^0x[0-9a-f]{64}$/i.test(auth.nonce ?? ''), 'with a 32-byte nonce');
check(Number(auth.validBefore) > Date.now() / 1000, 'and a deadline in the future');

/*
  The nonce is what stops one authorization being submitted twice. Identical
  output across two signings would mean a single paid call could be replayed.
*/
const again = (await signer.createPayload(2, quote())) as Eip3009;
check(
  again.authorization?.nonce !== auth.nonce,
  'each authorization gets a fresh nonce, so none can be replayed',
);

/*
  The claim that one signer covers every EVM chain, checked rather than
  asserted: same key, same address, different signature — because `chainId` and
  `verifyingContract` are inside the signed domain.
*/
section('One signer, many chains');

const onBase = evmSigner({ privateKey: TEST_KEY, network: 'eip155:8453' });
check(onBase.accountId === signer.accountId, 'the same key is the same address on every EVM chain');

const elsewhere = (await onBase.createPayload(2, quote({ network: 'eip155:8453' }))) as Eip3009;
check(
  elsewhere.signature !== payload.signature,
  'the signature differs by chain, because chainId is inside the signed domain',
);

const otherToken = (await signer.createPayload(
  2,
  quote({ asset: '0x0000000000000000000000000000000000000001' }),
)) as Eip3009;
check(
  otherToken.signature !== payload.signature,
  'and by token, because verifyingContract is too',
);

/* ------------------------------------------------------------------ display */

section('Display');

check(formatUsdc(1_000_000n) === '1 USDC', 'one USDC formats as one');
check(formatUsdc(1_000n) === '0.001 USDC', 'a thousandth keeps its precision');
check(formatUsdc(1_500_000n) === '1.5 USDC', 'trailing zeros are trimmed');

console.log(failures === 0 ? '\nAll checks pass.' : `\n${failures} FAILED.`);
if (failures > 0) process.exit(1);
