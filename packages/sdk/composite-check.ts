/**
 * One signer, two quote shapes.
 *
 *   bun packages/sdk/composite-check.ts
 *
 * The gate can quote the same chain two ways, and the difference is one field.
 * A plain quote is an EIP-3009 authorization bound to the token; a Circle
 * Gateway quote is bound to the GatewayWallet and says so with
 * `extra.verifyingContract`. A signature made for one is rejected by the other,
 * and rejected as "malformed payment" rather than "wrong domain" — so getting
 * the dispatch wrong is both easy and hard to diagnose.
 *
 * This checks the dispatch happens on the field rather than on the network, by
 * signing both shapes with the same signer and comparing what comes out against
 * the domains the two paths actually use. Offline: no funds, no facilitator,
 * no chain.
 */
import { hashTypedData, recoverTypedDataAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { evmSigner, type PaymentRequirements } from './src/index';

let failures = 0;
const check = (ok: boolean, label: string, detail = '') => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
};

const KEY = `0x${'11'.repeat(32)}`;
const account = privateKeyToAccount(KEY as `0x${string}`);

const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const ARC_USDC = '0x3600000000000000000000000000000000000000';
const GATEWAY_WALLET = '0x0077777d7EBA4688BDeF3E311b846F25870A19B9';
const PAY_TO = '0x3f870ECEEE0EcE3a54254C1D364230ABd14aa2d3';

console.log('\n  One signer, two quote shapes\n');

const plain: PaymentRequirements = {
  scheme: 'exact',
  network: 'eip155:84532',
  amount: '10000',
  asset: USDC,
  payTo: PAY_TO,
  maxTimeoutSeconds: 60,
  extra: { assetTransferMethod: 'eip3009', name: 'USDC', version: '2' },
};

const batched: PaymentRequirements = {
  scheme: 'exact',
  network: 'eip155:5042002',
  amount: '10000',
  asset: ARC_USDC,
  payTo: PAY_TO,
  maxTimeoutSeconds: 60,
  extra: {
    name: 'GatewayWalletBatched',
    version: '1',
    verifyingContract: GATEWAY_WALLET,
    domain: 26,
  },
};

const signerFor = (network: string) => evmSigner({ privateKey: KEY, network });

const plainPayload = (await signerFor('eip155:84532').createPayload(2, plain)) as {
  signature: `0x${string}`;
  authorization: Record<string, unknown>;
};
const batchedPayload = (await signerFor('eip155:5042002').createPayload(2, batched)) as {
  signature: `0x${string}`;
  authorization: Record<string, unknown>;
};

check(Boolean(plainPayload.signature), 'a plain quote is signed');
check(Boolean(batchedPayload.signature), 'a Gateway quote is signed');
check(
  plainPayload.signature !== batchedPayload.signature,
  'and they are different signatures, not the same one twice',
);

/*
  The claim worth checking: each signature recovers to this account *under its
  own domain*. Recovering under the other one is what a mis-dispatched signer
  would produce, and it is the failure the facilitator reports as malformed.
*/
const types = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

const recoverUnder = async (
  verifyingContract: string,
  name: string,
  chainId: number,
  payload: { signature: `0x${string}`; authorization: Record<string, unknown> },
) =>
  recoverTypedDataAddress({
    domain: { name, version: chainId === 5042002 ? '1' : '2', chainId, verifyingContract: verifyingContract as `0x${string}` },
    types,
    primaryType: 'TransferWithAuthorization',
    message: payload.authorization as never,
    signature: payload.signature,
  }).catch(() => '0xdead' as const);

const plainUnderToken = await recoverUnder(USDC, 'USDC', 84532, plainPayload);
check(
  plainUnderToken.toLowerCase() === account.address.toLowerCase(),
  'the plain signature is bound to the token contract',
);

const batchedUnderGateway = await recoverUnder(
  GATEWAY_WALLET,
  'GatewayWalletBatched',
  5042002,
  batchedPayload,
);
check(
  batchedUnderGateway.toLowerCase() === account.address.toLowerCase(),
  'the Gateway signature is bound to the GatewayWallet contract',
);

const batchedUnderToken = await recoverUnder(ARC_USDC, 'USDC', 5042002, batchedPayload);
check(
  batchedUnderToken.toLowerCase() !== account.address.toLowerCase(),
  'and is not a valid signature over the token’s own domain',
);

/*
  The dispatch key. A quote for the same chain without batching metadata must
  take the plain path — otherwise adding Arc to the gate would silently change
  how every existing chain is signed.
*/
const arcPlain: PaymentRequirements = {
  ...batched,
  extra: { assetTransferMethod: 'eip3009', name: 'USDC', version: '2' },
};
const arcPlainPayload = (await signerFor('eip155:5042002').createPayload(2, arcPlain)) as {
  signature: `0x${string}`;
};
check(
  arcPlainPayload.signature !== batchedPayload.signature,
  'the same chain signs differently depending on the quote, not the network',
);

console.log(failures === 0 ? '\n  All checks pass.\n' : `\n  ${failures} FAILED.\n`);
if (failures > 0) process.exit(1);
void hashTypedData;
