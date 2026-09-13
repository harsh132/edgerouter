/**
 * What a call costs, in USD minor units — millionths of a dollar, which is one
 * USDC base unit.
 *
 * Two prices per model, because the gate sells two ways:
 *
 *   per call   an x402 `exact` payment has to name its price before the work
 *              happens, so it pays `flatMinor` — a blunt number that overquotes
 *              most calls and eats the variance on the rest
 *   from a tab a voucher names only a ceiling, `reserveMinor`, and the tab is
 *              charged what the call actually cost once the upstream says
 *
 * The tab is the honest one. It is also the only one available where there is
 * somewhere to keep a balance, which is Circle's Gateway on Arc.
 *
 * ## Three models, all cheap
 *
 * Deliberately short. Every call here is paid in testnet USDC that somebody got
 * from a faucet, so the useful models are the ones that do tool calling well
 * for fractions of a cent — not a menu. All three support tools on OpenRouter.
 * Prices are OpenRouter's list prices, per million tokens, as of 2026-09-13.
 */

export type Model = {
  id: string;
  /** USD minor units per million prompt tokens. $0.05/M is 50_000. */
  inputPerMillion: bigint;
  /** USD minor units per million completion tokens, reasoning included. */
  outputPerMillion: bigint;
  /** What one call costs when it has to be priced up front. */
  flatMinor: bigint;
  /**
   * The most a tab call may take.
   *
   * Sized to cover a long prompt and a full completion with room to spare —
   * 128k tokens in and 4k out is well under a cent on all three. A call that
   * somehow costs more is charged this and the gate absorbs the rest, because
   * the voucher is what the payer agreed to and nothing past it was.
   */
  reserveMinor: bigint;
};

export const MODELS: readonly Model[] = [
  {
    id: 'deepseek/deepseek-v4-flash',
    inputPerMillion: 50_000n,
    outputPerMillion: 100_000n,
    flatMinor: 1_000n,
    reserveMinor: 10_000n,
  },
  {
    id: 'openai/gpt-oss-120b',
    inputPerMillion: 37_000n,
    outputPerMillion: 170_000n,
    flatMinor: 1_000n,
    reserveMinor: 10_000n,
  },
  {
    id: 'qwen/qwen3.7-flash',
    inputPerMillion: 30_000n,
    outputPerMillion: 130_000n,
    flatMinor: 1_000n,
    reserveMinor: 10_000n,
  },
];

const BY_ID = new Map(MODELS.map((model) => [model.id, model]));

/**
 * Returns null for an unknown model rather than a default.
 *
 * A default would mean quoting a number for something we cannot actually serve,
 * and the user would have paid before finding out.
 */
export const modelFor = (id: string): Model | null => BY_ID.get(id) ?? null;

/** The per-call price, for the x402 `exact` route. */
export const priceFor = (id: string): bigint | null => modelFor(id)?.flatMinor ?? null;

/** What OpenRouter reports about one call. Every field optional; none trusted to exist. */
export type Usage = {
  prompt_tokens?: unknown;
  completion_tokens?: unknown;
  /** USD, as OpenRouter bills it. Includes reasoning and cache effects the token counts miss. */
  cost?: unknown;
};

const count = (value: unknown): bigint =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? BigInt(Math.ceil(value)) : 0n;

/**
 * What a tab call is charged, from the usage the upstream reported.
 *
 * OpenRouter's own `cost` first, because it is what the call actually cost us —
 * reasoning tokens, cache discounts and provider routing are all already in it,
 * and a token table would have to reinvent each of them and get one wrong. The
 * token counts are the fallback for an upstream that does not report cost.
 *
 * Rounded up to a whole minor unit and never below one: a call that was served
 * is not free, and a charge of zero reads in a receipt exactly like a call that
 * was never metered. Capped at the reserve, for the reason given on it.
 *
 * No usage at all — a stream cut off before its last chunk — charges the
 * reserve. Nothing says what the call cost, and the voucher already said what
 * the payer was willing to be charged without being told.
 */
export const chargeFor = (model: Model, usage: Usage | null): bigint => {
  if (!usage) return model.reserveMinor;

  let minor: bigint;
  if (typeof usage.cost === 'number' && Number.isFinite(usage.cost) && usage.cost >= 0) {
    /*
      Through an integer before rounding up. `0.000123 * 1e6` is
      122.99999999999999 on one machine and 123.00000000000001 on the next, and
      `Math.ceil` turns the second into a charge of 124 — overbilling by a unit
      for nothing but float noise. Rounding to a millionth of a minor unit
      first removes the noise; the ceiling then applies only to real fractions.
    */
    const microMinor = BigInt(Math.round(usage.cost * 1_000_000_000_000));
    minor = (microMinor + 999_999n) / 1_000_000n;
  } else {
    const prompt = count(usage.prompt_tokens);
    const completion = count(usage.completion_tokens);
    if (prompt === 0n && completion === 0n) return model.reserveMinor;
    const scaled = prompt * model.inputPerMillion + completion * model.outputPerMillion;
    minor = (scaled + 999_999n) / 1_000_000n;
  }

  if (minor < 1n) minor = 1n;
  return minor > model.reserveMinor ? model.reserveMinor : minor;
};
