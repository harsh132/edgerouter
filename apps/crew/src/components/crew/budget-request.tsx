/**
 * An agent asking for money, and the person deciding.
 *
 * Shown where the agent's own work is shown, not in a notification tray, for
 * the same reason the outcome pills live there: the request only makes sense
 * beside what it was spent on. Somebody deciding whether to grant another
 * quarter of an hbar wants the ledger and the last few steps on screen, and a
 * card that pulls them away from both is asking them to decide blind.
 *
 * The amount is editable and pre-filled with what was asked. Approving is not
 * agreeing — an agent that asks for two and needs a tenth of one should get a
 * tenth, and a number the granter typed is a limit they set rather than one
 * they waved through.
 */
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { money, toMinor, when } from '@/lib/format';
import { approve, decline, type Agent, type BudgetRequest } from '@/api';

export const BudgetRequestCard = ({ request, agent }: { request: BudgetRequest; agent: Agent }) => {
  const unit = agent.network.startsWith('hedera:') ? 'ℏ' : 'USDC';
  const [amount, setAmount] = useState(money(agent.network, request.askedMinor).split(' ')[0] ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const answer = async (grant: boolean) => {
    setError(null);
    setBusy(true);
    try {
      if (!grant) {
        await decline(request.id);
        return;
      }
      let grantedMinor: bigint;
      try {
        grantedMinor = toMinor(amount, agent.network);
      } catch {
        setError(`That is not an amount in ${unit}.`);
        return;
      }
      if (grantedMinor <= 0n) {
        setError('Grant more than nothing, or decline.');
        return;
      }
      await approve(request.id, grantedMinor.toString());
    } catch (problem) {
      setError((problem as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="self-center w-full max-w-lg rounded-xl border border-primary/40 bg-primary/5 p-4">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-xs font-medium">
          Asking for {request.asked} more
        </p>
        <span className="shrink-0 text-[11px] text-muted-foreground">{when(request.at)}</span>
      </div>

      {/*
        Its own words, unedited. A paraphrase would be this app deciding what
        the agent meant, in the one place a person is about to commit money on
        the strength of it.
      */}
      <p className="mt-1.5 text-xs leading-relaxed break-words text-muted-foreground">“{request.reason}”</p>

      <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
        It has spent {agent.spent} of {agent.budget}. Granting adds to its limit; it cannot raise this
        itself, and will stop again when the new limit is reached.
      </p>

      <div className="mt-3 flex items-center gap-2">
        <Input
          value={amount}
          inputMode="decimal"
          disabled={busy}
          onChange={(event) => setAmount(event.target.value)}
          className="h-8 w-28 text-xs"
          aria-label={`Amount to grant in ${unit}`}
        />
        <span className="text-[11px] text-muted-foreground">{unit}</span>
        <div className="ml-auto flex gap-2">
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void answer(false)}>
            Decline
          </Button>
          <Button size="sm" disabled={busy} onClick={() => void answer(true)}>
            {busy ? 'Granting…' : 'Grant'}
          </Button>
        </div>
      </div>

      {error ? <p className="mt-2 text-[11px] text-destructive">{error}</p> : null}
    </div>
  );
};
