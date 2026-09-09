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
import { allows as permitted } from '../../../packages/core/src/caveat';
import { modelFor } from './model';
import { payingFetch, BudgetExhausted } from './paying-fetch';
import { connectionFor, publish, type Runtime } from './crew';
import { toolsFor } from './tools';
import { ALL_PERMISSIONS, type Permission } from './permissions';
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
  /*
    The authority's refusal, caught on the way past.

    An agent that spends its last tinybar gets a 402 it cannot settle, and the
    fetch throws — but pi catches that, reports "Connection error.", and the
    real reason is gone. So the refusal is recorded when it happens, and the
    outcome below trusts this over anything pi has to say.
  */
  let denied: BudgetExhausted | null = null;

  const fetch = payingFetch({
    signer: connection.signer,
    network: agent.network,
    maxAmountMinor: perCallCeiling(agent),
    remainingMinor: BigInt(agent.budgetMinor) - BigInt(agent.spentMinor),
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
    /*
      Kept here rather than relied on from the throw. pi swallows the error and
      substitutes its own text, so by the time the run ends the only evidence
      that an agent ran out of money is this.
    */
    onRefusal: (refusal) => {
      denied = refusal;
    },
  });

  /*
    What this agent may do, read out of the capability it is about to spend
    with rather than out of the crew file beside it.

    The two normally agree, and when they do not the capability is right: it is
    the thing that was signed, the thing the authority checks, and the thing an
    attenuated grant from another agent would have narrowed. Trusting the file
    would mean a token saying one thing while the tools do another, which is the
    shape of every permission bug worth having.

    A capability that cannot be opened yields no permissions at all. That is the
    fail-closed direction and it is deliberate — an agent whose token is
    unreadable should be able to buy nothing and touch nothing, not everything.
  */
  const policy = agent.capability
    ? await runtime.authority
        .open(agent.capability)
        .then((opened) => opened.policy)
        .catch(() => null)
    : null;
  const allows = (permission: Permission): boolean => policy !== null && permitted(policy, permission);

  const missing = ALL_PERMISSIONS.filter((permission) => !allows(permission));

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
        '',
        /*
          What it cannot do, said plainly, because absence is silent and silence
          costs money. A read-only agent asked to write a file has no
          `write_file` to call, so it goes looking for another way and pays for
          every step of looking — observed here at the price of an agent's whole
          remaining budget. Naming the limit up front is cheaper than letting it
          be discovered.
        */
        ...(missing.length > 0
          ? [
              `You do not have these permissions: ${missing.join(', ')}.`,
              'Nothing you can do will work around that. If a task needs one of',
              'them, say which is missing and stop rather than looking for another',
              'route — there is not one, and looking costs the same as working.',
            ]
          : []),
      ].join('\n'),
      model,
      /*
        Bound to this agent, so the workspace is captured when the tools are
        built rather than travelling as an argument the model could set.
      */
      tools: toolsFor(agent.label, allows),
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

    Neither place is trusted about *money*, though. pi rewrites a failing fetch
    into "Connection error.", so an agent that ran out of budget accused the
    network. The refusal recorded by the fetch itself is checked first.
  */
  let thrown: Error | null = null;
  try {
    await pi.prompt(prompt);
  } catch (error) {
    thrown = error as Error;
  }

  const failure = thrown?.message ?? pi.state.errorMessage;
  const stoppedByHand = thrown?.name === 'AbortError' || pi.signal?.aborted === true;

  /*
    The refusal wins over whatever pi called it.

    `denied` is set by the fetch at the moment the authority said no, so it is
    the only account of the failure that has not been through a layer that
    rewrites errors. Checked first, and checked even when pi reported something
    that looks like a network problem, because that is exactly what pi reports.
  */
  const refusal = denied ?? (thrown instanceof BudgetExhausted ? thrown : null);

  if (refusal || (failure && failure.includes('BudgetExhausted'))) {
    /*
      Said in terms of money, because that is what happened. The difference
      between "spent its budget" and "was revoked" comes from the authority's
      own words, which name the node and the reason.
    */
    const why = refusal?.reason ?? failure ?? '';

    /*
      Three ways to be refused, and they are not the same news. A revoked name
      is somebody having stopped this agent; a spent budget is it having done
      all it was funded to do; a quote above the per-call cap is neither, and
      the agent still has money.
    */
    if (why.includes('resolve')) {
      task.outcome = 'stopped — its name no longer resolves, so the authority refused to sign';
      agent.status = 'revoked';
    } else if (why.includes('per-call cap')) {
      task.outcome = `stopped — one call was quoted above its per-call limit, so nothing was bought`;
      agent.status = 'idle';
    } else {
      /*
        What is actually left, not a round "budget spent".

        An agent almost never lands on zero — it stops when the next call costs
        more than the remainder, which is usually a small amount still sitting
        there. Reporting the budget as spent when a tenth of a hbar remains is
        the kind of small lie that makes someone go looking for the missing
        money.
      */
      const left = BigInt(agent.budgetMinor) - BigInt(agent.spentMinor);
      const budget = formatAmount(agent.network, BigInt(agent.budgetMinor));

      /*
        And what to do about it, because there is something.

        A limit that stops an agent without saying it can be raised reads as a
        dead end rather than a control. The budget is the user's number and
        always was; the message should say so where they are already looking,
        not leave them to discover an Edit button.
      */
      task.outcome =
        left > 0n
          ? `stopped — ${formatAmount(agent.network, left)} left of ${budget}, less than the next call costs. Raise its budget to carry on.`
          : `stopped — it has spent its budget of ${budget}. Raise it to carry on.`;
      agent.status = 'broke';
    }
  } else if (!failure) {
    task.outcome = 'finished';
    task.answer = task.steps.at(-1)?.text ?? '';
    agent.status = 'done';
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
