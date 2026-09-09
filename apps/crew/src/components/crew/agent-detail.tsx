/**
 * One agent's money and identity — the two things that can stop it working.
 *
 * Where a chat app would put settings, because there is nothing to configure
 * here: an agent is a name and a budget, and the only action is to take both
 * away.
 */
import { useMemo, useState } from 'react';
import { Pencil } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { AgentMark } from './agent-mark';
import { FactList } from './fact-list';
import { Ledger } from './ledger';
import { EditDialog } from './edit-dialog';
import { Section } from './section';
import { SpendMeter } from './spend-meter';
import { when } from '@/lib/format';
import { cn } from '@/lib/utils';
import { fire, type Agent, type State } from '@/api';

export const AgentDetail = ({ agent, state }: { agent: Agent; state: State }) => {
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);

  /*
    The tail, newest first. An agent that has run all day has hundreds of steps
    and the interesting ones are the recent ones; the thread is where the whole
    history lives.
  */
  const steps = useMemo(() => agent.tasks.flatMap((task) => task.steps).slice(-14).reverse(), [agent.tasks]);

  const revoked = agent.status === 'revoked';

  return (
    <aside className="flex flex-col gap-5 overflow-y-auto border-l bg-card">
      {/*
        The banner, laid out the way ENS lays one out — the mark sitting over
        its bottom edge — because that is where these two records are read from
        by everyone who is not us.
      */}
      <div className="relative">
        <div className="h-20 w-full bg-accent/30">
          {agent.header ? <img src={agent.header} alt="" className="size-full object-cover" /> : null}
        </div>
        <div className="flex flex-col items-center gap-2 px-5 pb-1 text-center">
          <AgentMark agent={agent} size="lg" className="-mt-7 rounded-xl ring-4 ring-card" />
          <div className="text-sm font-semibold">{agent.label}</div>
        <div
          className={cn(
            'font-mono text-[11px] break-all',
            agent.name ? 'text-muted-foreground' : 'text-muted-foreground/60 italic',
          )}
        >
          {agent.name ?? (state.naming ? 'name could not be minted' : 'names are off on this chain')}
          </div>

          {agent.status !== 'revoked' ? (
            <Button variant="outline" size="sm" className="mt-1 h-7 px-2.5 text-xs" onClick={() => setEditing(true)}>
              <Pencil className="size-3" /> Edit
            </Button>
          ) : null}
        </div>
      </div>

      <div className="flex flex-col gap-5 px-5 pb-5">
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
      </div>

      {editing ? (
        /*
          Keyed on the agent, so switching agents while it is open rebuilds the
          form rather than leaving one agent's description in another's fields.
        */
        <EditDialog key={agent.id} agent={agent} state={state} open onClose={() => setEditing(false)} />
      ) : null}
    </aside>
  );
};
