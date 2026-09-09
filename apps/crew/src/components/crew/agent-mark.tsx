/**
 * An agent's mark: its picture, and a pip saying what it is doing.
 *
 * A custom image when it has one, otherwise the sigil its name draws. Never a
 * face — these are budgets with names on them, and dressing one as a colleague
 * would be a claim the app cannot back. The pip is the only thing here that
 * asserts anything, and what it asserts is true: spending, out of money, or
 * revoked.
 */
import { useMemo } from 'react';
import { cn } from '@/lib/utils';
import { sigilSvg } from '@/lib/sigil';
import type { Agent } from '@/api';

export type MarkSize = 'sm' | 'md' | 'lg';

const BOX: Record<MarkSize, string> = {
  sm: 'size-6 rounded-md',
  md: 'size-9 rounded-lg',
  lg: 'size-14 rounded-xl',
};

export const AgentMark = ({
  agent,
  size = 'md',
  className,
}: {
  agent: Agent;
  size?: MarkSize;
  className?: string;
}) => {
  const revoked = agent.status === 'revoked';

  /*
    Redrawn only when the name changes. Generating a sigil walks a symbol table
    and builds DOM, and the roster re-renders on every event the runtime sends —
    which, while an agent is working, is several a second.
  */
  const svg = useMemo(() => (agent.avatar ? null : sigilSvg(agent.label)), [agent.avatar, agent.label]);

  /*
    A pip only when there is something to say. An idle agent that has never run
    is the ordinary case and deserves no decoration; a dot that is always there
    stops meaning anything.
  */
  const pip = size !== 'sm' && (agent.running || revoked || agent.status === 'broke');

  return (
    <div className={cn('relative shrink-0', className)}>
      <div
        className={cn(
          'overflow-hidden border bg-muted [&>svg]:size-full',
          BOX[size],
          revoked && 'brightness-50 grayscale',
        )}
      >
        {agent.avatar ? (
          <img src={agent.avatar} alt="" className="size-full object-cover" />
        ) : (
          /*
            The sigil library returns SVG source, not an element. It is our own
            output from our own input — no user-supplied string reaches this —
            and rendering it inline keeps it a vector that inherits the box.
          */
          <span className="block size-full" dangerouslySetInnerHTML={{ __html: svg! }} />
        )}
      </div>

      {pip ? (
        <span
          className={cn(
            'absolute -right-0.5 -bottom-0.5 size-3 rounded-full ring-2 ring-card',
            agent.running && 'crew-breathe bg-primary',
            !agent.running && agent.status === 'broke' && 'bg-chart-1',
            revoked && 'bg-destructive',
          )}
        />
      ) : null}
    </div>
  );
};
