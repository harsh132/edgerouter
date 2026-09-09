/**
 * Every paid step, newest first.
 *
 * The same facts as the receipts in the thread, gathered where they can be
 * scanned as a column of numbers rather than read as a conversation.
 */
import { money } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { Step } from '@/api';

/**
 * What a step is called in a single line.
 *
 * A step that only called tools has no text and never will, so "in flight" —
 * the placeholder for a step still being written — would sit there permanently
 * and describe a finished step as unfinished. The tools it called are the
 * honest description of what that step was.
 */
const describe = (step: Step): string => {
  if (step.text) return step.text;
  if (step.tools?.length) return step.tools.join(', ').replace(/_/g, ' ');
  return 'in flight';
};

export const Ledger = ({ steps, network }: { steps: Step[]; network: string }) => (
  <div className="flex flex-col">
    {steps.map((step) => (
      <div
        key={`${step.at}-${step.n}`}
        className="grid grid-cols-[1.25rem_minmax(0,1fr)_auto] items-baseline gap-2 border-b py-1.5 text-xs last:border-0"
      >
        <span className="font-mono text-muted-foreground">{step.n}</span>
        <span className={cn('truncate text-muted-foreground', !step.text && step.tools?.length && 'font-mono')}>
          {describe(step)}
        </span>
        <span className="font-mono tabular-nums">{money(network, step.costMinor)}</span>
      </div>
    ))}
  </div>
);
