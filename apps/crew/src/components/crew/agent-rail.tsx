/**
 * The rail: everyone you have hired, and the wallet they all spend from.
 */
import { FolderOpen, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { AgentRow } from './agent-row';
import { WalletBar } from './wallet-bar';
import type { State } from '@/api';

export const AgentRail = ({
  state,
  selected,
  onSelect,
  onHire,
  onFolders,
  note,
}: {
  state: State;
  selected: string | null;
  onSelect: (id: string) => void;
  onHire: () => void;
  onFolders: () => void;
  /** The chain's last word — minting, clearing. The only place it is visible. */
  note?: string;
}) => (
  /*
    `bg-card`, not `bg-sidebar`.

    This theme defines --sidebar as exactly --background, so a rail painted with
    its own token is the same colour as the page — and a column holding one
    agent then reads as an empty area where something failed to render rather
    than as a panel. Card is the theme's own raised surface, so the panels
    separate without inventing a colour the palette does not have.
  */
  <aside className="flex min-h-0 flex-col border-r bg-card text-card-foreground">
    <header className="flex items-center gap-2 px-4 py-3">
      <h1 className="flex-1 text-sm font-semibold tracking-tight">Crew</h1>
      <Button
        variant="ghost"
        size="icon"
        className="size-7"
        onClick={onFolders}
        title="Folders agents may reach"
      >
        <FolderOpen />
      </Button>
      <Button variant="ghost" size="icon" className="size-7" onClick={onHire} title="Hire an agent">
        <Plus />
      </Button>
    </header>

    <ScrollArea className="min-h-0 flex-1">
      <div className="flex flex-col gap-0.5 px-2 pb-2">
        {state.agents.length === 0 ? (
          <p className="px-2 py-3 text-xs leading-relaxed text-muted-foreground">
            No agents yet. Each one gets a name on ENS and a budget it cannot raise.
          </p>
        ) : null}

        {state.agents.map((agent) => (
          <AgentRow key={agent.id} agent={agent} active={agent.id === selected} onSelect={() => onSelect(agent.id)} />
        ))}
      </div>
    </ScrollArea>

    <Separator />

    <footer className="px-4 py-3">
      <WalletBar state={state} {...(note ? { note } : {})} />
    </footer>
  </aside>
);
