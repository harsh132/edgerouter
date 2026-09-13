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
import {
  payAndFetch,
  payFromTab,
  AuthorityDenied,
  PaymentRefused,
  type Connection,
  type PaymentSigner,
  type TabReceipt,
  type TabShortfall,
  type TabTerms,
} from '../../../packages/sdk/src/index';

export type Spend = {
  /**
   * Smallest units this call cost. Zero for anything the gate served free.
   *
   * For a tab call this is the voucher's ceiling, which is what the authority
   * reserved — provisional until the call settles.
   */
  costMinor: bigint;
  ms: number;
};

/** What a tab call turned out to cost, once the gate has said. */
export type Settled = { chargedMinor: bigint; releasedMinor: bigint };

/** Paying from the gate's tab instead of per call. */
export type TabRoute = {
  terms: TabTerms;
  /** Read per call, for the same reason the signer is: a raised budget re-mints it. */
  connection: () => Connection;
  topUp: (shortfall: TabShortfall) => Promise<boolean>;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/*
  When to ask the authority what a voucher cost, after the answer has been read.
  The first attempt is immediate and nearly always enough: the gate writes the
  receipt only after the charge is committed. The rest cover a stream that was
  cut before its receipt, out to past the voucher's expiry and grace — when the
  authority can decide it even if the gate never saw it.
*/
const SETTLE_SCHEDULE_MS = [0, 2_000, 10_000, 60_000, 5 * 60_000, 16 * 60_000];

/**
 * Settles a voucher in the background and corrects the ledger when it does.
 *
 * Waits for the receipt, then asks — never trusting the receipt itself. The
 * authority asks the gate, and it is the authority's answer that moves budget.
 */
const settleLater = async (
  connection: Connection,
  nonce: string,
  receipt: Promise<TabReceipt | null> | null,
  correct: ((settled: Settled) => void) | void,
): Promise<void> => {
  if (receipt) await Promise.race([receipt, sleep(180_000)]);
  for (const wait of SETTLE_SCHEDULE_MS) {
    if (wait) await sleep(wait);
    try {
      const settled = await connection.settleVoucher(nonce);
      if (settled.status === 'settled') {
        correct?.({ chargedMinor: BigInt(settled.chargedMinor), releasedMinor: BigInt(settled.releasedMinor) });
        return;
      }
    } catch (error) {
      /*
        The authority no longer knows this voucher — it was rebuilt, and the
        tree the reservation lived in went with it. Nothing is left to correct
        against, so there is nothing more to ask.
      */
      if (error instanceof AuthorityDenied) return;
    }
  }
};

export class BudgetExhausted extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'BudgetExhausted';
  }
}

export const payingFetch = (params: {
  /**
   * Resolved per call, not captured once.
   *
   * A budget raised mid-task re-mints the capability, and the old one is
   * withdrawn from the tree as it goes — so a fetch holding the signer it was
   * built with would keep presenting a capability that no longer names
   * anything, and the approval that was meant to let the agent continue would
   * be the thing that stopped it. Asking for the current signer each time costs
   * a map lookup.
   */
  signer: () => PaymentSigner;
  network: string;
  /** The most any single call may cost. A guard against a mispriced quote. */
  maxAmountMinor: () => bigint;
  /**
   * What the agent has left, which is not always the same number.
   *
   * The per-call ceiling is normally a tenth of the budget and the remainder is
   * whatever is unspent — but near the end they converge, and the two cases the
   * cap can refuse mean opposite things. "This one call is priced absurdly" is a
   * problem with the quote; "this call costs more than everything you have
   * left" is simply being broke. Without this number they are the same refusal.
   */
  remainingMinor: () => bigint;
  /**
   * Records a call's cost when it is made.
   *
   * May return a correction, called once a tab call's real price is known. A
   * per-call payment never calls it — its price was final when it was paid.
   */
  onSpend: (spend: Spend) => ((settled: Settled) => void) | void;
  /** Present when the gate keeps a tab. Absent means every call pays for itself. */
  tab?: TabRoute;
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
  /**
   * Last chance to find more money, at the moment it runs out.
   *
   * Asking has to happen here rather than as something the agent chooses to do,
   * because the refusal arrives where the agent has no turn: a payment is
   * declined between one step and the next, the loop dies, and the model is
   * never asked what it would like to do about it. Watched happening —
   * an agent told to check its budget and ask first spent its one remaining
   * call listing a directory and was refused on the next, having never reached
   * a point where calling a tool was possible.
   *
   * Returns whether more budget arrived. True means retry; the capability has
   * been re-minted by then, and the signer is read fresh per call for exactly
   * this reason.
   */
  onExhausted?: (shortfall: { remainingMinor: bigint }) => Promise<boolean>;
}): typeof globalThis.fetch => {
  return async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const started = Date.now();

    /*
      One retry, and only after a person has granted more. Retrying a refusal
      for any other reason is pointless — the budget will not have refilled
      between attempts — and retrying twice after an approval would mean a
      single call able to ask for money repeatedly.
    */
    let retried = false;

    const attempt = async (): Promise<Response> => {
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

      const requestInit = {
        ...(init?.method ? { method: init.method } : {}),
        ...(init?.headers ? { headers: init.headers as Record<string, string> } : {}),
        ...(typeof body === 'string' ? { body } : {}),
      };

      if (params.tab) {
        const route = params.tab;
        const connection = route.connection();
        const result = await payFromTab(url, {
          terms: route.terms,
          init: requestInit,
          voucherFor: async (quote) => {
            /*
              The same sanity bound a per-call quote is held to, applied to the
              ceiling — because the ceiling is what this call can cost. Thrown
              as the refusal `payAndFetch` would have raised, so the branch
              below treats a broke agent identically on either route.
            */
            const cap = params.maxAmountMinor();
            if (quote.reserveMinor > cap) {
              throw new PaymentRefused(
                'over_max_amount',
                `this call reserves ${quote.reserveMinor} but the cap for one call is ${cap}`,
              );
            }
            return (await connection.voucher(quote)).voucher;
          },
          topUp: route.topUp,
        });

        const correct = params.onSpend({ costMinor: result.reservedMinor, ms: Date.now() - started });

        if (result.response.status === 402) {
          /*
            The gate refused the voucher before reserving anything, so nothing
            was charged — but the authority reserved it, and gets it back only
            once the voucher can no longer be spent. The background settle
            waits that out and corrects the ledger when it does.
          */
          void settleLater(connection, result.nonce, null, correct);
          const detail = (await result.response
            .clone()
            .json()
            .catch(() => null)) as { error?: { code?: string; detail?: string } } | null;
          throw new BudgetExhausted(
            detail?.error?.code === 'tab_insufficient'
              ? 'the crew wallet has nothing left to top up the gate tab with'
              : `the gate refused this call's voucher: ${detail?.error?.detail ?? detail?.error?.code ?? 'no reason given'}`,
          );
        }

        void settleLater(connection, result.nonce, result.receipt, correct);
        return result.response;
      }

      const result = await payAndFetch(url, {
        signer: params.signer(),
        network: params.network,
        maxAmount: params.maxAmountMinor(),
        init: requestInit,
      });

      params.onSpend({
        costMinor: result.quote ? BigInt(result.quote.amount) : 0n,
        ms: Date.now() - started,
      });
      return result.response;
    } catch (error) {
      /*
        Already translated — a tab call the gate refused. Reported and thrown
        as it is; asking for more budget would not help, because the budget is
        not what ran out.
      */
      if (error instanceof BudgetExhausted) {
        params.onRefusal?.(error);
        throw error;
      }

      /*
        Translated rather than passed through. pi will retry a fetch that
        throws, and retrying a refusal from the authority is pointless — the
        budget will not have refilled between attempts, and each retry is
        another quote the gate has to price. Raised as its own type so the
        runtime can stop the agent and say why, in words about money — and
        reported through `onRefusal`, because the type does not survive the
        trip through pi.
      */
      const exhausted = async (refusal: BudgetExhausted): Promise<Response> => {
        if (params.onExhausted && !retried) {
          retried = true;
          if (await params.onExhausted({ remainingMinor: params.remainingMinor() })) return attempt();
        }
        params.onRefusal?.(refusal);
        throw refusal;
      };

      if (error instanceof AuthorityDenied) {
        return exhausted(new BudgetExhausted(error.message));
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
        const remaining = params.remainingMinor();
        const broke = params.maxAmountMinor() >= remaining;
        const refusal = new BudgetExhausted(
          broke
            ? `the next call costs more than the ${remaining} it has left`
            : `a single call was quoted above this agent's per-call cap: ${error.message}`,
        );
        /*
          Only being broke is worth asking about. A quote above the per-call cap
          leaves the agent with money and means the price was wrong, and raising
          the budget over it would turn a guard against mispricing into a way of
          paying whatever was asked.
        */
        if (broke) return exhausted(refusal);
        params.onRefusal?.(refusal);
        throw refusal;
      }

      throw error;
    }
    };

    return attempt();
  };
};
