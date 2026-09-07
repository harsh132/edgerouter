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
  stream?: boolean;
  /**
   * Asks for a final usage frame.
   *
   * Not optional in practice: a streaming response otherwise reports no token
   * counts at all, and the harness uses them for context accounting. OpenAI and
   * every compatible provider gate it behind this flag because it costs an
   * extra frame.
   */
  stream_options?: { include_usage: boolean };
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
export const toRequest = (options: GenerateOptions, stream = false): OpenAiRequest => {
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
    ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
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
 * The buffered path, kept for a gate that collects its upstream. Each block is
 * emitted whole: start, one delta, end. The
 * harness contract does not require deltas to be small, only ordered — and the
 * streaming path is `streamToChunks`, below.
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

/* ---------------------------------------------------------- streaming side */

/** One `choices[0].delta` frame from a streaming chat completion. */
export type OpenAiDelta = {
  content?: string | null;
  /** OpenRouter's name for chain-of-thought text. DeepSeek uses the other. */
  reasoning?: string | null;
  reasoning_content?: string | null;
  tool_calls?: Array<{
    index: number;
    id?: string;
    function?: { name?: string; arguments?: string };
  }>;
};

export type OpenAiChunk = {
  choices?: Array<{ delta?: OpenAiDelta; finish_reason?: string | null }>;
  usage?: OpenAiResponse['usage'];
};

/**
 * Splits an SSE byte stream into its `data:` payloads.
 *
 * Written out rather than taken from a library because the failure it must
 * avoid is specific and silent: a frame split across two network reads. Chunk
 * boundaries have nothing to do with event boundaries, so the tail of a read is
 * held until a blank line proves the event is complete. Splitting per chunk
 * instead appears to work for short answers and truncates long ones.
 */
export const sseFrames = async function* (
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (signal?.aborted) return;

      buffer += decoder.decode(value, { stream: true });

      // Events end at a blank line. Both line endings appear in the wild.
      let split: number;
      while ((split = buffer.search(/\r?\n\r?\n/)) !== -1) {
        const event = buffer.slice(0, split);
        buffer = buffer.slice(split + (buffer[split] === '\r' ? 4 : 2));

        for (const line of event.split(/\r?\n/)) {
          if (!line.startsWith('data:')) continue; // comments, ids, retry hints
          const data = line.slice(5).trim();
          if (data.length > 0) yield data;
        }
      }
    }
  } finally {
    // Releasing matters on an abort: an unreleased reader keeps the connection
    // and the request alive after the caller has stopped listening.
    reader.releaseLock();
  }
};

/**
 * Turns streaming frames into harness chunks.
 *
 * The contract this has to keep, and each clause is a real failure mode:
 *
 *   - a block emits `block-start` once, before its first delta
 *   - every delta of one block carries the same index, allocated in first-seen
 *     order — not the provider's index, which is per tool call and starts again
 *     at zero while a text block is already open
 *   - `block-end` carries the block *accumulated*, so text and tool arguments
 *     are gathered here even though they were forwarded as they arrived
 *   - `usage` comes before `finish`, and nothing comes after `finish`
 *
 * Tool-call `arguments` stay raw JSON strings and are concatenated, never
 * parsed. Providers split them mid-token; a parse would fail on the fragment,
 * and a parse-then-restringify would change the bytes the model produced.
 */
export const streamToChunks = async function* (
  frames: AsyncIterable<string>,
): AsyncGenerator<StreamChunk> {
  let nextIndex = 0;

  let textIndex: number | null = null;
  let text = '';
  let reasoningIndex: number | null = null;
  let reasoning = '';

  type Call = { index: number; id: string; name: string; args: string };
  const calls = new Map<number, Call>();

  let usage: TokenUsage | undefined;
  let finish: string | undefined;

  /*
    A text block is closed before a tool call opens, and reasoning before text,
    because the contract allows one open block at a time. Providers interleave
    reasoning and content in adjacent frames, so the switch has to be handled
    rather than assumed away.
  */
  const closeText = function* (): Generator<StreamChunk> {
    if (textIndex === null) return;
    yield { type: 'block-end', index: textIndex, block: { type: 'text', text } };
    textIndex = null;
    text = '';
  };
  const closeReasoning = function* (): Generator<StreamChunk> {
    if (reasoningIndex === null) return;
    yield {
      type: 'block-end',
      index: reasoningIndex,
      block: { type: 'reasoning', text: reasoning } as ContentBlock,
    };
    reasoningIndex = null;
    reasoning = '';
  };

  for await (const data of frames) {
    // The terminator is a literal, not JSON. Parsing it throws.
    if (data === '[DONE]') break;

    let frame: OpenAiChunk;
    try {
      frame = JSON.parse(data) as OpenAiChunk;
    } catch {
      // A frame we cannot read is skipped rather than fatal. The alternative is
      // discarding an answer the caller has already paid for over one bad line.
      continue;
    }

    if (frame.usage) usage = toUsage(frame.usage) ?? usage;

    const choice = frame.choices?.[0];
    if (choice?.finish_reason) finish = choice.finish_reason;

    const delta = choice?.delta;
    if (!delta) continue;

    const thinking = delta.reasoning ?? delta.reasoning_content;
    if (typeof thinking === 'string' && thinking.length > 0) {
      yield* closeText();
      if (reasoningIndex === null) {
        reasoningIndex = nextIndex++;
        yield { type: 'block-start', index: reasoningIndex, blockType: 'reasoning' };
      }
      reasoning += thinking;
      yield { type: 'reasoning-delta', index: reasoningIndex, text: thinking } as StreamChunk;
    }

    if (typeof delta.content === 'string' && delta.content.length > 0) {
      yield* closeReasoning();
      if (textIndex === null) {
        textIndex = nextIndex++;
        yield { type: 'block-start', index: textIndex, blockType: 'text' };
      }
      text += delta.content;
      yield { type: 'text-delta', index: textIndex, text: delta.content };
    }

    for (const part of delta.tool_calls ?? []) {
      yield* closeReasoning();
      yield* closeText();

      let call = calls.get(part.index);
      if (!call) {
        call = { index: nextIndex++, id: part.id ?? '', name: '', args: '' };
        calls.set(part.index, call);
        yield { type: 'block-start', index: call.index, blockType: 'tool-call' };
      }
      // The id and name arrive in the first frame of a call, the arguments over
      // many. Each field is only overwritten by something non-empty.
      if (part.id) call.id = part.id;
      if (part.function?.name) call.name = part.function.name;

      const args = part.function?.arguments ?? '';
      call.args += args;
      yield {
        type: 'tool-call-delta',
        index: call.index,
        id: ToolCallId(call.id),
        ...(call.name ? { name: call.name } : {}),
        argumentsDelta: args,
      };
    }
  }

  yield* closeReasoning();
  yield* closeText();

  for (const call of calls.values()) {
    yield {
      type: 'block-end',
      index: call.index,
      block: {
        type: 'tool-call',
        id: ToolCallId(call.id),
        name: call.name,
        arguments: call.args,
      },
    };
  }

  if (usage) yield { type: 'usage', usage };
  yield { type: 'finish', reason: toFinishReason(finish) };
};
