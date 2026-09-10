/**
 * The one wallet everything spends from, at the foot of the rail.
 *
 * Low in the layout on purpose: it is the source of all the money on this
 * screen and the thing a user checks once, not the thing they work with. The
 * undeposited line appears only on chains where holding a token and being able
 * to spend it are different facts.
 *
 * Adding funds lives here rather than only on the first run, because running out
 * is not a first-run problem. A crew that has been working for an hour hits the
 * same wall as one that has never paid for anything, and sending them to a
 * screen they can only reach by emptying the wallet would be absurd.
 */
import { Plus, Wallet } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ConnectWallet } from './connect-wallet';
import type { State } from '@/api';

export const WalletBar = ({ state, note }: { state: State; note?: string }) => {
  const [adding, setAdding] = useState(false);

  return (
    <div className="flex flex-col gap-2">
      {note ? <p className="truncate text-[11px] text-muted-foreground">{note}</p> : null}

      <div className="flex items-center gap-2 text-xs">
        <Wallet className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate text-muted-foreground" title={state.account}>
          {state.account}
        </span>
        <span className="ml-auto shrink-0 font-mono font-medium tabular-nums">{state.spendable}</span>
        {state.funding ? (
          <Button
            variant="ghost"
            size="icon"
            className="size-6 shrink-0"
            title="Add funds"
            onClick={() => setAdding(true)}
          >
            <Plus className="size-3.5" />
          </Button>
        ) : null}
      </div>

      {state.held ? (
        <p className="text-[11px] text-muted-foreground">{state.held} in the wallet, not yet deposited</p>
      ) : null}

      {state.funding ? (
        <Dialog open={adding} onOpenChange={(next) => !next && setAdding(false)}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Add funds</DialogTitle>
              <DialogDescription>
                Agents pay per call from this balance. Depositing puts money straight into what they spend
                from — it never sits in a hot wallet as loose {state.funding.tokenSymbol}.
              </DialogDescription>
            </DialogHeader>
            <ConnectWallet route={state.funding} />
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
};
