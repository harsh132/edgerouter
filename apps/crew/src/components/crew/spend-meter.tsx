/**
 * Spend against a limit, and how close the limit is.
 *
 * The bar earns its place because this is the only number on the screen that
 * can stop an agent working. It turns destructive near the top not as decoration
 * but as the last warning before the authority starts refusing to sign.
 */
import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/utils';

export const SpendMeter = ({
  spentMinor,
  budgetMinor,
  spent,
  budget,
  className,
}: {
  spentMinor: string;
  budgetMinor: string;
  /** Already formatted, because the caller knows the network and this does not. */
  spent: string;
  budget: string;
  className?: string;
}) => {
  const limit = BigInt(budgetMinor);
  /*
    Percentage computed in bigint and only then narrowed. A budget in tinybars
    is comfortably past what a double represents exactly, and a bar that is
    subtly wrong about how much money is left is worse than no bar.
  */
  const share = limit === 0n ? 0 : Number((BigInt(spentMinor) * 1000n) / limit) / 10;

  return (
    <div className={cn('flex flex-col gap-2.5', className)}>
      <div className="flex items-baseline gap-1.5 font-mono">
        <span className="text-xl font-semibold tabular-nums">{spent}</span>
        <span className="text-xs text-muted-foreground">of {budget}</span>
      </div>
      {/*
        The track is neutral rather than the theme's tinted `bg-primary/20`.
        A track a shade away from its own fill reads as a full bar, which is
        the one misreading this component must not allow: it would say an agent
        is out of money when it has spent eight percent.
      */}
      <Progress
        value={Math.min(100, share)}
        className={cn(
          'h-1.5 bg-muted',
          share > 65 && share <= 90 && '[&>[data-slot=progress-indicator]]:bg-chart-1',
          share > 90 && '[&>[data-slot=progress-indicator]]:bg-destructive',
        )}
      />
    </div>
  );
};
