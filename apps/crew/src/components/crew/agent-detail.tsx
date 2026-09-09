/**
 * One agent's money and identity — the two things that can stop it working.
 *
 * Where a chat app would put settings, because there is nothing to configure
 * here: an agent is a name and a budget, and the only action is to take both
 * away.
 */
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { AgentMark } from './agent-mark';
import { FactList } from './fact-list';
import { Ledger } from './ledger';
import { Section } from './section';
import { SpendMeter } from './spend-meter';
import { when } from '@/lib/format';
import { cn } from '@/lib/utils';
import { fire, type Agent, type State } from '@/api';

export const AgentDetail = ({ agent, state }: { agent: Agent; state: State }) => {
  const [busy, setBusy] = useState(false);

  /*
    The tail, newest first. An agent that has run all day has hundreds of steps
    and the interesting ones are the recent ones; the thread is where the whole
    history lives.
  */
  const steps = useMemo(() => agent.tasks.flatMap((task) => task.steps).slice(-14).reverse(), [agent.tasks]);

  const revoked = agent.status === 'revoked';

  return (
    <aside className="flex flex-col gap-5 overflow-y-auto border-l bg-card p-5">
      <div className="flex flex-col items-center gap-2 pt-2 text-center">
        <AgentMark agent={agent} size="lg" />
        <div className="text-sm font-semibold">{agent.label}</div>
        <div
          className={cn(
            'font-mono text-[11px] break-all',
            agent.name ? 'text-muted-foreground' : 'text-muted-foreground/60 italic',
          )}
        >
          {agent.name ?? (state.naming ? 'name could not be minted' : 'names are off on this chain')}
        </div>
      </div>

      <Section title="Budget" className="gap-2.5">
        <SpendMeter
          spentMinor={agent.spentMinor}
          budgetMinor={agent.budgetMinor}
          spent={agent.spent}
          budget={agent.budget}
        />
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          Enforced by the authority holding the wallet, not by the agent. It has no key and cannot raise this.
        </p>
      </Section>

      <Separator />

      <Section title="Identity">
        <FactList
          facts={[
            {
              term: 'pays from',
              value: agent.account ? `${agent.account.slice(0, 12)}…` : '—',
              ...(agent.account ? { title: agent.account } : {}),
            },
            { term: 'model', value: agent.model },
            { term: 'network', value: agent.network },
            { term: 'hired', value: when(agent.createdAt) },
          ]}
        />
      </Section>

      {steps.length > 0 ? (
        <>
          <Separator />
          <Section title="Ledger">
            <Ledger steps={steps} network={agent.network} />
          </Section>
        </>
      ) : null}

      <div className="mt-auto pt-2">
        {revoked ? (
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Its address record was cleared, so the authority refuses to sign for it — including on a restart, and
            including mid-task.
          </p>
        ) : (
          <Button
            variant="outline"
            className="w-full text-destructive hover:bg-destructive/10 hover:text-destructive"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await fire(agent.id);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? 'Revoking…' : agent.name ? 'Revoke on chain' : 'Revoke'}
          </Button>
        )}
      </div>
    </aside>
  );
};
