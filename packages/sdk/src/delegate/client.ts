/**
 * The sub-agent's half: a `PaymentSigner` that holds no key.
 *
 * It satisfies the same interface as `hederaSigner` and is substitutable for
 * it everywhere — `payAndFetch` cannot tell them apart, and neither can the
 * DSH adapter. The only difference is where the signature comes from: a local
 * signer has the key, and this one asks something that does.
 *
 * That substitutability is the point. A sub-agent is not a different kind of
 * client with a different code path; it is the same client, pointed at an
 * allowance instead of a wallet. Nothing above the signer changes, so nothing
 * above the signer can be got wrong.
 *
 *   const { signer } = await connectAuthority({ url, capability });
 *   await payAndFetch(gate, { signer, maxAmount });
 *
 * The per-call cap still applies on top. Two independent bounds — the caller's
 * `maxAmount` here, and the authority's ceiling and budget over there — and a
 * payment has to satisfy both. Neither can be widened by the other.
 */
import { PaymentRefused, type PaymentRequirements, type PaymentSigner } from '../pay/types';
import type {
  AuthorityError,
  BalancesResponse,
  MintResponse,
  RevokeResponse,
  SignResponse,
  VoucherResponse,
  VoucherSettleResponse,
} from './wire';
import type { SignedVoucher, TabQuote } from '../tab/voucher';

export type ConnectOptions = {
  /** Where the authority listens. Loopback, in every intended deployment. */
  url: string;
  /** `er_<base64>`, from whoever delegated to this agent. */
  capability: string;
  /**
   * The resource this agent pays for, reported to the authority so a `host`
   * caveat means something. Self-reported and known to be — the authority's
   * `allowPayTo` is what actually binds where money can go.
   */
  resourceUrl?: string;
  fetch?: typeof fetch;
};

export class AuthorityUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthorityUnavailable';
  }
}

/** What the authority refused, kept distinct from a transport failure. */
export class AuthorityDenied extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AuthorityDenied';
  }
}

export type Connection = {
  /** The node this capability speaks for. */
  readonly node: string;
  /** The account payments will leave from. Not this agent's — the authority's. */
  readonly account: string;
  readonly network: string;
  /** Per-call ceiling from the capability, in the smallest unit. */
  readonly ceilingMinor: bigint | null;
  readonly expiresAt: number | null;
  /** Drop-in for `hederaSigner`. Holds nothing secret. */
  readonly signer: PaymentSigner;
  /** What remained after the last payment. Null until one is made. */
  remainingMinor(): bigint | null;
  /** Sub-delegate. Moves budget down; needs the authority, because money moves. */
  mint(params: {
    child: string;
    amountMinor: bigint;
    expiresAt: number;
    ceilingMinor?: bigint;
    allowHosts?: readonly string[];
    maxDepth?: number;
  }): Promise<MintResponse>;
  /** Take it all back, including everything below it. */
  revoke(node: string): Promise<RevokeResponse>;
  balances(): Promise<BalancesResponse>;
  /**
   * A voucher for one tab call, reserved against this agent's budget.
   *
   * Uses the `resourceUrl` this connection was opened with, which must be a
   * gate the authority keeps a tab with.
   */
  voucher(quote: TabQuote): Promise<{ voucher: SignedVoucher; reservedMinor: bigint; remainingMinor: bigint }>;
  /** Asks the authority to find out what a voucher cost and return the rest. */
  settleVoucher(nonce: string): Promise<VoucherSettleResponse>;
};

const call = async <T>(
  options: Required<Pick<ConnectOptions, 'url' | 'capability'>> & { fetch: typeof fetch },
  path: string,
  init?: { method: 'POST'; body: unknown },
): Promise<T> => {
  const base = options.url.replace(/\/+$/, '');

  let response: Response;
  try {
    response = await options.fetch(`${base}${path}`, {
      method: init?.method ?? 'GET',
      headers: {
        authorization: `Bearer ${options.capability}`,
        ...(init ? { 'content-type': 'application/json' } : {}),
      },
      ...(init ? { body: JSON.stringify(init.body) } : {}),
    });
  } catch (error) {
    /*
      Separated from a refusal on purpose. "The authority said no" and "the
      authority is not running" call for opposite responses — one is final, the
      other is worth retrying — and collapsing them into one error is how an
      agent ends up retrying a hard budget limit forever.
    */
    throw new AuthorityUnavailable(
      `could not reach the budget authority at ${base}: ${(error as Error).message}`,
    );
  }

  const text = await response.text();
  if (!response.ok) {
    let code = `http_${response.status}`;
    let detail = text.slice(0, 200);
    try {
      const parsed = JSON.parse(text) as AuthorityError;
      if (parsed?.error?.code) {
        code = parsed.error.code;
        detail = parsed.error.detail;
      }
    } catch {
      /* the body was not the shape we document; the status still is */
    }
    throw new AuthorityDenied(code, detail);
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new AuthorityUnavailable('the authority returned a body that was not JSON');
  }
};

type WhoAmI = {
  node: string;
  account: string;
  network: string;
  ceilingMinor: string | null;
  expiresAt: number | null;
};

/**
 * Opens a connection and learns what this capability is.
 *
 * Asynchronous because `payAndFetch` needs `signer.accountId` *before* it will
 * sign anything — that is the self-payment check — and a delegated signer does
 * not know its own payer until it asks. One round trip at startup buys a signer
 * that is honest about who is paying.
 */
export const connectAuthority = async (options: ConnectOptions): Promise<Connection> => {
  const transport = {
    url: options.url,
    capability: options.capability,
    fetch: options.fetch ?? fetch,
  };

  const who = await call<WhoAmI>(transport, '/whoami');
  let remaining: bigint | null = null;

  const signer: PaymentSigner = {
    network: who.network,
    accountId: who.account,
    async createPayload(x402Version: number, requirements: PaymentRequirements) {
      const signed = await call<SignResponse>(transport, '/sign', {
        method: 'POST',
        body: {
          x402Version,
          requirements,
          ...(options.resourceUrl ? { resourceUrl: options.resourceUrl } : {}),
        },
      });
      remaining = BigInt(signed.remainingMinor);
      if (!signed.payload || typeof signed.payload !== 'object') {
        throw new PaymentRefused('bad_quote', 'the authority returned no payload');
      }
      return signed.payload;
    },
  };

  return {
    node: who.node,
    account: who.account,
    network: who.network,
    ceilingMinor: who.ceilingMinor === null ? null : BigInt(who.ceilingMinor),
    expiresAt: who.expiresAt,
    signer,
    remainingMinor: () => remaining,

    mint: (params) =>
      call<MintResponse>(transport, '/mint', {
        method: 'POST',
        body: {
          child: params.child,
          amountMinor: params.amountMinor.toString(),
          expiresAt: params.expiresAt,
          ...(params.ceilingMinor === undefined
            ? {}
            : { ceilingMinor: params.ceilingMinor.toString() }),
          ...(params.allowHosts === undefined ? {} : { allowHosts: params.allowHosts }),
          ...(params.maxDepth === undefined ? {} : { maxDepth: params.maxDepth }),
        },
      }),

    revoke: (node) =>
      call<RevokeResponse>(transport, '/revoke', { method: 'POST', body: { node } }),

    balances: () => call<BalancesResponse>(transport, '/balances'),

    voucher: async (quote) => {
      const issued = await call<VoucherResponse>(transport, '/voucher', {
        method: 'POST',
        body: {
          quote: { network: quote.network, payTo: quote.payTo, reserveMinor: quote.reserveMinor.toString() },
          resourceUrl: options.resourceUrl ?? '',
        },
      });
      remaining = BigInt(issued.remainingMinor);
      return {
        voucher: issued.voucher,
        reservedMinor: BigInt(issued.reservedMinor),
        remainingMinor: remaining,
      };
    },

    settleVoucher: async (nonce) => {
      const settled = await call<VoucherSettleResponse>(transport, '/voucher/settle', {
        method: 'POST',
        body: { nonce },
      });
      if (settled.remainingMinor !== null) remaining = BigInt(settled.remainingMinor);
      return settled;
    },
  };
};
