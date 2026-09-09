/**
 * The room: a rail of agents, a thread with one of them, and its money.
 *
 * Layout and selection only — every pane is its own component, so this file
 * stays the one place that answers "what is on screen and which agent is it
 * about". The familiar three-pane shape is deliberate: what is being shown is
 * unfamiliar enough already, and two departures carry it. Every reply states
 * what it cost, and the right-hand panel is a budget rather than a settings
 * page. An agent here is a name on a chain with money attached, and both can be
 * taken away while it is mid-sentence.
 */
import { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { AgentDetail } from '@/components/crew/agent-detail';
import { AgentRail } from '@/components/crew/agent-rail';
import { AgentThread } from '@/components/crew/agent-thread';
import { HireDialog } from '@/components/crew/hire-dialog';
import { useCrew } from './api';

const Waiting = ({ connected }: { connected: boolean }) => (
  <div className="grid h-full place-items-center p-10">
    <div className="flex max-w-sm flex-col items-center gap-3 text-center">
      <h2 className="text-base font-semibold">{connected ? 'Starting…' : 'Waiting for the runtime'}</h2>
      <p className="text-sm leading-relaxed text-muted-foreground">
        Run <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">bun run server</code> in{' '}
        <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">apps/crew</code>. It holds the wallet; this
        page never sees it.
      </p>
    </div>
  </div>
);

const NoAgents = ({ root, onHire }: { root: string; onHire: () => void }) => (
  <div className="grid place-items-center p-10">
    <div className="flex max-w-md flex-col items-center gap-4 text-center">
      <h2 className="text-base font-semibold">No agents yet</h2>
      <p className="text-sm leading-relaxed text-muted-foreground">
        Every agent gets a name under <span className="font-mono">{root}</span> and a budget drawn from one wallet.
        Neither is a label: the name is checked before each payment, and the budget is enforced by the side holding
        the money.
      </p>
      <Button onClick={onHire}>
        <Plus /> Hire the first one
      </Button>
    </div>
  </div>
);

export const App = () => {
  const { state, connected, log } = useCrew();
  const [selected, setSelected] = useState<string | null>(null);
  const [hiring, setHiring] = useState(false);

  const agent = state?.agents.find((candidate) => candidate.id === selected) ?? null;

  /*
    Selection follows the roster rather than being held against it. An agent can
    disappear from under the cursor — revoked from elsewhere, or a runtime that
    restarted — and a pane rendering an id that no longer exists is a blank
    screen with no way back.
  */
  useEffect(() => {
    if (state && !agent && state.agents.length > 0) setSelected(state.agents[0]!.id);
  }, [state, agent]);

  if (!state) return <Waiting connected={connected} />;

  return (
    <div className="grid h-full grid-cols-[17rem_minmax(0,1fr)_20rem]">
      <AgentRail
        state={state}
        selected={selected}
        onSelect={setSelected}
        onHire={() => setHiring(true)}
        {...(log.at(-1) ? { note: log.at(-1)! } : {})}
      />

      {agent ? <AgentThread agent={agent} /> : <NoAgents root={state.root} onHire={() => setHiring(true)} />}

      {agent ? <AgentDetail agent={agent} state={state} /> : <aside className="border-l bg-sidebar" />}

      <HireDialog state={state} open={hiring} onClose={() => setHiring(false)} />
    </div>
  );
};
