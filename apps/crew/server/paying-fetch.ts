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
import { payAndFetch, AuthorityDenied, PaymentRefused, type PaymentSigner } from '../../../packages/sdk/src/index';

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
  /**
   * What the agent has left, which is not always the same number.
   *
   * The per-call ceiling is normally a tenth of the budget and the remainder is
   * whatever is unspent — but near the end they converge, and the two cases the
   * cap can refuse mean opposite things. "This one call is priced absurdly" is a
   * problem with the quote; "this call costs more than everything you have
   * left" is simply being broke. Without this number they are the same refusal.
   */
  remainingMinor: bigint;
  onSpend: (spend: Spend) => void;
  /**
   * Told when the authority refuses, because throwing is not enough.
   *
   * pi catches whatever a `fetch` throws and replaces it with a message of its
   * own — "Connection error." — so an agent that ran out of money reported a
   * network problem, and the branch that would have said so in words about
   * money never matched. The error still throws, to stop the request; this
   * says what it was, to whoever is going to have to explain it.
   */
  onRefusal?: (refusal: BudgetExhausted) => void;
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
        runtime can stop the agent and say why, in words about money — and
        reported through `onRefusal`, because the type does not survive the
        trip through pi.
      */
      if (error instanceof AuthorityDenied) {
        const refusal = new BudgetExhausted(error.message);
        params.onRefusal?.(refusal);
        throw refusal;
      }

      /*
        Running out of money usually never reaches the authority at all.

        `payAndFetch` compares the quote against the cap before it signs
        anything, so an agent whose remaining balance is smaller than one call
        is refused here — locally, with `over_max_amount` — and the authority is
        never asked. That is the ordinary way a budget ends, and it was
        arriving at the user as "Connection error." like everything else.
      */
      if (error instanceof PaymentRefused && error.reason === 'over_max_amount') {
        const broke = params.maxAmountMinor >= params.remainingMinor;
        const refusal = new BudgetExhausted(
          broke
            ? `the next call costs more than the ${params.remainingMinor} it has left`
            : `a single call was quoted above this agent's per-call cap: ${error.message}`,
        );
        params.onRefusal?.(refusal);
        throw refusal;
      }

      throw error;
    }
  };
};
