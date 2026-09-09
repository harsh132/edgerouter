/**
 * The conversation with one agent, and what each of its answers cost.
 */
import { useEffect, useRef, useState } from 'react';
import { ArrowUp, Square } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Textarea } from '@/components/ui/textarea';
import { AgentMark } from './agent-mark';
import { EditDialog } from './edit-dialog';
import { Receipt } from './receipt';
import { ToolCall } from './tool-call';
import { Typing } from './typing';
import { nameOf, when } from '@/lib/format';
import { cn } from '@/lib/utils';
import { assign, halt, type Agent, type State, type Step, type Task } from '@/api';

const Bubble = ({ from, children }: { from: 'you' | 'them'; children: string }) => (
  <div
    className={cn(
      'max-w-[80%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap',
      from === 'you'
        ? 'self-end rounded-br-sm bg-primary text-primary-foreground'
        : 'self-start rounded-bl-sm border bg-card',
    )}
  >
    {children}
  </div>
);

const StepView = ({ step, network }: { step: Step; network: string }) => (
  <>
    {/*
      A step can speak, call tools, or do both. Only the empty case is a lie
      worth avoiding: a step still in flight has neither yet, and an ellipsis
      says so honestly.
    */}
    {step.tools?.length ? <ToolCall tools={step.tools} /> : null}
    {step.text || !step.tools?.length ? <Bubble from="them">{step.text || '…'}</Bubble> : null}
    <Receipt network={network} costMinor={step.costMinor} ms={step.ms} className="-mt-1 ml-1 self-start" />
  </>
);

const Outcome = ({ text }: { text: string }) => {
  /*
    Three endings, and only one of them is a fault.

    Something actually broke — red. Something cut the agent off, which is the
    revocation working and worth seeing — red, because it is the one ending
    somebody needs to notice. Running out of budget is neither: it is the
    product doing exactly what it promised, and painting it as an error taught
    the user to read a working spending limit as a crash.

    "Stopped by you" is ordinary too, and was already left alone.
  */
  const broke = text.startsWith('failed');
  const cutOff = text.includes('no longer resolves');
  const spent = text.startsWith('stopped —') && !cutOff;

  return (
    <div
      className={cn(
        'self-center rounded-full border px-3.5 py-1.5 text-xs',
        broke || cutOff
          ? 'border-destructive/40 bg-destructive/10 text-destructive'
          : spent
            ? 'border-border bg-muted text-foreground'
            : 'bg-muted text-muted-foreground',
      )}
    >
      {text}
    </div>
  );
};

const TaskView = ({ task, network }: { task: Task; network: string }) => (
  <>
    <div className="self-center py-1 text-[11px] text-muted-foreground">{when(task.startedAt)}</div>
    <Bubble from="you">{task.prompt}</Bubble>
    {task.steps.map((step) => (
      <StepView key={`${task.id}-${step.n}`} step={step} network={network} />
    ))}
    {task.outcome && task.outcome !== 'finished' ? <Outcome text={task.outcome} /> : null}
  </>
);

export const AgentThread = ({ agent, state }: { agent: Agent; state: State }) => {
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement | null>(null);

  const stepCount = agent.tasks.reduce((total, task) => total + task.steps.length, 0);
  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth' });
  }, [stepCount, agent.id, agent.running]);

  /*
    Two ways to be unable to spend, and both close the composer: the budget is
    gone, or the name is. Nothing here decides that — the runtime already did,
    and it did so by being refused.
  */
  const spent = agent.status === 'revoked' || agent.status === 'broke';

  /*
    Being out of money is recoverable and being revoked is not, so only one of
    them gets an offer to fix it. Raising a revoked agent's budget would mint an
    allowance against a name that no longer resolves — the authority would
    refuse the first signature, and the button would be a lie with a
    transaction attached.
  */
  const [raising, setRaising] = useState(false);
  const canRaise = agent.status === 'broke';

  const send = async () => {
    const prompt = draft.trim();
    if (!prompt) return;
    setDraft('');
    setError(null);
    try {
      await assign(agent.id, prompt);
    } catch (problem) {
      setError((problem as Error).message);
      setDraft(prompt);
    }
  };

  return (
    <section className="flex min-h-0 min-w-0 flex-col">
      <header className="flex items-center gap-2.5 border-b px-5 py-3">
        <AgentMark agent={agent} size="sm" />
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold">{nameOf(agent)}</div>
          <div className="truncate font-mono text-[11px] text-muted-foreground">{agent.name ?? 'no ENS name'}</div>
        </div>
        {agent.running ? (
          <Badge variant="secondary" className="ml-auto gap-1.5">
            <span className="crew-breathe size-1.5 rounded-full bg-primary" />
            working
          </Badge>
        ) : null}
      </header>

      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-5 py-6">
          {agent.tasks.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-20 text-center">
              <AgentMark agent={agent} size="lg" />
              <h2 className="text-base font-semibold">{nameOf(agent)}</h2>
              <p className="max-w-sm text-sm text-muted-foreground">{agent.brief}</p>
              <p className="max-w-sm text-xs text-muted-foreground">
                Give it a task. Every reply it writes is bought from the gate with its own budget.
              </p>
            </div>
          ) : null}

          {agent.tasks.map((task) => (
            <TaskView key={task.id} task={task} network={agent.network} />
          ))}

          {agent.running ? <Typing /> : null}

          <div ref={bottom} />
        </div>
      </ScrollArea>

      <div className="border-t px-5 py-4">
        <div className="mx-auto w-full max-w-3xl">
          {error ? (
            <p className="mb-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </p>
          ) : null}

          {canRaise ? (
            <div className="mb-2 flex items-center gap-3 rounded-xl border bg-card px-4 py-3">
              <p className="min-w-0 flex-1 text-xs leading-relaxed text-muted-foreground">
                {nameOf(agent)} has spent what it was given. Raising its budget re-issues the allowance and it
                carries on from where it stopped.
              </p>
              <Button size="sm" className="shrink-0" onClick={() => setRaising(true)}>
                Raise budget
              </Button>
            </div>
          ) : null}

          <div className="flex items-end gap-2 rounded-xl border bg-card p-2 pl-4 focus-within:border-ring">
            <Textarea
              rows={1}
              value={draft}
              disabled={spent}
              placeholder={
                spent ? `${nameOf(agent)} cannot spend any more` : `Give ${nameOf(agent)} a task`
              }
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  void send();
                }
              }}
              className="max-h-40 min-h-0 resize-none border-0 bg-transparent p-0 py-2 shadow-none focus-visible:ring-0 dark:bg-transparent"
            />

            {agent.running ? (
              <Button
                size="icon"
                variant="destructive"
                className="size-8 rounded-full"
                onClick={() => void halt(agent.id)}
                title="Stop"
              >
                <Square className="size-3.5 fill-current" />
              </Button>
            ) : (
              <Button
                size="icon"
                className="size-8 rounded-full"
                disabled={spent || !draft.trim()}
                onClick={() => void send()}
                title="Send"
              >
                <ArrowUp />
              </Button>
            )}
          </div>

          <p className="mt-2 text-[11px] text-muted-foreground">
            {agent.spent} spent of {agent.budget} · {agent.network}
          </p>
        </div>
      </div>

      {raising ? (
        /*
          Keyed on the agent so switching agents with it open cannot leave one
          agent's number in another's form — the same reason the detail panel
          keys its copy.
        */
        <EditDialog key={agent.id} agent={agent} state={state} open onClose={() => setRaising(false)} />
      ) : null}
    </section>
  );
};
