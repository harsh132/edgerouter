/**
 * What a call costs, in the smallest unit of the payment asset.
 *
 * Flat per call rather than per token, and that is a real limitation stated
 * plainly: x402 quotes a price *before* the work happens, and token counts are
 * only known after. Charging per token would mean either quoting a ceiling and
 * refunding the difference — which needs state this service does not have — or
 * billing after the fact, which needs an account.
 *
 * So the first version overquotes slightly and eats the variance. The `upto`
 * scheme in x402 exists for exactly this and is the way out; it is deliberately
 * not in the first version, because a wrong usage-based meter is worse than a
 * blunt flat one.
 */

export type Model = {
  id: string;
  minorPerCall: bigint;
};

/** USDC has six decimals, so 1_000n is one tenth of a cent. */
export const MODELS: readonly Model[] = [
  { id: 'deepseek/deepseek-chat', minorPerCall: 1_000n },
  { id: 'deepseek/deepseek-reasoner', minorPerCall: 3_000n },
  { id: 'anthropic/claude-sonnet-4.5', minorPerCall: 10_000n },
  { id: 'openai/gpt-4o-mini', minorPerCall: 2_000n },
  { id: 'meta-llama/llama-3.3-70b-instruct', minorPerCall: 1_000n },
];

const BY_ID = new Map(MODELS.map((model) => [model.id, model]));

/**
 * Returns null for an unknown model rather than a default price.
 *
 * A default would mean quoting a number for something we cannot actually serve,
 * and the user would have paid before finding out.
 */
export const priceFor = (model: string): bigint | null => BY_ID.get(model)?.minorPerCall ?? null;
