/**
 * Every paid step, newest first.
 *
 * The same facts as the receipts in the thread, gathered where they can be
 * scanned as a column of numbers rather than read as a conversation.
 */
import { money } from '@/lib/format';
import type { Step } from '@/api';

export const Ledger = ({ steps, network }: { steps: Step[]; network: string }) => (
  <div className="flex flex-col">
    {steps.map((step) => (
      <div
        key={`${step.at}-${step.n}`}
        className="grid grid-cols-[1.25rem_minmax(0,1fr)_auto] items-baseline gap-2 border-b py-1.5 text-xs last:border-0"
      >
        <span className="font-mono text-muted-foreground">{step.n}</span>
        <span className="truncate text-muted-foreground">{step.text || 'in flight'}</span>
        <span className="font-mono tabular-nums">{money(network, step.costMinor)}</span>
      </div>
    ))}
  </div>
);
