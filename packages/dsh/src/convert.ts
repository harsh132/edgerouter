/**
 * Translation between the harness vocabulary and OpenAI chat-completions.
 *
 * Kept separate from the adapter and free of I/O, because this is where the
 * subtle mistakes live and they are only findable by testing the functions
 * directly. The adapter does transport; this does meaning.
 *
 * Two conventions from the harness contract are load-bearing here and easy to
 * lose:
 *
 *   - tool-call `arguments` are RAW JSON STRINGS end to end. OpenAI hands back
 *     a string, the harness wants a string, and any well-meaning parse/restringify
 *     in between changes the bytes the model produced.
 *   - block `index`es are allocated in first-seen order and reused for every
 *     delta of the same block.
 */
import { ToolCallId, LlmError } from '@deepseek-ai/dsh-llm';
import type {
  ContentBlock,
  FinishReason,
  GenerateOptions,
  Message,
  StreamChunk,
  TokenUsage,
  ToolSchema,
} from '@deepseek-ai/dsh-llm';

/* ------------------------------------------------------------ request side */

export type OpenAiMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: OpenAiToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export type OpenAiToolCall = {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
};

export type OpenAiRequest = {
  model: string;
  messages: OpenAiMessage[];
  tools?: Array<{ type: 'function'; function: ToolSchema }>;
  temperature?: number;
  max_tokens?: number;
  stop?: string[];
};

/**
 * Block types this adapter can put on the wire.
 *
 * A set rather than a union check because the vocabulary is merge-extensible:
 * the harness declares `image` and `file` today and plugins may add more, so
 * anything absent here is refused by name instead of matched against a list
 * that would need editing every time the harness grows one.
 */
const HANDLED = new Set<string>(['text', 'reasoning', 'tool-call', 'tool-result']);

/** Text of every block that renders as text, in order. */
const textOf = (blocks: readonly ContentBlock[]): string =>
  blocks
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('');

/**
 * Converts one harness message.
 *
 * Returns a list because a single assistant turn carrying tool calls, or a user
 * turn carrying several tool results, is more than one message on the wire.
 */
export const convertMessage = (message: Message): OpenAiMessage[] => {
  const results = message.content.filter(
    (block): block is Extract<ContentBlock, { type: 'tool-result' }> => block.type === 'tool-result',
  );

  /*
    A tool result arrives with role 'user' but must go out as role 'tool',
    correlated by id. Handled first because such a message carries nothing else.
  */
  if (results.length > 0) {
    return results.map((block) => ({
      role: 'tool' as const,
      tool_call_id: block.toolCallId,
      content: textOf(block.content),
    }));
  }

  /*
    Anything this adapter does not understand is refused rather than silently
    dropped. Images and files exist in this harness version, and this provider
    is text-only: dropping one produces a model answering confidently about
    something it never saw, which is worse than a request that fails naming
    the reason.
  */
  const unsupported = message.content.find((block) => !HANDLED.has(block.type));
  if (unsupported) {
    throw new LlmError(
      `edgerouter: ${unsupported.type} content is not supported yet; this provider is text-only`,
      'UNSUPPORTED_OPTION',
    );
  }

  if (message.role === 'assistant') {
    const calls = message.content.filter(
      (block): block is Extract<ContentBlock, { type: 'tool-call' }> => block.type === 'tool-call',
    );
    const text = textOf(message.content);
    return [
      {
        role: 'assistant',
        content: text.length > 0 ? text : null,
        ...(calls.length > 0
          ? {
              tool_calls: calls.map((call) => ({
                id: call.id,
                type: 'function' as const,
                // Already a raw JSON string. Passed through untouched.
                function: { name: call.name, arguments: call.arguments },
              })),
            }
          : {}),
      },
    ];
  }

  if (message.role === 'system') return [{ role: 'system', content: textOf(message.content) }];
  return [{ role: 'user', content: textOf(message.content) }];
};

/** Builds the request body. */
export const toRequest = (options: GenerateOptions): OpenAiRequest => {
  const messages: OpenAiMessage[] = [];
  if (options.system) messages.push({ role: 'system', content: options.system });
  for (const message of options.messages) messages.push(...convertMessage(message));

  return {
    model: options.model,
    messages,
    ...(options.tools && options.tools.length > 0
      ? { tools: options.tools.map((tool) => ({ type: 'function' as const, function: tool })) }
      : {}),
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
    ...(options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens }),
    ...(options.stop && options.stop.length > 0 ? { stop: options.stop } : {}),
  };
};

/* ----------------------------------------------------------- response side */

export type OpenAiResponse = {
  choices?: Array<{
    message?: { content?: string | null; tool_calls?: OpenAiToolCall[] };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
  };
};

/**
 * OpenAI's `prompt_tokens` includes cache hits; the harness wants them
 * disjoint, so cached reads are subtracted back out of the input count.
 */
export const toUsage = (usage: OpenAiResponse['usage']): TokenUsage | null => {
  if (!usage) return null;
  const prompt = usage.prompt_tokens ?? 0;
  const cached = usage.prompt_tokens_details?.cached_tokens ?? 0;
  const reasoning = usage.completion_tokens_details?.reasoning_tokens;

  return {
    inputTokens: Math.max(0, prompt - cached),
    outputTokens: usage.completion_tokens ?? 0,
    ...(usage.total_tokens === undefined ? {} : { totalTokens: usage.total_tokens }),
    ...(cached > 0 ? { cacheReadTokens: cached } : {}),
    ...(reasoning === undefined ? {} : { reasoningTokens: reasoning }),
  };
};

/**
 * Maps a finish reason.
 *
 * An unrecognised value becomes `stop` rather than an error: the response was
 * served and paid for, and refusing to deliver it because a provider invented a
 * new reason string would throw away work the user already bought.
 */
export const toFinishReason = (reason: string | undefined): FinishReason => {
  switch (reason) {
    case 'tool_calls':
    case 'function_call':
      return { kind: 'tool-calls' };
    case 'length':
      return { kind: 'max-tokens' };
    default:
      return { kind: 'stop' };
  }
};

/**
 * Turns one complete response into the chunk sequence.
 *
 * Non-streaming, so each block is emitted whole: start, one delta, end. The
 * harness contract does not require deltas to be small, only ordered — and the
 * gate buffers its upstream anyway, so there is no incremental data to pass on.
 * See the note in `adapter.ts`.
 *
 * Ordering is the contract: blocks, then usage, then finish, then nothing.
 */
export const toChunks = function* (response: OpenAiResponse): Generator<StreamChunk> {
  const choice = response.choices?.[0];
  const message = choice?.message;
  let index = 0;

  const text = message?.content;
  if (typeof text === 'string' && text.length > 0) {
    yield { type: 'block-start', index, blockType: 'text' };
    yield { type: 'text-delta', index, text };
    yield { type: 'block-end', index, block: { type: 'text', text } };
    index += 1;
  }

  for (const call of message?.tool_calls ?? []) {
    const id = ToolCallId(call.id);
    const args = call.function?.arguments ?? '';
    yield { type: 'block-start', index, blockType: 'tool-call' };
    yield {
      type: 'tool-call-delta',
      index,
      id,
      name: call.function?.name,
      argumentsDelta: args,
    };
    yield {
      type: 'block-end',
      index,
      block: { type: 'tool-call', id, name: call.function?.name ?? '', arguments: args },
    };
    index += 1;
  }

  const usage = toUsage(response.usage);
  if (usage) yield { type: 'usage', usage };

  yield { type: 'finish', reason: toFinishReason(choice?.finish_reason) };
};
