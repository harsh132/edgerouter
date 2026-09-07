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
import { resolveMaxAmount } from './src/index';
import {
  convertMessage,
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
  // `totalTokens` is in the harness's main-branch TokenUsage but not in the rc
  // we build against, so it is emitted for forward-compatibility and read here
  // through a cast rather than dropped and re-added later.
  const forward = usage as typeof usage & { totalTokens?: number };
  check(usage.outputTokens === 20 && forward.totalTokens === 120, 'output and total carry over');
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

check(resolveMaxAmount('500') === 500n, 'a numeric cap parses');
check(resolveMaxAmount(undefined) === 100_000_000n, 'the default cap is one HBAR');
for (const bad of ['0', '-1', '1.5', 'lots', '']) {
  let refused = false;
  try {
    resolveMaxAmount(bad);
  } catch {
    refused = true;
  }
  check(refused, `a cap of "${bad}" is refused rather than defaulted`);
}

console.log(failures === 0 ? '\nAll checks pass.' : `\n${failures} FAILED.`);
if (failures > 0) process.exit(1);
