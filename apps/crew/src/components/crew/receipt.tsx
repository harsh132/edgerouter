/**
 * What one reply cost, shown under the reply.
 *
 * Attached to the message rather than summed in a corner, because the claim
 * being made is per-call: this sentence was bought, on a chain, for this much,
 * in this long. A total would prove that money moved; this proves what it
 * bought.
 */
import { money } from '@/lib/format';
import { cn } from '@/lib/utils';

export const Receipt = ({
  network,
  costMinor,
  ms,
  className,
}: {
  network: string;
  costMinor: string;
  ms: number;
  className?: string;
}) => (
  <div className={cn('flex items-center gap-2 font-mono text-[11px] text-muted-foreground', className)}>
    <span className="text-foreground/70">{money(network, costMinor)}</span>
    <span aria-hidden>·</span>
    <span>{(ms / 1000).toFixed(1)}s</span>
  </div>
);
