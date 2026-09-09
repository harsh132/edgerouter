/**
 * An agent asking for more money, and a person answering.
 *
 * The budget is the one thing an agent cannot raise for itself — that is the
 * whole point of it — so the only honest way for an agent to continue past its
 * limit is to ask somebody who can. This is that conversation, and it is
 * deliberately a conversation rather than a mechanism: nothing here grants
 * anything. It carries a question to a human and an answer back.
 *
 * ## Not persisted
 *
 * A pending request does not survive a restart, and should not. The thing
 * waiting on the answer is a paused tool call inside a running task, and that
 * task died with the process — so a request restored from disk would be a
 * question whose asker is gone, offering to raise a budget for a run that
 * cannot resume. Approving it would spend real money on nobody's behalf.
 *
 * ## The human may grant less
 *
 * Approval takes an amount rather than a yes. An agent that asks for two hbar
 * and needs a tenth of one should get a tenth, and making the granter retype
 * the number is the difference between a limit they set and a limit they
 * rubber-stamped.
 */
import { randomUUID } from 'node:crypto';
import { formatAmount } from '../../../packages/sdk/src/index';
import { emit } from './events';

/** How long an agent waits before giving up on an answer. */
const PATIENCE_MS = 5 * 60 * 1000;

export type BudgetRequest = {
  id: string;
  agentId: string;
  /** What the agent asked for, in the smallest unit. */
  askedMinor: string;
  /** The same, written the way the network writes amounts. */
  asked: string;
  /** Why it says it needs more. Its words, shown to the human unedited. */
  reason: string;
  at: number;
};

export type Answer =
  | { approved: true; grantedMinor: bigint }
  | { approved: false; why: string };

type Waiting = { request: BudgetRequest; answer: (answer: Answer) => void; timer: ReturnType<typeof setTimeout> };

const waiting = new Map<string, Waiting>();

export const pending = (): BudgetRequest[] => [...waiting.values()].map((entry) => entry.request);

export const pendingFor = (agentId: string): BudgetRequest | undefined =>
  [...waiting.values()].find((entry) => entry.request.agentId === agentId)?.request;

/**
 * Raises a request and waits for an answer.
 *
 * Resolves rather than throws in every case, including nobody answering,
 * because the caller is a tool inside an agent's loop: an unanswered question
 * is a fact the agent needs to hear and act on, not an exception that ends its
 * run. The distinction matters most in the case that will actually happen —
 * the person who was going to approve it has gone to lunch.
 */
export const ask = (params: {
  agentId: string;
  network: string;
  amountMinor: bigint;
  reason: string;
}): Promise<Answer> => {
  /*
    One question at a time. An agent that can queue requests can ask twenty
    while nobody is looking, and a human returning to twenty identical cards
    cannot tell which are still meaningful.
  */
  const already = pendingFor(params.agentId);
  if (already) {
    return Promise.resolve({ approved: false, why: 'you already have a request waiting for an answer' });
  }

  const request: BudgetRequest = {
    id: randomUUID(),
    agentId: params.agentId,
    askedMinor: params.amountMinor.toString(),
    asked: formatAmount(params.network, params.amountMinor),
    reason: params.reason,
    at: Date.now(),
  };

  return new Promise<Answer>((resolve) => {
    const finish = (answer: Answer) => {
      const entry = waiting.get(request.id);
      if (!entry) return;
      clearTimeout(entry.timer);
      waiting.delete(request.id);
      emit({ type: 'requests' });
      resolve(answer);
    };

    const timer = setTimeout(
      () => finish({ approved: false, why: 'nobody answered in five minutes' }),
      PATIENCE_MS,
    );

    waiting.set(request.id, { request, answer: finish, timer });
    emit({ type: 'requests' });
  });
};

/** Answers a request. Returns false when it is already gone. */
export const settle = (id: string, answer: Answer): boolean => {
  const entry = waiting.get(id);
  if (!entry) return false;
  entry.answer(answer);
  return true;
};

/**
 * Abandons an agent's request because its run ended.
 *
 * Without this a task that was stopped by hand leaves a card offering to fund
 * work nobody is doing any more.
 */
export const abandon = (agentId: string): void => {
  for (const entry of [...waiting.values()]) {
    if (entry.request.agentId === agentId) {
      entry.answer({ approved: false, why: 'the run ended before anyone answered' });
    }
  }
};
