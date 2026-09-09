/**
 * Changing an agent that already exists.
 *
 * Everything an agent has is editable except the one thing that cannot be: its
 * alias. That alias is half a record on a chain and the node the authority
 * charges, so changing it would mean minting a second name and abandoning the
 * first — a different operation at a different price, not an edit. It is shown,
 * greyed, rather than hidden, because "why can I not change this" is a question
 * worth answering in place.
 *
 * The name is not the alias, and it does change here: nothing is keyed on it,
 * so an agent can be promoted without being re-hired. It costs one transaction,
 * like every other record on this form.
 *
 * Only what actually changed is sent. Each field that reaches ENS is its own
 * transaction, and rewriting an untouched avatar because a description changed
 * would charge the user for nothing.
 */
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { ProfileFields, ProfilePreview } from './profile-fields';
import { money, nameOf, toMinor } from '@/lib/format';
import { sigilDataUri } from '@/lib/sigil';
import { edit, type Agent, type State } from '@/api';

export const EditDialog = ({
  agent,
  state,
  open,
  onClose,
}: {
  agent: Agent;
  state: State;
  open: boolean;
  onClose: () => void;
}) => {
  const hedera = agent.network.startsWith('hedera:');
  const unit = hedera ? 'ℏ' : 'USDC';

  /*
    Seeded from the agent and keyed on it by the caller, so switching agents
    with the dialog open cannot leave one agent's description sitting in
    another's form.
  */
  const [title, setTitle] = useState(agent.title ?? '');
  const [brief, setBrief] = useState(agent.brief);
  const [model, setModel] = useState(agent.model);
  const [budget, setBudget] = useState(money(agent.network, agent.budgetMinor).split(' ')[0] ?? '');
  const [avatar, setAvatar] = useState(agent.avatar ?? '');
  const [header, setHeader] = useState(agent.header ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setError(null);

    let budgetMinor: bigint;
    try {
      budgetMinor = toMinor(budget, agent.network);
    } catch {
      setError(`That is not an amount in ${unit}.`);
      return;
    }
    if (budgetMinor <= 0n) {
      setError(`How much may it spend, in ${unit}?`);
      return;
    }

    /*
      An empty avatar field means "go back to the sigil", not "have no picture".
      Writing the empty string would leave a name whose avatar record exists and
      says nothing — worse than never having set one, because a resolver will
      serve it. The sigil is drawn here for the same reason it is on hiring: the
      runtime cannot draw one.
    */
    const wanted = avatar.trim() || sigilDataUri(agent.label);

    const changes = {
      ...(title.trim() !== (agent.title ?? '') ? { title: title.trim() } : {}),
      ...(brief !== agent.brief ? { brief } : {}),
      ...(model !== agent.model ? { model } : {}),
      ...(budgetMinor.toString() !== agent.budgetMinor ? { budgetMinor: budgetMinor.toString() } : {}),
      ...(wanted !== (agent.avatar ?? '') ? { avatar: wanted } : {}),
      ...(header.trim() !== (agent.header ?? '') ? { header: header.trim() } : {}),
    };

    if (Object.keys(changes).length === 0) {
      onClose();
      return;
    }

    setBusy(true);
    try {
      await edit(agent.id, changes);
      onClose();
    } catch (problem) {
      setError((problem as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit {nameOf(agent)}</DialogTitle>
          <DialogDescription>
            {agent.name
              ? 'Its picture and description are ENS records, so changes are transactions.'
              : 'This agent has no name on chain, so changes stay local.'}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <ProfilePreview label={agent.label} title={title} avatar={avatar} header={header} />

          <div className="flex flex-col gap-1.5">
            <label htmlFor="edit-title" className="text-xs text-muted-foreground">
              Name
            </label>
            <Input
              id="edit-title"
              value={title}
              placeholder={agent.label}
              onChange={(event) => setTitle(event.target.value)}
            />
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              What you call it. Empty means it goes by its alias.
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-xs text-muted-foreground">Alias</label>
            <Input value={agent.name ?? agent.label} disabled className="font-mono text-xs" />
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              Fixed. This is what the authority charges and what revoking clears, so a new one would be a new agent
              rather than a rename.
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="edit-brief" className="text-xs text-muted-foreground">
              What it does
            </label>
            <Textarea id="edit-brief" value={brief} onChange={(event) => setBrief(event.target.value)} />
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="edit-budget" className="text-xs text-muted-foreground">
              Budget ({unit})
            </label>
            <Input
              id="edit-budget"
              value={budget}
              inputMode="decimal"
              onChange={(event) => setBudget(event.target.value)}
            />
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              Already spent {agent.spent}. Raising this re-issues the allowance; it cannot go below what is spent.
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-xs text-muted-foreground">Model</label>
            <Select value={model} onValueChange={setModel}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {state.models.map((option) => (
                  <SelectItem key={option} value={option} className="font-mono text-xs">
                    {option}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <ProfileFields avatar={avatar} header={header} onAvatar={setAvatar} onHeader={setHeader} />

          {error ? (
            <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs leading-relaxed text-destructive">
              {error}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
