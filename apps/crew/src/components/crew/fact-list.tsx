/**
 * A short description list, for the facts about a thing that are just facts.
 *
 * Monospace on the values because most of them are addresses, model ids and
 * chain names — strings where the exact characters matter and a proportional
 * font makes two similar ones look identical.
 */
import { cn } from '@/lib/utils';

export type Fact = { term: string; value: string; title?: string };

export const FactList = ({ facts, className }: { facts: Fact[]; className?: string }) => (
  <dl className={cn('flex flex-col gap-1.5 text-xs', className)}>
    {facts.map((fact) => (
      <div key={fact.term} className="flex justify-between gap-3">
        <dt className="shrink-0 text-muted-foreground">{fact.term}</dt>
        <dd className="truncate font-mono" title={fact.title ?? fact.value}>
          {fact.value}
        </dd>
      </div>
    ))}
  </dl>
);
