/**
 * A titled block in the detail panel.
 *
 * Exists so the four sections cannot drift apart — the moment one has a
 * different heading size than the others, the panel reads as three panels.
 */
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export const Section = ({
  title,
  children,
  className,
}: {
  title: string;
  children: ReactNode;
  className?: string;
}) => (
  <section className={cn('flex flex-col gap-2', className)}>
    <h3 className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{title}</h3>
    {children}
  </section>
);
