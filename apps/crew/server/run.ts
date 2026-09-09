/**
 * Giving an agent a task, and letting it spend until it is done or broke.
 *
 * The loop is pi's. What this file adds is the only thing pi cannot know: that
 * every model call costs money, whose money it was, and when to stop. It does
 * that entirely through the fetch it hands over — pi asks for a completion, a
 * payment happens, pi gets its answer. The loop never learns it bought
 * anything, which is why it did not have to be written here.
 *
 * ## Stopping
 *
 * Three ways, and they are not the same event:
 *
 *   - The task finishes. pi stops on its own; the last message is the answer.
 *   - The budget runs out. The authority refuses to sign, `payingFetch` raises
 *     `BudgetExhausted`, and the run ends with money as the stated reason.
 *   - The name is revoked. Same refusal, different cause — the guard finds the
 *     name no longer resolves. This is the one worth watching: the agent is
 *     stopped by a registry write it has no say in, mid-sentence if need be.
 */
import { Agent as PiAgent } from '@earendil-works/pi-agent-core';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { randomUUID } from 'node:crypto';
import { formatAmount } from '../../../packages/sdk/src/index';
import { modelFor } from './model';
import { payingFetch, BudgetExhausted } from './paying-fetch';
import { connectionFor, publish, type Runtime } from './crew';
import { toolsFor } from './tools';
import { emit } from './events';
import type { Agent, Step, Task } from './store';

/** Live runs, so a task can be stopped from the UI. */
const running = new Map<string, PiAgent>();

/**
 * The most any single call may cost.
 *
 * Not the agent's whole budget: a quote far above the going rate is a sign
 * something is wrong with the gate's pricing, and spending an entire allowance
 * on one mispriced call is worse than refusing it. The authority enforces the
 * real limit; this is a sanity bound on top.
 */
const perCallCeiling = (agent: Agent): bigint => {
  const remaining = BigInt(agent.budgetMinor) - BigInt(agent.spentMinor);
  const tenth = BigInt(agent.budgetMinor) / 10n;
  return tenth > 0n && tenth < remaining ? tenth : remaining;
};

export const stop = (agentId: string): boolean => {
  const live = running.get(agentId);
  if (!live) return false;
  live.abort();
  return true;
};

export const isRunning = (agentId: string): boolean => running.has(agentId);

/**
 * Runs one task to completion, recording what each step cost.
 *
 * Returns when the agent stops for any reason. The task is written to the crew
 * file as it goes rather than at the end, because the interesting failure —
 * revocation mid-task — is exactly the case where there is no end.
 */
export const runTask = async (runtime: Runtime, agent: Agent, prompt: string): Promise<Task> => {
  if (running.has(agent.id)) throw new Error(`${agent.label} is already working`);
  if (agent.status === 'revoked') throw new Error(`${agent.label} has been revoked`);

  const connection = await connectionFor(runtime, agent);

  const task: Task = { id: randomUUID(), prompt, startedAt: Date.now(), steps: [] };
  agent.tasks.push(task);
  agent.status = 'running';
  publish(runtime);
  emit({ type: 'status', agentId: agent.id, status: 'running' });

  /*
    Spend is recorded from the receipt, per call, as it happens — not totalled
    at the end. A run that is cut off still has to leave behind an accurate
    figure for what it spent, or the next attach would hand it back money it
    already used.
  */
  const fetch = payingFetch({
    signer: connection.signer,
    network: agent.network,
    maxAmountMinor: perCallCeiling(agent),
    onSpend: ({ costMinor, ms }) => {
      agent.spentMinor = (BigInt(agent.spentMinor) + costMinor).toString();
      const step: Step = {
        n: task.steps.length + 1,
        at: Date.now(),
        text: '',
        costMinor: costMinor.toString(),
        ms,
      };
      task.steps.push(step);
      emit({ type: 'step', agentId: agent.id, step, spentMinor: agent.spentMinor });
      publish(runtime);
    },
  });

  const model = modelFor(runtime.gate, agent.model);
  const api = openAICompletionsApi();

  const pi = new PiAgent({
    /*
      The one line that makes any of this cost money.

      pi asks the OpenAI-completions API for a stream; the API asks the fetch it
      was given; that fetch settles a 402 with this agent's capability before it
      returns. Nothing above this line knows a payment happened, which is why
      the loop could be someone else's.
    */
    streamFn: (piModel, context, options) => api.stream(piModel, context, { ...options, fetch }),
    /*
      pi will not call the provider until it has a key, and the whole premise
      here is that there isn't one — the gate is paid, not authenticated. So it
      is handed a constant to satisfy the check.

      Deliberately not a secret and not treated as one: the gate ignores
      Authorization entirely and answers 402 regardless, so this string grants
      nothing. Naming it after what actually pays makes that visible in a
      request log rather than looking like a credential someone leaked.
    */
    getApiKey: () => 'x402-no-api-key',
    initialState: {
      messages: [],
      systemPrompt: [
        agent.brief.trim(),
        '',
        `You are ${agent.title ?? agent.label}${agent.name ? ` (${agent.name})` : ''}, an autonomous agent.`,
        'Every reply you generate is paid for out of a budget you cannot raise,',
        'and every tool call is a step you pay for too. Work in as few steps as',
        'you can, and stop when the task is done.',
        '',
        'You have a workspace of your own. Files you write there persist between',
        'tasks, and nothing outside it is reachable. When a task produces',
        'something worth keeping, write it to a file rather than only saying it.',
      ].join('\n'),
      model,
      /*
        Bound to this agent, so the workspace is captured when the tools are
        built rather than travelling as an argument the model could set.
      */
      tools: toolsFor(agent.label),
    } as never,
  });

  running.set(agent.id, pi);

  /*
    The text of each step, filled in as messages complete. The cost was recorded
    when the call was made — before any of this arrived — so the two are matched
    by position: the nth completed message belongs to the nth paid call.
  */
  let completed = 0;
  const unsubscribe = pi.subscribe((event) => {
    if (event.type !== 'message_end') return;
    const message = event.message as { role?: string; content?: unknown };
    if (message.role !== 'assistant') return;

    const step = task.steps[completed];
    completed += 1;
    if (!step) return;

    step.text = textOf(message.content);
    const tools = toolsOf(message.content);
    if (tools.length > 0) step.tools = tools;
    emit({ type: 'step', agentId: agent.id, step, spentMinor: agent.spentMinor });
  });

  /*
    How a run ends, and where to look for it.

    `prompt()` resolves rather than throws when the stream fails — the reason
    goes to `state.errorMessage` instead. Treating a resolved promise as success
    is therefore wrong, and wrong in the worst direction: a run that bought
    nothing and failed reported "finished" with an empty answer. Both places are
    checked, and the thrown case is kept because an abort still throws.
  */
  let thrown: Error | null = null;
  try {
    await pi.prompt(prompt);
  } catch (error) {
    thrown = error as Error;
  }

  const failure = thrown?.message ?? pi.state.errorMessage;
  const stoppedByHand = thrown?.name === 'AbortError' || pi.signal?.aborted === true;

  if (!failure) {
    task.outcome = 'finished';
    task.answer = task.steps.at(-1)?.text ?? '';
    agent.status = 'done';
  } else if (thrown instanceof BudgetExhausted || failure.includes('BudgetExhausted')) {
    /*
      Said in terms of money, because that is what happened. The difference
      between "spent its budget" and "was revoked" comes from the authority's
      own words, which name the node and the reason.
    */
    const revoked = failure.includes('resolve');
    task.outcome = revoked
      ? 'stopped — its name no longer resolves, so the authority refused to sign'
      : `stopped — its budget of ${formatAmount(agent.network, BigInt(agent.budgetMinor))} is spent`;
    agent.status = revoked ? 'revoked' : 'broke';
  } else if (stoppedByHand) {
    task.outcome = 'stopped by you';
    agent.status = 'stopped';
  } else {
    task.outcome = `failed — ${failure}`;
    agent.status = 'idle';
  }

  {
    unsubscribe();
    running.delete(agent.id);
    task.endedAt = Date.now();
    publish(runtime);
    emit({ type: 'status', agentId: agent.id, status: agent.status, ...(task.outcome ? { detail: task.outcome } : {}) });
  }

  return task;
};

/** Which tools the model asked for, in the order it asked. */
const toolsOf = (content: unknown): string[] => {
  if (!Array.isArray(content)) return [];
  return content
    .filter(
      (block): block is { type: string; name: string } =>
        Boolean(block) && typeof block === 'object' && (block as { type?: string }).type === 'toolCall',
    )
    .map((block) => block.name);
};

/** Assistant content is blocks or a string, depending on the provider. */
const textOf = (content: unknown): string => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block): block is { type: string; text: string } =>
      Boolean(block) && typeof block === 'object' && (block as { type?: string }).type === 'text',
    )
    .map((block) => block.text)
    .join('');
};
