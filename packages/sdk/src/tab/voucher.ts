/**
 * Tab vouchers: paying for one call out of money already sent.
 *
 * A tab is a prepaid balance the gate holds for one wallet. Topping it up is an
 * ordinary x402 payment; spending it is not a payment at all, because nothing
 * moves on chain. What moves instead is a voucher — a signature from the tab's
 * owner saying "take up to this much from my tab, once, for this call" — and the
 * gate charges the tab what the call actually cost, which is the whole reason a
 * tab exists. A per-call x402 payment has to name its price before the work
 * happens; a voucher only has to name a ceiling.
 *
 * ## Why a signature and not a session token
 *
 * A bearer secret for the tab would be simpler and would be wrong. Every agent
 * in a crew pays from one wallet, and handing each of them a secret that spends
 * the wallet's tab is handing each of them the wallet's tab — the per-agent
 * budgets the authority enforces would stop meaning anything the moment one of
 * them kept the token. A voucher is single-use, capped, and producible only by
 * whatever holds the key, which is the authority. So the authority stays the
 * one place a per-agent limit is decided, and the gate never learns there are
 * agents at all.
 *
 * ## What is signed
 *
 * EIP-712 typed data, verified by recovering the signer:
 *
 *   payer      the wallet whose tab is charged — must be the recovered signer
 *   payee      the gate's `payTo`, so a voucher for one gate is worthless to another
 *   nonce      32 random bytes; the gate spends each at most once
 *   maxAmount  the ceiling, in the asset's smallest unit
 *   expiresAt  unix seconds; after this the gate refuses it
 *   node       which budget node asked. Informational to the gate, which uses it
 *              only to say who spent what — the money is the payer's either way
 *
 * The chain id is in the domain, and the gate supplies it from its own network
 * configuration rather than reading it from the request. A voucher signed for
 * one chain does not verify on another.
 */
import { recoverTypedDataAddress, type Hex } from 'viem';

export const TAB_HEADER = {
  /** Sent with a call paid from a tab. base64 JSON `SignedVoucher`. */
  voucher: 'X-Tab-Voucher',
  /** Returned on a non-streamed response. base64 JSON `TabReceipt`. */
  receipt: 'X-Tab-Receipt',
} as const;

/**
 * The line that ends a streamed response paid from a tab.
 *
 * An SSE *comment* — a line beginning with `:` — because every compliant SSE
 * parser discards comments. That matters more than it sounds: the agent loop
 * reading this stream is somebody else's code, and a custom `event:` it did not
 * expect is a parse error waiting to happen, whereas a comment is something it
 * already ignores. OpenRouter sends `: OPENROUTER PROCESSING` the same way, so
 * any parser that has ever talked to it has already survived one.
 */
export const RECEIPT_COMMENT = ': edgerouter-tab ';

export const VOUCHER_DOMAIN_NAME = 'edgerouter tab';
export const VOUCHER_DOMAIN_VERSION = '1';

export const VOUCHER_TYPES = {
  Voucher: [
    { name: 'payer', type: 'address' },
    { name: 'payee', type: 'address' },
    { name: 'nonce', type: 'bytes32' },
    { name: 'maxAmount', type: 'uint256' },
    { name: 'expiresAt', type: 'uint256' },
    { name: 'node', type: 'string' },
  ],
} as const;

export type Voucher = {
  payer: Hex;
  payee: Hex;
  nonce: Hex;
  /** Smallest unit, as a decimal string — precision must survive JSON. */
  maxAmount: string;
  /** Unix seconds. */
  expiresAt: number;
  node: string;
};

export type SignedVoucher = {
  voucher: Voucher;
  signature: Hex;
};

/** What the gate says a voucher cost. */
export type TabReceipt = {
  nonce: Hex;
  /** What was taken from the tab. Never more than the voucher's `maxAmount`. */
  chargedMinor: string;
  /** The tab after this call. */
  balanceMinor: string;
};

/** Whatever can sign typed data for the payer. A viem account satisfies this. */
export type TypedDataSigner = {
  readonly address: Hex;
  signTypedData(data: {
    domain: { name: string; version: string; chainId: number };
    types: typeof VOUCHER_TYPES;
    primaryType: 'Voucher';
    message: Record<string, unknown>;
  }): Promise<Hex>;
};

const domainFor = (chainId: number) => ({
  name: VOUCHER_DOMAIN_NAME,
  version: VOUCHER_DOMAIN_VERSION,
  chainId,
});

const messageOf = (voucher: Voucher) => ({
  payer: voucher.payer,
  payee: voucher.payee,
  nonce: voucher.nonce,
  maxAmount: BigInt(voucher.maxAmount),
  expiresAt: BigInt(voucher.expiresAt),
  node: voucher.node,
});

/** A fresh 32-byte nonce. Random rather than counted, so no state is needed to issue one. */
export const newNonce = (): Hex => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `0x${[...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')}` as Hex;
};

export const signVoucher = async (
  signer: TypedDataSigner,
  params: { chainId: number; voucher: Omit<Voucher, 'payer'> },
): Promise<SignedVoucher> => {
  const voucher: Voucher = { ...params.voucher, payer: signer.address };
  const signature = await signer.signTypedData({
    domain: domainFor(params.chainId),
    types: VOUCHER_TYPES,
    primaryType: 'Voucher',
    message: messageOf(voucher),
  });
  return { voucher, signature };
};

const isHex = (value: unknown, bytes?: number): value is Hex =>
  typeof value === 'string' &&
  (bytes === undefined ? /^0x[0-9a-fA-F]*$/ : new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`)).test(value);

/**
 * Narrows what arrived in the header, refusing anything not exactly a voucher.
 *
 * Every field is checked rather than cast: this decides how much of somebody's
 * money is taken, and it was written by whoever called.
 */
export const readVoucher = (value: unknown): SignedVoucher | null => {
  if (!value || typeof value !== 'object') return null;
  const outer = value as Record<string, unknown>;
  if (!isHex(outer.signature) || !outer.voucher || typeof outer.voucher !== 'object') return null;

  const v = outer.voucher as Record<string, unknown>;
  if (!isHex(v.payer, 20) || !isHex(v.payee, 20) || !isHex(v.nonce, 32)) return null;
  if (typeof v.maxAmount !== 'string' || !/^\d+$/.test(v.maxAmount) || BigInt(v.maxAmount) <= 0n) {
    return null;
  }
  if (typeof v.expiresAt !== 'number' || !Number.isSafeInteger(v.expiresAt) || v.expiresAt <= 0) {
    return null;
  }
  if (typeof v.node !== 'string' || v.node.length === 0 || v.node.length > 128) return null;

  return {
    signature: outer.signature,
    voucher: {
      payer: v.payer,
      payee: v.payee,
      nonce: v.nonce,
      maxAmount: v.maxAmount,
      expiresAt: v.expiresAt,
      node: v.node,
    },
  };
};

/**
 * Who signed this voucher, or null when the signature does not parse.
 *
 * The caller compares the result with `voucher.payer`. Recovering rather than
 * verifying against a claimed address is what makes the comparison meaningful:
 * a signature always recovers to *somebody*, and the only question is whether
 * that somebody owns the tab being charged.
 */
export const recoverVoucherSigner = async (
  signed: SignedVoucher,
  chainId: number,
): Promise<Hex | null> => {
  try {
    return await recoverTypedDataAddress({
      domain: domainFor(chainId),
      types: VOUCHER_TYPES,
      primaryType: 'Voucher',
      message: messageOf(signed.voucher),
      signature: signed.signature,
    });
  } catch {
    return null;
  }
};

/* ----------------------------------------------------------------- encoding */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const toBase64 = (text: string): string => {
  let binary = '';
  for (const byte of encoder.encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const fromBase64 = (encoded: string): string | null => {
  try {
    const binary = atob(encoded.trim());
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return decoder.decode(bytes);
  } catch {
    return null;
  }
};

export const encodeVoucher = (signed: SignedVoucher): string => toBase64(JSON.stringify(signed));

export const decodeVoucher = (header: string | null): SignedVoucher | null => {
  if (!header) return null;
  const json = fromBase64(header);
  if (json === null) return null;
  try {
    return readVoucher(JSON.parse(json));
  } catch {
    return null;
  }
};

const readReceipt = (value: unknown): TabReceipt | null => {
  if (!value || typeof value !== 'object') return null;
  const r = value as Record<string, unknown>;
  if (!isHex(r.nonce, 32)) return null;
  if (typeof r.chargedMinor !== 'string' || !/^\d+$/.test(r.chargedMinor)) return null;
  if (typeof r.balanceMinor !== 'string' || !/^\d+$/.test(r.balanceMinor)) return null;
  return { nonce: r.nonce, chargedMinor: r.chargedMinor, balanceMinor: r.balanceMinor };
};

export const encodeReceipt = (receipt: TabReceipt): string => toBase64(JSON.stringify(receipt));

export const decodeReceipt = (header: string | null): TabReceipt | null => {
  if (!header) return null;
  const json = fromBase64(header);
  if (json === null) return null;
  try {
    return readReceipt(JSON.parse(json));
  } catch {
    return null;
  }
};

/** The comment line a stream ends with, newlines included. */
export const receiptComment = (receipt: TabReceipt): string =>
  `${RECEIPT_COMMENT}${JSON.stringify(receipt)}\n\n`;

/** Reads a receipt out of one SSE line, or null when the line is anything else. */
export const receiptFromLine = (line: string): TabReceipt | null => {
  if (!line.startsWith(RECEIPT_COMMENT)) return null;
  try {
    return readReceipt(JSON.parse(line.slice(RECEIPT_COMMENT.length)));
  } catch {
    return null;
  }
};
