/**
 * Choosing what an agent may do, shared by hiring and editing.
 *
 * Checkboxes rather than a text field, and the list comes from the runtime
 * rather than from this file. A permission the server does not enforce would
 * grant nothing while looking exactly like one that does, and a free-text box
 * is a machine for producing those.
 *
 * There is no "select all" and that is deliberate. The convenient version of
 * this control is one that grants everything in one click, including whatever
 * gets added next month — which is a grant nobody made, to a set that did not
 * exist when they made it. Four checkboxes are not a hardship.
 */
import { cn } from '@/lib/utils';
import type { PermissionInfo } from '@/api';

export const PermissionFields = ({
  available,
  granted,
  onChange,
  disabled,
}: {
  available: PermissionInfo[];
  granted: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
}) => {
  const toggle = (name: string) => {
    onChange(granted.includes(name) ? granted.filter((held) => held !== name) : [...granted, name]);
  };

  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-xs text-muted-foreground">Permissions</label>

      <div className="flex flex-col gap-1 rounded-md border p-1">
        {available.map((permission) => {
          const on = granted.includes(permission.name);
          return (
            <label
              key={permission.name}
              className={cn(
                'flex cursor-pointer items-start gap-2.5 rounded-sm px-2 py-1.5 transition-colors',
                !disabled && 'hover:bg-accent/40',
                disabled && 'cursor-not-allowed opacity-60',
              )}
            >
              <input
                type="checkbox"
                checked={on}
                disabled={disabled}
                onChange={() => toggle(permission.name)}
                className="mt-0.5 size-3.5 shrink-0 accent-primary"
              />
              <span className="min-w-0">
                <span className="block text-xs font-medium">{permission.label}</span>
                <span className="block text-[11px] leading-relaxed text-muted-foreground">
                  {permission.detail}
                </span>
              </span>
            </label>
          );
        })}
      </div>

      <p className="text-[11px] leading-relaxed text-muted-foreground">
        Carried in the capability it pays with, not stored beside it — so an agent cannot hold a permission
        it was not granted, and cannot pass on one it does not have.
      </p>
    </div>
  );
};

/** The permissions an agent shows, for somewhere that is not a form. */
export const PermissionList = ({ granted, available }: { granted: string[]; available: PermissionInfo[] }) => {
  if (granted.length === 0) {
    return <p className="text-xs text-muted-foreground">None — it can pay for answers and nothing else.</p>;
  }

  return (
    <div className="flex flex-wrap gap-1.5">
      {granted.map((name) => (
        <span
          key={name}
          title={available.find((permission) => permission.name === name)?.detail ?? name}
          className="rounded-full border bg-muted px-2 py-0.5 font-mono text-[10px] text-muted-foreground"
        >
          {name}
        </span>
      ))}
    </div>
  );
};
