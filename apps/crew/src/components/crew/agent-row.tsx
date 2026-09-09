/**
 * One agent in the rail: who it is, when it last worked, and what it last said.
 */
import { AgentMark } from './agent-mark';
import { nameOf, summarise, when } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { Agent } from '@/api';

export const AgentRow = ({
  agent,
  active,
  onSelect,
}: {
  agent: Agent;
  active: boolean;
  onSelect: () => void;
}) => (
  <button
    onClick={onSelect}
    className={cn(
      'flex w-full items-center gap-3 rounded-md px-2 py-2 text-left transition-colors hover:bg-sidebar-accent/40',
      active && 'bg-sidebar-accent/60',
    )}
  >
    <AgentMark agent={agent} />
    <div className="min-w-0 flex-1">
      <div className="flex items-baseline gap-2">
        <span className={cn('truncate text-sm font-medium', agent.status === 'revoked' && 'text-muted-foreground line-through')}>
          {nameOf(agent)}
        </span>
        <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
          {when(agent.tasks.at(-1)?.startedAt ?? agent.createdAt)}
        </span>
      </div>
      <p className="truncate text-xs text-muted-foreground">{summarise(agent)}</p>
    </div>
  </button>
);
