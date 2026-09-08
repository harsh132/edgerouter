/**
 * The plugin, checked without a harness and without money.
 *
 * Two things are worth checking here and nothing else is: that the translation
 * to and from OpenAI's shape is faithful, and that the adapter obeys the chunk
 * contract while spending only what it was allowed to. Both are exercised
 * against a fake gate and a signer that records instead of signing.
 *
 *   bun packages/dsh/check.ts
 */
import { LlmError } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, Message, StreamChunk } from '@deepseek-ai/dsh-llm';
import { base64, type PaymentRequirements, type PaymentSigner } from '../sdk/src/index';
import { EdgerouterAdapter } from './src/adapter';
import { resolveMaxAmount, createReporter, isWithdrawDestination } from './src/index';

const HEDERA = 'hedera:testnet';
const BASE = 'eip155:84532';
import {
  convertMessage,
  sseFrames,
  streamToChunks,
  toChunks,
  toFinishReason,
  toRequest,
  toUsage,
  type OpenAiResponse,
} from './src/convert';

let failures = 0;
const check = (condition: boolean, message: string) => {
  if (condition) console.log(`  ok    ${message}`);
  else {
    failures += 1;
    console.log(`  FAIL  ${message}`);
  }
};
const section = (name: string) => console.log(`\n${name}\n`);

const throws = async (code: string, message: string, run: () => unknown) => {
  try {
    await run();
    check(false, `${message} (nothing was thrown)`);
  } catch (error) {
    const actual = error instanceof LlmError ? error.code : `threw ${String(error)}`;
    check(actual === code, `${message} (${actual})`);
  }
};

/** A message with the identity fields the harness would have stamped. */
const message = (role: Message['role'], content: unknown[]): Message =>
  ({ id: 'm1', role, content, source: { kind: 'user' } }) as unknown as Message;

/* --------------------------------------------------------------- requests */

section('Converting requests');

check(
  JSON.stringify(convertMessage(message('user', [{ type: 'text', text: 'hi' }]))) ===
    JSON.stringify([{ role: 'user', content: 'hi' }]),
  'a user message becomes a user message',
);

check(
  convertMessage(message('user', [
    { type: 'text', text: 'a' },
    { type: 'text', text: 'b' },
  ]))[0]?.content === 'ab',
  'several text blocks concatenate in order',
);

{
  const assistant = convertMessage(
    message('assistant', [
      { type: 'text', text: 'calling' },
      { type: 'tool-call', id: 'call_1', name: 'read', arguments: '{"path":"a.ts"}' },
    ]),
  )[0] as { role: string; content: string | null; tool_calls?: unknown[] };

  check(assistant.role === 'assistant', 'an assistant message keeps its role');
  check(assistant.tool_calls?.length === 1, 'a tool call is carried');
  const call = assistant.tool_calls?.[0] as { function: { arguments: string; name: string } };
  check(
    call.function.arguments === '{"path":"a.ts"}',
    'tool arguments stay the exact JSON string the model produced',
  );
  check(call.function.name === 'read', 'the tool name is carried');
}

{
  const assistant = convertMessage(
    message('assistant', [{ type: 'tool-call', id: 'c', name: 'n', arguments: '{}' }]),
  )[0] as { content: string | null };
  check(assistant.content === null, 'an assistant turn with no text sends null, not an empty string');
}

{
  const tool = convertMessage(
    message('user', [
      { type: 'tool-result', toolCallId: 'call_1', content: [{ type: 'text', text: 'done' }] },
    ]),
  )[0] as { role: string; tool_call_id: string; content: string };
  check(tool.role === 'tool', 'a tool result becomes role tool, not role user');
  check(tool.tool_call_id === 'call_1', 'the call id correlates the result');
  check(tool.content === 'done', 'the result text is carried');
}

check(
  convertMessage(
    message('user', [
      { type: 'tool-result', toolCallId: 'a', content: [] },
      { type: 'tool-result', toolCallId: 'b', content: [] },
    ]),
  ).length === 2,
  'two results in one message become two wire messages',
);

await throws('UNSUPPORTED_OPTION', 'an unknown block type is refused, not dropped', () =>
  convertMessage(message('user', [{ type: 'image', attachment: {} }])),
);

{
  const options = {
    provider: 'edgerouter',
    model: 'deepseek/deepseek-chat',
    system: 'be brief',
    messages: [message('user', [{ type: 'text', text: 'hi' }])],
    tools: [{ name: 'read', description: 'read a file', parameters: { type: 'object' } }],
    temperature: 0.5,
    maxTokens: 100,
    stop: ['END'],
  } as unknown as GenerateOptions;

  const request = toRequest(options);
  check(request.messages[0]?.role === 'system', 'the system prompt leads the message list');
  check(request.messages.length === 2, 'the system prompt is added, not substituted');
  check(request.tools?.[0]?.type === 'function', 'tools are wrapped in the function envelope');
  check(request.max_tokens === 100, 'maxTokens becomes max_tokens');
  check(request.temperature === 0.5 && request.stop?.[0] === 'END', 'sampling options carry over');

  const bare = toRequest({ ...options, tools: [], stop: [], temperature: undefined } as never);
  check(
    !('tools' in bare) && !('stop' in bare) && !('temperature' in bare),
    'empty and absent options are omitted rather than sent as empty',
  );
}

/* -------------------------------------------------------------- responses */

section('Converting responses');

check(toUsage(undefined) === null, 'a response with no usage reports none');

{
  const usage = toUsage({
    prompt_tokens: 100,
    completion_tokens: 20,
    total_tokens: 120,
    prompt_tokens_details: { cached_tokens: 40 },
  })!;
  check(usage.inputTokens === 60, 'cached tokens are subtracted out of the input count');
  check(usage.cacheReadTokens === 40, 'cached tokens are reported separately');
  check(usage.outputTokens === 20 && usage.totalTokens === 120, 'output and total carry over');
}

check(toFinishReason('tool_calls').kind === 'tool-calls', 'tool_calls maps to tool-calls');
check(toFinishReason('length').kind === 'max-tokens', 'length maps to max-tokens');
check(toFinishReason('stop').kind === 'stop', 'stop maps to stop');
check(toFinishReason('something_new').kind === 'stop', 'an unknown reason degrades to stop');

{
  const response: OpenAiResponse = {
    choices: [
      {
        message: {
          content: 'hello',
          tool_calls: [
            { id: 'c1', type: 'function', function: { name: 'read', arguments: '{"p":1}' } },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  };

  const chunks = [...toChunks(response)];
  const types = chunks.map((chunk) => chunk.type);

  check(types.at(-1) === 'finish', 'finish is last — nothing follows it');
  check(types.at(-2) === 'usage', 'usage comes immediately before finish');
  check(types.indexOf('usage') === types.length - 2, 'usage is emitted exactly once, before finish');

  const starts = chunks.filter((c): c is Extract<StreamChunk, { type: 'block-start' }> => c.type === 'block-start');
  check(starts.length === 2, 'a text block and a tool-call block are both opened');
  check(starts[0]?.index === 0 && starts[1]?.index === 1, 'indexes are allocated in first-seen order');

  const ends = chunks.filter((c): c is Extract<StreamChunk, { type: 'block-end' }> => c.type === 'block-end');
  check(ends.length === 2, 'every opened block is closed');
  const toolBlock = ends[1]?.block as { arguments?: string };
  check(toolBlock.arguments === '{"p":1}', 'the assembled tool block keeps the raw argument string');

  const finish = chunks.at(-1) as Extract<StreamChunk, { type: 'finish' }>;
  check(finish.reason.kind === 'tool-calls', 'the finish reason survives');
}

check(
  [...toChunks({ choices: [{ message: { content: '' }, finish_reason: 'stop' }] })].every(
    (chunk) => chunk.type !== 'block-start',
  ),
  'an empty response opens no blocks',
);

/* ---------------------------------------------------------------- adapter */

section('The adapter');

const PAYER = '0.0.1001';
const RECIPIENT = '0.0.2002';

const quote = (amount: string): PaymentRequirements => ({
  scheme: 'exact',
  network: 'hedera:testnet',
  amount,
  asset: '0.0.0',
  payTo: RECIPIENT,
  maxTimeoutSeconds: 180,
  extra: { feePayer: '0.0.7162784' },
});

const recordingSigner = (): PaymentSigner & { calls: number } => ({
  network: 'hedera:testnet',
  accountId: PAYER,
  calls: 0,
  async createPayload() {
    (this as { calls: number }).calls += 1;
    return { transaction: 'ZmFrZQ==' };
  },
});

/** A gate that quotes `amount`, then serves once paid. */
const gate = (amount: string, options: { status?: number } = {}) => {
  const seen: Array<Record<string, string>> = [];
  const handler = async (_url: string | URL, init?: RequestInit): Promise<Response> => {
    const headers = { ...((init?.headers ?? {}) as Record<string, string>) };
    seen.push(headers);

    if (String(_url).endsWith('/v1/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'deepseek/deepseek-chat' }] }), {
        status: 200,
      });
    }
    if (options.status && options.status !== 200) {
      return new Response('nope', { status: options.status });
    }
    if (!headers['PAYMENT-SIGNATURE']) {
      return new Response(
        JSON.stringify({ x402Version: 2, resource: { url: 'x' }, accepts: [quote(amount)] }),
        { status: 402 },
      );
    }
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: 'paid.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 4, completion_tokens: 2 },
      }),
      {
        status: 200,
        headers: {
          'PAYMENT-RESPONSE': base64(JSON.stringify({ success: true, transaction: '0.0.1@2.3' })),
        },
      },
    );
  };
  return { handler: handler as unknown as typeof fetch, seen };
};

const request = {
  provider: 'edgerouter',
  model: 'deepseek/deepseek-chat',
  messages: [message('user', [{ type: 'text', text: 'hi' }])],
} as unknown as GenerateOptions;

const adapterWith = (
  server: ReturnType<typeof gate>,
  signer: PaymentSigner | undefined,
  maxAmount: bigint,
  paid: unknown[] = [],
) =>
  new EdgerouterAdapter({
    connection: () => ({
      baseURL: 'https://gate.test',
      capability: 'er_test',
      maxAmount,
      network: 'hedera:testnet',
      defaultContextWindow: 128_000,
    }),
    signer: () => signer,
    onPaid: (p) => paid.push(p),
    fetch: server.handler,
  });

{
  const signer = recordingSigner();
  const server = gate('1000');
  const paid: any[] = [];
  const chunks: StreamChunk[] = [];
  for await (const chunk of adapterWith(server, signer, 10_000n, paid).stream(request)) {
    chunks.push(chunk);
  }

  check(chunks.at(-1)?.type === 'finish', 'a paid call ends in finish');
  check(signer.calls === 1, 'the signer was asked exactly once');
  check(server.seen.length === 2, 'a 402 became two requests');
  check(
    server.seen[1]?.authorization === 'Bearer er_test',
    'the capability rides both requests, not just the first',
  );
  check(
    typeof server.seen[0]?.['user-agent'] === 'string',
    'attribution headers are sent, as the adapter contract requires',
  );
  check(paid.length === 1 && paid[0].amount === 1000n, 'the cost is reported through onPaid');
  check(paid[0].transaction === '0.0.1@2.3', 'the settlement transaction id is reported');
}

{
  const signer = recordingSigner();
  const server = gate('999999');
  const paid: unknown[] = [];
  await throws('PAYMENT_OVER_CAP', 'a quote above the cap fails with a nameable code', async () => {
    for await (const _ of adapterWith(server, signer, 1_000n, paid).stream(request)) void _;
  });
  check(signer.calls === 0, 'nothing was signed once the cap was exceeded');
  check(paid.length === 0, 'nothing was reported as paid');
}

await throws('MISSING_CREDENTIAL', 'a missing signer is named, not a null dereference', async () => {
  for await (const _ of adapterWith(gate('1000'), undefined, 10_000n).stream(request)) void _;
});

await throws('AUTH', 'a 401 from the gate is an auth failure', async () => {
  const signer = recordingSigner();
  for await (const _ of adapterWith(gate('1000', { status: 401 }), signer, 10_000n).stream(request)) {
    void _;
  }
});

{
  const models = await adapterWith(gate('1000'), recordingSigner(), 10_000n).listModels('edgerouter');
  check(models.length === 1, 'the model catalog is read from the gate');
  check(models[0]?.provider === 'edgerouter', 'catalog entries carry the provider route');
}

{
  const broken = (async () => {
    throw new Error('connection refused');
  }) as unknown as typeof fetch;
  const adapter = new EdgerouterAdapter({
    connection: () => ({
      baseURL: 'https://gate.test',
      capability: 'x',
      maxAmount: 1n,
      defaultContextWindow: 1,
    }),
    signer: () => recordingSigner(),
    fetch: broken,
  });
  check(
    (await adapter.listModels('edgerouter')).length === 0,
    'an unreachable catalog returns nothing rather than throwing',
  );
}

/* ------------------------------------------------------------------ config */

section('Configuration');

check(resolveMaxAmount('500', HEDERA) === 500n, 'a numeric cap parses');
check(resolveMaxAmount('500', BASE) === 500n, 'and means the same number on any network');

/*
  The default is per network because the smallest unit is not one unit. The same
  literal is one hbar and one hundred USDC, so a single default is correct on at
  most one chain and expensive on the others.
*/
check(resolveMaxAmount(undefined, HEDERA) === 100_000_000n, 'unset on Hedera is one HBAR');
check(resolveMaxAmount(undefined, BASE) === 100_000n, 'unset on an EVM chain is 0.1 USDC');
check(
  resolveMaxAmount(undefined, HEDERA) !== resolveMaxAmount(undefined, BASE),
  'the two defaults are different numbers, which is the entire point',
);
check(resolveMaxAmount('  ', BASE) === 100_000n, 'a blank cap is unset, not zero');
/*
  An empty string is deliberately not in this list. It used to be refused, and
  now means "unset" — because a settings form with a cleared field is a user
  asking for the default, not a user writing a malformed number.
*/
for (const bad of ['0', '-1', '1.5', 'lots']) {
  let refused = false;
  try {
    resolveMaxAmount(bad, HEDERA);
  } catch {
    refused = true;
  }
  check(refused, `a cap of "${bad}" is refused rather than defaulted`);
}


/* ------------------------------------------------------------------ stream */

section('Streaming');

/** Feeds bytes in caller-chosen pieces, so split frames can be forced. */
const streamOf = (pieces: readonly string[]): ReadableStream<Uint8Array> => {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const piece of pieces) controller.enqueue(encoder.encode(piece));
      controller.close();
    },
  });
};

const frame = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
const textFrame = (content: string) => frame({ choices: [{ delta: { content } }] });

const collect = async (pieces: readonly string[]): Promise<StreamChunk[]> => {
  const out: StreamChunk[] = [];
  for await (const chunk of streamToChunks(sseFrames(streamOf(pieces)))) out.push(chunk);
  return out;
};

/** The same options the request checks above use. */
const GENERATE = {
  provider: 'edgerouter',
  model: 'deepseek/deepseek-chat',
  messages: [message('user', [{ type: 'text', text: 'hi' }])],
} as unknown as GenerateOptions;

check(
  JSON.stringify(toRequest(GENERATE, true)).includes('"stream":true'),
  'the request asks the gate to stream',
);
check(
  JSON.stringify(toRequest(GENERATE, true)).includes('"include_usage":true'),
  'and asks for a usage frame, which streaming otherwise omits',
);
check(!JSON.stringify(toRequest(GENERATE)).includes('"stream"'), 'buffered requests say nothing');

const simple = await collect([
  textFrame('Hello'),
  textFrame(' world'),
  frame({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2 } }),
  'data: [DONE]\n\n',
]);
const types = simple.map((chunk) => chunk.type);
check(types[0] === 'block-start', 'a block opens before its first delta');
check(
  types.filter((type) => type === 'text-delta').length === 2,
  'each delta is forwarded as it arrives, not merged',
);
check(types.at(-1) === 'finish', 'the stream ends in finish');
check(types.at(-2) === 'usage', 'with usage immediately before it');
check(types.filter((type) => type === 'finish').length === 1, 'exactly one finish');
check(
  types.indexOf('block-end') < types.indexOf('usage'),
  'blocks are closed before usage is reported',
);

const ended = simple.find((chunk) => chunk.type === 'block-end') as
  | Extract<StreamChunk, { type: 'block-end' }>
  | undefined;
check(
  ended?.block.type === 'text' && ended.block.text === 'Hello world',
  'block-end carries the whole accumulated text, not the last delta',
);

/*
  The bug this parser exists to avoid. Network reads have nothing to do with
  event boundaries, so a frame arriving in two pieces must still be one event.
  Splitting per read looks correct on short answers and truncates long ones.
*/
const whole = frame({ choices: [{ delta: { content: 'indivisible' } }] });
for (const at of [5, 12, whole.length - 3]) {
  const split = await collect([whole.slice(0, at), whole.slice(at), 'data: [DONE]\n\n']);
  const text = split
    .filter((chunk): chunk is Extract<StreamChunk, { type: 'text-delta' }> => chunk.type === 'text-delta')
    .map((chunk) => chunk.text)
    .join('');
  check(text === 'indivisible', `a frame split at byte ${at} is still one frame`);
}

const crlf = await collect([
  'data: {"choices":[{"delta":{"content":"crlf"}}]}\r\n\r\n',
  'data: [DONE]\r\n\r\n',
]);
check(
  crlf.some((chunk) => chunk.type === 'text-delta' && chunk.text === 'crlf'),
  'CRLF line endings parse too',
);

const noisy = await collect([
  ': a comment nobody should choke on\n\n',
  textFrame('after'),
  'data: {not json at all}\n\n',
  'data: [DONE]\n\n',
]);
check(
  noisy.some((chunk) => chunk.type === 'text-delta' && chunk.text === 'after'),
  'comments and unreadable frames are skipped, not fatal',
);
check(noisy.at(-1)?.type === 'finish', 'and the stream still finishes');

/*
  Tool calls stream their arguments in fragments, and the provider's `index` is
  per tool call — it starts at zero while a text block is already open, so it
  cannot be used as the block index.
*/
const tools = await collect([
  textFrame('let me look'),
  frame({
    choices: [
      { delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'search', arguments: '{"q":' } }] } },
    ],
  }),
  frame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"402"}' } }] } }] }),
  frame({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
  'data: [DONE]\n\n',
]);
const toolEnd = tools.find(
  (chunk) => chunk.type === 'block-end' && chunk.block.type === 'tool-call',
) as Extract<StreamChunk, { type: 'block-end' }> | undefined;
check(
  toolEnd?.block.type === 'tool-call' && toolEnd.block.arguments === '{"q":"402"}',
  'argument fragments are concatenated as raw JSON, never parsed',
);
check(
  toolEnd?.block.type === 'tool-call' && toolEnd.block.name === 'search',
  'the name from the first fragment survives the ones without it',
);
const toolStart = tools.find(
  (chunk) => chunk.type === 'block-start' && chunk.blockType === 'tool-call',
) as Extract<StreamChunk, { type: 'block-start' }> | undefined;
check(toolStart?.index === 1, "the block index is ours, not the provider's per-call index");
check(
  tools.findIndex((chunk) => chunk.type === 'block-end') <
    tools.findIndex((chunk) => chunk.type === 'block-start' && chunk.blockType === 'tool-call'),
  'the open text block is closed before a tool call opens',
);

const reasoning = await collect([
  frame({ choices: [{ delta: { reasoning: 'thinking' } }] }),
  textFrame('answer'),
  frame({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
  'data: [DONE]\n\n',
]);
const reasoningTypes = reasoning.map((chunk) => chunk.type);
check(
  reasoningTypes.indexOf('block-end') < reasoningTypes.lastIndexOf('block-start'),
  'reasoning is closed before text opens — one block at a time',
);

const empty = await collect(['data: [DONE]\n\n']);
check(empty.length === 1 && empty[0]!.type === 'finish', 'a stream with no content still finishes');


/* ---------------------------------------------------------------- reporting */

section('Reporting the wallet address');

{
  const seen: string[] = [];

  const reporter = createReporter();
  reporter.publish('0xabc', 'waiting for funds');
  check(seen.length === 0, 'a report before anything is listening goes nowhere');

  /*
    The bug this exists for. The settings service attaches after the payment
    source has started and already reported once; without the replay that first
    report is lost, the guard has recorded it as sent, and every later identical
    report is skipped — so the address is never written and the settings page
    says "no wallet yet" about a wallet that exists.
  */
  reporter.attach((address, status) => seen.push(`${address}|${status}`));
  check(seen.length === 1, 'attaching replays what was already reported');
  check(seen[0] === '0xabc|waiting for funds', 'and replays it verbatim');

  reporter.publish('0xabc', 'waiting for funds');
  check(seen.length === 1, 'an unchanged report is not repeated');

  reporter.publish('0xabc', 'ready — holds 1 ℏ');
  check(seen.length === 2, 'a changed status is reported');
  check(seen[1] === '0xabc|ready — holds 1 ℏ', 'with the new status');

  reporter.publish('0xdef', 'ready — holds 1 ℏ');
  check(seen.length === 3, 'a changed address is reported');
}

{
  // A sink that never arrives must not throw on the way past.
  const quiet = createReporter();
  quiet.publish('0x1', 'a');
  quiet.publish('0x2', 'b');
  check(true, 'publishing with no sink attached is harmless');

  const later: string[] = [];
  quiet.attach((address) => later.push(address));
  check(
    later.length === 1 && later[0] === '0x2',
    'only the latest state is replayed, not the whole history',
  );
}

{
  /*
    A withdrawal destination is checked before anything is signed, and the two
    networks do not take the same-looking address. The case that matters is the
    cross-network one: an EVM address is what a user has in their clipboard on
    either chain, and on Hedera it is not a destination.
  */
  check(isWithdrawDestination('0.0.1234', HEDERA), 'a Hedera account id is a Hedera destination');
  check(
    !isWithdrawDestination('0xabc9a1d0373f4e0bd477f4950fe3b43ec28cf1f6', HEDERA),
    'an EVM address is not a Hedera destination',
  );
  check(
    isWithdrawDestination('0xabc9a1d0373f4e0bd477f4950fe3b43ec28cf1f6', BASE),
    'an EVM address is an EVM destination',
  );
  check(!isWithdrawDestination('0.0.1234', BASE), 'a Hedera account id is not an EVM destination');
  check(!isWithdrawDestination('', HEDERA), 'an empty destination is refused');
  check(!isWithdrawDestination('0xabc', BASE), 'a truncated EVM address is refused');
  check(
    !isWithdrawDestination('0xabc9a1d0373f4e0bd477f4950fe3b43ec28cf1f6ff', BASE),
    'an over-long EVM address is refused',
  );
  check(!isWithdrawDestination('0.0', HEDERA), 'a malformed account id is refused');
}

console.log(failures === 0 ? '\nAll checks pass.' : `\n${failures} FAILED.`);
if (failures > 0) process.exit(1);
