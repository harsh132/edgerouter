/**
 * Arc, checked against the chain itself.
 *
 *   bun packages/sdk/arc-check.ts
 *
 * Reads only. No funds, no facilitator, no transaction — and it still answers
 * the question that matters, which is whether a signature this project produces
 * would be accepted on Arc.
 *
 * The trick is the EIP-712 domain separator. A payment under the `exact` scheme
 * is a signature over a struct bound to a domain built from the token's own
 * `name`, `version`, the chain id, and the token address. Get any of those
 * wrong and the signature is perfectly valid over a message nobody will ever
 * check: the token rejects it, and the facilitator reports a malformed payment
 * rather than a wrong domain. But the token publishes `DOMAIN_SEPARATOR()`, so
 * the domain can be computed locally and compared to the one the contract will
 * actually verify against. If they match, the signer is right about this chain.
 *
 * What this cannot check is settlement. No facilitator known to this project
 * covers Arc, so the gate cannot quote it yet — see the note at the end.
 */
import { createPublicClient, hashDomain, http, parseAbi } from 'viem';
import { ARC_TESTNET, chainIdOf, evmSigner, USDC, RPC_URLS } from './src/index';
import type { PaymentRequirements } from './src/index';

let failures = 0;
const check = (ok: boolean, label: string, detail = '') => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
};

const asset = USDC[ARC_TESTNET]!;
const rpc = RPC_URLS[ARC_TESTNET]!;
const client = createPublicClient({ transport: http(rpc) });

console.log('\n  Arc testnet\n');

const chainId = await client.getChainId();
check(chainId === chainIdOf(ARC_TESTNET), 'the RPC is the chain the identifier names', String(chainId));

const meta = parseAbi([
  'function name() view returns (string)',
  'function version() view returns (string)',
  'function decimals() view returns (uint8)',
  'function DOMAIN_SEPARATOR() view returns (bytes32)',
  'function authorizationState(address a, bytes32 nonce) view returns (bool)',
]);

const read = <T>(functionName: string, args: readonly unknown[] = []) =>
  client.readContract({ address: asset, abi: meta, functionName: functionName as never, args: args as never }) as Promise<T>;

const [name, version, decimals] = await Promise.all([
  read<string>('name'),
  read<string>('version'),
  read<number>('decimals'),
]);
check(name === 'USDC' && decimals === 6, 'the asset is six-decimal USDC', `${name}, ${decimals} decimals`);

/*
  EIP-3009, established by calling it rather than by reading bytecode. Arc's
  USDC is a precompile behind a thin dispatcher, so scanning its runtime code
  for selectors finds almost nothing and proves almost nothing — `name()` is
  absent from the bytecode too, and answers.
*/
let hasAuthorization = true;
try {
  await read<boolean>('authorizationState', [asset, `0x${'00'.repeat(32)}`]);
} catch {
  hasAuthorization = false;
}
check(hasAuthorization, 'EIP-3009 is implemented, so `exact` can be signed here');

/*
  The claim this file exists for.
*/
const onChain = await read<`0x${string}`>('DOMAIN_SEPARATOR');
const computed = hashDomain({
  domain: { name, version, chainId: BigInt(chainId), verifyingContract: asset },
  types: {
    EIP712Domain: [
      { name: 'name', type: 'string' },
      { name: 'version', type: 'string' },
      { name: 'chainId', type: 'uint256' },
      { name: 'verifyingContract', type: 'address' },
    ],
  },
});
check(
  computed.toLowerCase() === onChain.toLowerCase(),
  'the domain a signature would be bound to is the one the token verifies',
  onChain,
);

/*
  And the signer itself, over a quote shaped like one the gate would send. The
  key is a throwaway: what is being checked is that a payload comes out with the
  fields the scheme requires, not that any particular account can pay.
*/
const throwaway = `0x${'11'.repeat(32)}`;
const signer = evmSigner({ privateKey: throwaway, network: ARC_TESTNET });

const quote: PaymentRequirements = {
  scheme: 'exact',
  network: ARC_TESTNET,
  amount: '10000',
  asset,
  payTo: '0x3f870ECEEE0EcE3a54254C1D364230ABd14aa2d3',
  maxTimeoutSeconds: 180,
  extra: { name, version },
};

const payload = (await signer.createPayload(2, quote)) as {
  signature?: string;
  authorization?: Record<string, unknown>;
};
check(typeof payload.signature === 'string', 'the signer produces a signature for an Arc quote');
check(
  payload.authorization?.to === quote.payTo && payload.authorization?.value === quote.amount,
  'over the amount and recipient the quote asked for',
);

console.log('\n  Settlement');
console.log('  No facilitator known to this project settles Arc, so the gate does');
console.log('  not quote it. Everything above is what would be needed the day one');
console.log('  does: the signer, the domain, and the asset are already right.');

console.log(failures === 0 ? '\n  All checks pass.\n' : `\n  ${failures} FAILED.\n`);
if (failures > 0) process.exit(1);
