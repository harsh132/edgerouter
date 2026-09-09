/**
 * Hiring: a name, a job description, and a limit.
 *
 * Three fields, and the first two are the ordinary ones. The budget is the
 * field that does something irreversible — it mints a name on a chain and
 * commits part of a real wallet — so it says what it will cost in the units the
 * chain uses, and says what is left.
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
import { toMinor } from '@/lib/format';
import { sigilDataUri } from '@/lib/sigil';
import { hire, type State } from '@/api';

const Field = ({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor?: string;
  hint?: React.ReactNode;
  children: React.ReactNode;
}) => (
  <div className="flex flex-col gap-1.5">
    <label htmlFor={htmlFor} className="text-xs text-muted-foreground">
      {label}
    </label>
    {children}
    {hint ? <p className="text-[11px] leading-relaxed text-muted-foreground">{hint}</p> : null}
  </div>
);

export const HireDialog = ({ state, open, onClose }: { state: State; open: boolean; onClose: () => void }) => {
  const [label, setLabel] = useState('');
  const [brief, setBrief] = useState('');
  const [budget, setBudget] = useState('');
  const [model, setModel] = useState(state.models[0] ?? '');
  const [avatar, setAvatar] = useState('');
  const [header, setHeader] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const hedera = state.network.startsWith('hedera:');
  const unit = hedera ? 'ℏ' : 'USDC';

  const submit = async () => {
    setError(null);

    let budgetMinor: bigint;
    try {
      budgetMinor = toMinor(budget, state.network);
    } catch {
      setError(`How much may it spend, in ${unit}?`);
      return;
    }
    if (budgetMinor <= 0n) {
      setError(`How much may it spend, in ${unit}?`);
      return;
    }

    setBusy(true);
    try {
      await hire({
        label,
        brief: brief.trim() || 'A helpful agent.',
        model,
        budgetMinor: budgetMinor.toString(),
        /*
          The sigil is resolved to an image here rather than left for the
          runtime to draw, because the runtime cannot: the library builds its
          output through a DOM element. That split is the right one anyway — the
          page makes the picture, and the only process holding a key writes it.
        */
        avatar: avatar.trim() || sigilDataUri(label.trim().toLowerCase() || 'agent'),
        ...(header.trim() ? { header: header.trim() } : {}),
      });
      setLabel('');
      setBrief('');
      setBudget('');
      setAvatar('');
      setHeader('');
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
          <DialogTitle>Hire an agent</DialogTitle>
          <DialogDescription>
            It gets a name of its own and a budget out of the shared wallet. It never gets a key.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <ProfilePreview label={label} avatar={avatar} header={header} />

          <Field
            label="Name"
            htmlFor="label"
            hint={
              state.naming ? (
                <>
                  Minted as{' '}
                  <span className="font-mono">
                    {label.trim() ? `${label.trim().toLowerCase()}.` : ''}
                    {state.root}
                  </span>{' '}
                  — a real name, which is what makes revoking it work.
                </>
              ) : (
                'Names are off on this chain, so this one is local only.'
              )
            }
          >
            <Input
              id="label"
              value={label}
              placeholder="researcher"
              autoFocus
              onChange={(event) => setLabel(event.target.value)}
            />
          </Field>

          <Field label="What it does" htmlFor="brief">
            <Textarea
              id="brief"
              value={brief}
              placeholder="Researches a topic and reports back in a short paragraph."
              onChange={(event) => setBrief(event.target.value)}
            />
          </Field>

          <Field
            label={`Budget (${unit})`}
            htmlFor="budget"
            hint={`The wallet can spend ${state.spendable}. An agent cannot exceed this, and cannot raise it.`}
          >
            <Input
              id="budget"
              value={budget}
              inputMode="decimal"
              placeholder={hedera ? '0.5' : '0.05'}
              onChange={(event) => setBudget(event.target.value)}
            />
          </Field>

          <Field label="Model">
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
          </Field>

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
            {busy ? 'Minting…' : 'Hire'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
