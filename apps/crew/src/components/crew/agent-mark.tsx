/**
 * An agent's mark: a coloured blob with a state pip.
 *
 * A blob rather than a face. These are budgets with names on them, and dressing
 * one as a colleague would be a claim the app cannot back — the pip is the only
 * thing here that asserts anything, and it asserts something true: whether this
 * agent is spending, out of money, or revoked.
 */
import { cn } from '@/lib/utils';
import { hueOf, initialsOf } from '@/lib/format';
import type { Agent } from '@/api';

export type MarkSize = 'sm' | 'md' | 'lg';

const BOX: Record<MarkSize, string> = {
  sm: 'size-6 rounded-md text-[10px]',
  md: 'size-9 rounded-lg text-xs',
  lg: 'size-14 rounded-xl text-lg',
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
  const hue = hueOf(agent.label);
  const revoked = agent.status === 'revoked';
  /*
    A pip only when there is something to say. An idle agent that has never run
    is the ordinary case and deserves no decoration; a dot that is always there
    stops meaning anything.
  */
  const pip = size !== 'sm' && (agent.running || revoked || agent.status === 'broke');

  return (
    <div className={cn('relative shrink-0', className)}>
      <div
        className={cn('grid place-items-center font-semibold text-black/80', BOX[size], revoked && 'brightness-50 grayscale')}
        style={{ background: `linear-gradient(150deg, hsl(${hue} 80% 70%), hsl(${(hue + 36) % 360} 74% 58%))` }}
      >
        {initialsOf(agent.label)}
      </div>

      {pip ? (
        <span
          className={cn(
            'absolute -right-0.5 -bottom-0.5 size-3 rounded-full ring-2 ring-sidebar',
            agent.running && 'crew-breathe bg-primary',
            !agent.running && agent.status === 'broke' && 'bg-chart-1',
            revoked && 'bg-destructive',
          )}
        />
      ) : null}
    </div>
  );
};
