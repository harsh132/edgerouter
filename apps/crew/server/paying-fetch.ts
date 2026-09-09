/**
 * A fetch that pays, so the agent loop does not have to know it did.
 *
 * pi takes a `fetch` for provider requests. Handing it one that settles the
 * gate's 402 turns every model call the agent makes into a purchase, made with
 * *that agent's* capability — which is what makes a spending limit real rather
 * than advisory. The agent cannot spend more than its allowance because the
 * refusal comes from the authority holding the wallet, not from anything the
 * agent agreed to.
 *
 * It is also why an agent cannot escape its budget by being clever: there is no
 * other way out of the process. It has no key, and this is its only network.
 */
import { payAndFetch, AuthorityDenied, type PaymentSigner } from '../../../packages/sdk/src/index';

export type Spend = {
  /** Smallest units this call cost. Zero for anything the gate served free. */
  costMinor: bigint;
  ms: number;
};

export class BudgetExhausted extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'BudgetExhausted';
  }
}

export const payingFetch = (params: {
  signer: PaymentSigner;
  network: string;
  /** The most any single call may cost. A guard against a mispriced quote. */
  maxAmountMinor: bigint;
  onSpend: (spend: Spend) => void;
}): typeof globalThis.fetch => {
  return async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const started = Date.now();

    try {
      /*
        The body is narrowed to a string because a payment is signed over the
        request that produced the quote, and a stream can only be read once —
        so an init carrying a ReadableStream could be quoted or paid, never
        both. pi sends JSON strings, which is the case that matters; anything
        else is refused here rather than silently paid for and then lost.
      */
      const body = init?.body;
      if (body != null && typeof body !== 'string') {
        throw new Error('the gate can only be paid for requests with a string body');
      }

      const result = await payAndFetch(url, {
        signer: params.signer,
        network: params.network,
        maxAmount: params.maxAmountMinor,
        init: {
          ...(init?.method ? { method: init.method } : {}),
          ...(init?.headers ? { headers: init.headers as Record<string, string> } : {}),
          ...(typeof body === 'string' ? { body } : {}),
        },
      });

      params.onSpend({
        costMinor: result.quote ? BigInt(result.quote.amount) : 0n,
        ms: Date.now() - started,
      });
      return result.response;
    } catch (error) {
      /*
        Translated rather than passed through. pi will retry a fetch that
        throws, and retrying a refusal from the authority is pointless — the
        budget will not have refilled between attempts, and each retry is
        another quote the gate has to price. Raised as its own type so the
        runtime can stop the agent and say why, in words about money.
      */
      if (error instanceof AuthorityDenied) throw new BudgetExhausted(error.message);
      throw error;
    }
  };
};
