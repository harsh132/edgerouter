/**
 * Tab vouchers, checked without a network.
 *
 * The gate verifies vouchers with exactly these functions, so what passes here
 * is what the gate accepts — there is no second implementation to drift from.
 * What these cannot prove is the gate's ledger, which lives in a Durable Object
 * and is exercised against `wrangler dev`.
 *
 *   bun packages/sdk/tab-check.ts
 */
import { privateKeyToAccount } from 'viem/accounts';
import {
  decodeReceipt,
  decodeVoucher,
  encodeReceipt,
  encodeVoucher,
  newNonce,
  receiptComment,
  receiptFromLine,
  recoverVoucherSigner,
  signVoucher,
  type TypedDataSigner,
} from './src/tab/voucher';

let failures = 0;
const check = (condition: boolean, message: string) => {
  if (condition) console.log(`  ok    ${message}`);
  else {
    failures += 1;
    console.log(`  FAIL  ${message}`);
  }
};

/*
  Throwaway keys generated for this run. They hold nothing, sign nothing but
  the vouchers below, and are never written anywhere.
*/
const randomKey = (): `0x${string}` => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `0x${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
};
const payer = privateKeyToAccount(randomKey()) as unknown as TypedDataSigner;
const stranger = privateKeyToAccount(randomKey()) as unknown as TypedDataSigner;

const ARC = 5042002;
const GATE = '0x3f870ECEEE0EcE3a54254C1D364230ABd14aa2d3' as const;

console.log('Tab vouchers\n');

const nonce = newNonce();
check(/^0x[0-9a-f]{64}$/.test(nonce), 'a nonce is 32 bytes of hex');
check(newNonce() !== nonce, 'nonces do not repeat');

const signed = await signVoucher(payer, {
  chainId: ARC,
  voucher: {
    payee: GATE,
    nonce,
    maxAmount: '10000',
    expiresAt: Math.floor(Date.now() / 1000) + 300,
    node: 'cto.alex.eth',
  },
});

check(signed.voucher.payer === payer.address, 'the payer is the signer, not a field the caller chose');

const recovered = await recoverVoucherSigner(signed, ARC);
check(recovered?.toLowerCase() === payer.address.toLowerCase(), 'a voucher recovers to the wallet that signed it');

const onOtherChain = await recoverVoucherSigner(signed, 84532);
check(
  onOtherChain?.toLowerCase() !== payer.address.toLowerCase(),
  'the same voucher does not recover to its payer on another chain',
);

const decoded = decodeVoucher(encodeVoucher(signed));
check(decoded !== null && decoded.voucher.nonce === nonce, 'a voucher survives the header round trip');

/*
  Tampering. Each of these must still decode — they are well-formed — and must
  stop recovering to the payer, which is the check the gate actually relies on.
*/
for (const [label, mutate] of [
  ['a raised ceiling', (v: any) => (v.voucher.maxAmount = '10000000')],
  ['a different gate', (v: any) => (v.voucher.payee = stranger.address)],
  ['a reused-looking nonce', (v: any) => (v.voucher.nonce = newNonce())],
  ['an extended expiry', (v: any) => (v.voucher.expiresAt += 86_400)],
  ['another node', (v: any) => (v.voucher.node = 'intern.alex.eth')],
] as const) {
  const copy = JSON.parse(JSON.stringify(signed));
  mutate(copy);
  const who = await recoverVoucherSigner(decodeVoucher(encodeVoucher(copy))!, ARC);
  check(who?.toLowerCase() !== payer.address.toLowerCase(), `refused: ${label}`);
}

const forged = { ...signed, voucher: { ...signed.voucher, payer: stranger.address } };
const forgedSigner = await recoverVoucherSigner(forged, ARC);
check(
  forgedSigner?.toLowerCase() !== stranger.address.toLowerCase(),
  "naming someone else's wallet as payer does not make their tab pay",
);

console.log('\nHeader parsing\n');

check(decodeVoucher(null) === null, 'no header decodes to nothing');
check(decodeVoucher('not base64!!') === null, 'garbage is refused');
for (const [label, mutate] of [
  ['a zero ceiling', (v: any) => (v.voucher.maxAmount = '0')],
  ['a numeric ceiling', (v: any) => (v.voucher.maxAmount = 10000)],
  ['a short nonce', (v: any) => (v.voucher.nonce = '0x1234')],
  ['a missing signature', (v: any) => delete v.signature],
  ['a fractional expiry', (v: any) => (v.voucher.expiresAt = 1.5)],
  ['an empty node', (v: any) => (v.voucher.node = '')],
] as const) {
  const copy = JSON.parse(JSON.stringify(signed));
  mutate(copy);
  check(decodeVoucher(encodeVoucher(copy)) === null, `refused at parse: ${label}`);
}

console.log('\nReceipts\n');

const receipt = { nonce, chargedMinor: '123', balanceMinor: '49877' };
check(decodeReceipt(encodeReceipt(receipt))?.chargedMinor === '123', 'a header receipt round-trips');

const comment = receiptComment(receipt);
check(comment.startsWith(':'), 'a stream receipt is an SSE comment, which parsers ignore');
check(comment.endsWith('\n\n'), 'it ends its own event');
check(receiptFromLine(comment.trim())?.balanceMinor === '49877', 'a stream receipt reads back from its line');
check(receiptFromLine('data: {"usage":{}}') === null, 'an ordinary data line is not a receipt');
check(receiptFromLine(': edgerouter-tab {"nonce":"0x12"}') === null, 'a malformed receipt is refused');

console.log(failures === 0 ? '\nAll checks pass.' : `\n${failures} FAILED.`);
process.exit(failures === 0 ? 0 : 1);
