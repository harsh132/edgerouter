/**
 * The one wallet everything spends from, at the foot of the rail.
 *
 * Low in the layout on purpose: it is the source of all the money on this
 * screen and the thing a user checks once, not the thing they work with. The
 * undeposited line appears only on chains where holding a token and being able
 * to spend it are different facts.
 *
 * Adding funds used to live here behind a plus icon. It moved to the bar at the
 * top, where a person actually looks for a wallet — this reports a balance, and
 * a control tucked beside a number reads as being about that number rather than
 * about the account.
 */
import { Wallet } from 'lucide-react';
import type { State } from '@/api';

export const WalletBar = ({ state, note }: { state: State; note?: string }) => (
  <div className="flex flex-col gap-2">
    {note ? <p className="truncate text-[11px] text-muted-foreground">{note}</p> : null}

    <div className="flex items-center gap-2 text-xs">
      <Wallet className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="truncate text-muted-foreground" title={state.account}>
        {state.account}
      </span>
      <span className="ml-auto shrink-0 font-mono font-medium tabular-nums">{state.spendable}</span>
    </div>

    {state.held ? (
      <p className="text-[11px] text-muted-foreground">{state.held} in the wallet, not yet deposited</p>
    ) : null}
  </div>
);
