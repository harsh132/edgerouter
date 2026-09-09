/**
 * The picture half of an agent, shared by hiring and editing.
 *
 * Laid out the way ENS lays out a profile — a banner with the avatar sitting
 * over its bottom edge — because that is where these records are going, and a
 * preview that looks nothing like the place the record is read is not much of a
 * preview.
 *
 * Both fields accept a URL or are left alone. There is no upload: the runtime
 * has nowhere to host a file that anyone else could reach, and an ENS record
 * pointing at a path on someone's laptop is a broken record with extra steps.
 * The default avatar needs no hosting at all, because it carries itself.
 */
import { useMemo } from 'react';
import { Input } from '@/components/ui/input';
import { sigilSvg } from '@/lib/sigil';
import { cn } from '@/lib/utils';

export type Profile = { avatar: string; header: string };

export const ProfilePreview = ({
  label,
  avatar,
  header,
  className,
}: {
  label: string;
  avatar: string;
  header: string;
  className?: string;
}) => {
  const svg = useMemo(() => (avatar ? null : sigilSvg(label || 'agent')), [avatar, label]);

  return (
    <div className={cn('relative overflow-hidden rounded-lg border bg-muted', className)}>
      <div className="h-20 w-full bg-accent/30">
        {header ? <img src={header} alt="" className="size-full object-cover" /> : null}
      </div>

      <div className="flex items-end gap-3 px-3 pb-3">
        <div className="-mt-6 size-14 overflow-hidden rounded-xl border-2 border-card bg-muted [&>svg]:size-full">
          {avatar ? (
            <img src={avatar} alt="" className="size-full object-cover" />
          ) : (
            <span className="block size-full" dangerouslySetInnerHTML={{ __html: svg! }} />
          )}
        </div>
        <div className="min-w-0 pb-0.5 font-mono text-[11px] break-all text-muted-foreground">
          {label.trim() ? label.trim().toLowerCase() : 'unnamed'}
        </div>
      </div>
    </div>
  );
};

export const ProfileFields = ({
  avatar,
  header,
  onAvatar,
  onHeader,
}: {
  avatar: string;
  header: string;
  onAvatar: (value: string) => void;
  onHeader: (value: string) => void;
}) => (
  <>
    <div className="flex flex-col gap-1.5">
      <label htmlFor="avatar" className="text-xs text-muted-foreground">
        Avatar
      </label>
      <Input
        id="avatar"
        value={avatar}
        placeholder="https://… or ipfs://… — leave empty for a sigil"
        onChange={(event) => onAvatar(event.target.value)}
      />
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        Empty draws an Urbit sigil from the name, stored as the image itself so it resolves for anyone, anywhere.
      </p>
    </div>

    <div className="flex flex-col gap-1.5">
      <label htmlFor="header" className="text-xs text-muted-foreground">
        Header
      </label>
      <Input
        id="header"
        value={header}
        placeholder="https://… (optional)"
        onChange={(event) => onHeader(event.target.value)}
      />
    </div>
  </>
);
