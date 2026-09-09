/**
 * The gate, described as a model to pi.
 *
 * pi speaks to OpenAI-compatible endpoints, and the gate is one — the only
 * difference being that it answers 402 before it answers anything else. So the
 * model definition is ordinary and the *fetch* is where payment lives: pi is
 * handed a fetch that pays, and never learns that it did.
 *
 * That seam is the reason this app did not need an agent loop written for it.
 * A loop that had to know about payment would be a loop we owned forever;
 * a fetch that pays is thirty lines and works under any loop.
 */
import type { Model } from '@earendil-works/pi-ai';

/** The only field an agent picks. The rest describes the gate, not the model. */
export const MODELS = [
  'openai/gpt-4o-mini',
  'deepseek/deepseek-chat',
  'anthropic/claude-3.5-haiku',
] as const;

export const modelFor = (gate: string, id: string): Model<'openai-completions'> => ({
  id,
  name: id,
  api: 'openai-completions',
  /*
    Not a real provider id in pi's catalog, and deliberately so: nothing should
    resolve this to a hosted endpoint with an API key. The baseUrl is the whole
    address, and the key is a wallet.
  */
  provider: 'edgerouter' as Model<'openai-completions'>['provider'],
  baseUrl: new URL('/v1', gate).toString(),
  reasoning: false,
  input: ['text'],
  /*
    Zero, because pi's cost figures are dollars-per-token estimates for hosted
    providers and ours is neither estimated nor per-token — the gate quotes a
    price and we pay it. The real number is recorded per step from the receipt.
  */
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 4_096,
});
