/**
 * The client half of a tab: ask for a voucher, present it, read the receipt.
 *
 *   terms  →  voucher  →  request  →  (tab short? top up, retry)  →  receipt
 *
 * Deliberately not `payAndFetch` with a flag. The two loops disagree about the
 * one thing that matters most: a per-call payment is decided before the request
 * and is final, a voucher is a ceiling whose real price arrives at the end of
 * the response. Folding them together would put an "is this the real price
 * yet" question behind every read of `quote.amount` in the code above it.
 */
import { PaymentRefused } from '../pay/types';
import {
  TAB_HEADER,
  decodeReceipt,
  encodeVoucher,
  receiptFromLine,
  type SignedVoucher,
  type TabQuote,
  type TabReceipt,
} from './voucher';

/** What a gate publishes about paying it from a tab, on one network. */
export type TabTerms = {
  network: string;
  payTo: string;
  /** Per model: the reserve, already in the asset's smallest unit. */
  reserves: ReadonlyMap<string, bigint>;
};

type ModelsBody = {
  data?: { id?: unknown; pricing?: { tab_reserve_minor?: unknown } }[];
  tabs?: { network?: unknown; payTo?: unknown; unitsPerUsdMinor?: unknown }[];
};

/**
 * Reads a gate's tab terms from its model list.
 *
 * Null when the gate keeps no tab on this network — the caller then pays per
 * call as it always did, rather than failing on a feature the gate never
 * offered.
 */
export const fetchTabTerms = async (
  gate: string,
  network: string,
  doFetch: typeof fetch = fetch,
): Promise<TabTerms | null> => {
  const response = await doFetch(new URL('/v1/models', gate).toString());
  if (!response.ok) return null;
  const body = (await response.json()) as ModelsBody;

  const tab = body.tabs?.find((entry) => entry.network === network);
  if (!tab || typeof tab.payTo !== 'string') return null;
  const units =
    typeof tab.unitsPerUsdMinor === 'string' && /^\d+$/.test(tab.unitsPerUsdMinor) ? BigInt(tab.unitsPerUsdMinor) : 1n;

  const reserves = new Map<string, bigint>();
  for (const model of body.data ?? []) {
    const reserve = model.pricing?.tab_reserve_minor;
    if (typeof model.id === 'string' && typeof reserve === 'string' && /^\d+$/.test(reserve)) {
      reserves.set(model.id, BigInt(reserve) * units);
    }
  }
  return { network, payTo: tab.payTo, reserves };
};

export type TabShortfall = { balanceMinor: bigint; reserveMinor: bigint };

export type TabPayOptions = {
  terms: TabTerms;
  /** Produces the voucher. For an agent, the authority; for a wallet, its own key. */
  voucherFor(quote: TabQuote): Promise<SignedVoucher>;
  /**
   * Called when the tab cannot cover this call. True means it was topped up
   * and the same voucher should be presented again.
   *
   * The same voucher, not a new one: the gate refused it before reserving
   * anything, so its nonce is still unspent — and a fresh voucher would reserve
   * a second ceiling against the agent's budget for one call.
   */
  topUp?(shortfall: TabShortfall): Promise<boolean>;
  init?: { method?: string; headers?: Record<string, string>; body?: string };
  fetch?: typeof fetch;
};

export type TabPayResult = {
  response: Response;
  /** The voucher's nonce, known before the answer is — for settling if the stream is cut. */
  nonce: string;
  reservedMinor: bigint;
  /**
   * The gate's receipt, once the body has been read to the end.
   *
   * Resolves null when there was none. Never awaited by this function: the
   * caller owns the body, and a receipt that waited on a body nobody reads
   * would never arrive.
   */
  receipt: Promise<TabReceipt | null>;
};

const modelOf = (body: string | undefined): string | null => {
  if (!body) return null;
  try {
    const parsed = JSON.parse(body) as { model?: unknown };
    return typeof parsed.model === 'string' ? parsed.model : null;
  } catch {
    return null;
  }
};

/**
 * Wraps a streamed body so the receipt comment is noticed as it passes.
 *
 * The bytes go through untouched — the comment included, because an SSE parser
 * ignores it — so whatever reads the stream sees exactly what the gate sent.
 */
const watchForReceipt = (response: Response): { response: Response; receipt: Promise<TabReceipt | null> } => {
  const fromHeader = decodeReceipt(response.headers.get(TAB_HEADER.receipt));
  const streamed = (response.headers.get('content-type') ?? '').includes('text/event-stream');
  if (fromHeader || !response.body || !streamed) {
    return { response, receipt: Promise.resolve(fromHeader) };
  }

  let resolve!: (receipt: TabReceipt | null) => void;
  const receipt = new Promise<TabReceipt | null>((done) => {
    resolve = done;
  });

  let found: TabReceipt | null = null;
  let partial = '';
  const decoder = new TextDecoder();

  const watched = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        controller.enqueue(chunk);
        const lines = (partial + decoder.decode(chunk, { stream: true })).split('\n');
        partial = lines.pop() ?? '';
        for (const line of lines) found = receiptFromLine(line.trimEnd()) ?? found;
      },
      flush() {
        if (partial) found = receiptFromLine(partial.trimEnd()) ?? found;
        resolve(found);
      },
    }),
  );

  return {
    response: new Response(watched, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    }),
    receipt,
  };
};

export const payFromTab = async (url: string, options: TabPayOptions): Promise<TabPayResult> => {
  const doFetch = options.fetch ?? fetch;
  const init = options.init ?? {};

  const model = modelOf(init.body);
  const reserveMinor = model === null ? undefined : options.terms.reserves.get(model);
  if (reserveMinor === undefined) {
    throw new PaymentRefused('bad_quote', `the gate lists no tab price for ${model ?? 'this request'}`);
  }

  const signed = await options.voucherFor({
    network: options.terms.network,
    payTo: options.terms.payTo,
    reserveMinor,
  });

  const send = () =>
    doFetch(url, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        'X-Payment-Network': options.terms.network,
        [TAB_HEADER.voucher]: encodeVoucher(signed),
      },
    });

  let response = await send();

  if (response.status === 402 && options.topUp) {
    let shortfall: TabShortfall | null = null;
    try {
      const body = (await response.clone().json()) as {
        error?: { code?: unknown };
        balanceMinor?: unknown;
        reserveMinor?: unknown;
      };
      if (body.error?.code === 'tab_insufficient') {
        shortfall = {
          balanceMinor: typeof body.balanceMinor === 'string' ? BigInt(body.balanceMinor) : 0n,
          reserveMinor: typeof body.reserveMinor === 'string' ? BigInt(body.reserveMinor) : reserveMinor,
        };
      }
    } catch {
      /* not the tab's refusal; returned to the caller as it is */
    }
    if (shortfall && (await options.topUp(shortfall))) response = await send();
  }

  const watched = watchForReceipt(response);
  return {
    response: watched.response,
    nonce: signed.voucher.nonce,
    reservedMinor: reserveMinor,
    receipt: watched.receipt,
  };
};
