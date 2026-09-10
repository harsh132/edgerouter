/**
 * Directories on this machine, and which agents may open them.
 *
 * Two controls that look like one, and are deliberately not: granting a path to
 * the crew is a decision about your computer, and granting it to an agent is a
 * decision about that agent. Keeping them apart is what makes the second cheap
 * to undo — remove a folder here and every agent's hold on it goes with it, in
 * one place, rather than being hunted through a roster.
 *
 * There is no folder picker. A browser file input hands back a file rather than
 * the directory path the runtime needs, and a path someone typed is one they
 * read before committing to it — which for a control that can hand over a whole
 * drive is worth the typing.
 */
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { addProject, removeProject, type Grant, type Project } from '@/api';

/** Whether a path names a whole drive or a home directory. */
const isSweeping = (path: string): boolean =>
  /^[A-Za-z]:[\\/]?$/.test(path.trim()) || path.trim() === '/' || /^([A-Za-z]:)?[\\/]Users[\\/][^\\/]+[\\/]?$/i.test(path.trim());

export const ProjectManager = ({ projects }: { projects: Project[] }) => {
  const [path, setPath] = useState('');
  const [name, setName] = useState('');
  const [mode, setMode] = useState<'read' | 'write'>('read');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const add = async () => {
    setError(null);
    setBusy(true);
    try {
      await addProject({ name: name.trim() || path.trim(), path: path.trim(), mode });
      setPath('');
      setName('');
    } catch (problem) {
      setError((problem as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      {projects.length > 0 ? (
        <div className="flex flex-col gap-1 rounded-md border p-1">
          {projects.map((project) => (
            <div key={project.id} className="flex items-center gap-2 rounded-sm px-2 py-1.5">
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs font-medium">{project.name}</div>
                <div className="truncate font-mono text-[11px] text-muted-foreground">{project.path}</div>
              </div>
              <span className="shrink-0 rounded-full border px-2 py-0.5 text-[10px] text-muted-foreground">
                {project.mode}
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 shrink-0 px-2 text-xs text-destructive hover:text-destructive"
                onClick={() => void removeProject(project.id)}
              >
                Remove
              </Button>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          No folders granted. Agents can only reach their own workspace.
        </p>
      )}

      <div className="flex flex-col gap-2 rounded-md border p-3">
        <Input
          value={path}
          placeholder="C:\\workspace\\my-repo"
          className="font-mono text-xs"
          onChange={(event) => setPath(event.target.value)}
        />
        <div className="flex gap-2">
          <Input
            value={name}
            placeholder="What to call it"
            className="text-xs"
            onChange={(event) => setName(event.target.value)}
          />
          <Select value={mode} onValueChange={(next) => setMode(next as 'read' | 'write')}>
            <SelectTrigger className="w-32 shrink-0">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="read">Read only</SelectItem>
              <SelectItem value="write">Read & write</SelectItem>
            </SelectContent>
          </Select>
          <Button size="sm" disabled={busy || !path.trim()} onClick={() => void add()}>
            {busy ? 'Adding…' : 'Add'}
          </Button>
        </div>

        {/*
          Said before the click, not after. A whole drive is a legitimate thing
          to grant and a bad thing to grant by accident, and the difference is
          entirely whether someone read the path they typed.
        */}
        {isSweeping(path) ? (
          <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[11px] leading-relaxed text-destructive">
            That is your whole {path.trim() === '/' || /^[A-Za-z]:/.test(path.trim()) ? 'drive' : 'home directory'}.
            An agent granted it can open every file inside — except private keys, credentials, and the wallet
            this crew spends from, which are refused everywhere.
          </p>
        ) : null}

        {error ? <p className="text-[11px] text-destructive">{error}</p> : null}
      </div>
    </div>
  );
};

/**
 * Which granted folders one agent may reach.
 *
 * Only meaningful alongside `files:host`; without it the runtime ignores every
 * grant here, so the control says so rather than pretending to work.
 */
export const GrantFields = ({
  projects,
  grants,
  onChange,
  enabled,
}: {
  projects: Project[];
  grants: Grant[];
  onChange: (next: Grant[]) => void;
  enabled: boolean;
}) => {
  if (projects.length === 0) return null;

  const held = (id: string) => grants.find((grant) => grant.projectId === id);

  const toggle = (project: Project) => {
    const current = held(project.id);
    onChange(
      current
        ? grants.filter((grant) => grant.projectId !== project.id)
        : [...grants, { projectId: project.id, mode: project.mode }],
    );
  };

  const setMode = (id: string, mode: 'read' | 'write') =>
    onChange(grants.map((grant) => (grant.projectId === id ? { ...grant, mode } : grant)));

  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-xs text-muted-foreground">Folders</label>

      <div className={cn('flex flex-col gap-1 rounded-md border p-1', !enabled && 'opacity-60')}>
        {projects.map((project) => {
          const grant = held(project.id);
          return (
            <div key={project.id} className="flex items-center gap-2 rounded-sm px-2 py-1.5">
              <input
                type="checkbox"
                checked={Boolean(grant)}
                disabled={!enabled}
                onChange={() => toggle(project)}
                className="size-3.5 shrink-0 accent-primary"
              />
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs">{project.name}</div>
                <div className="truncate font-mono text-[10px] text-muted-foreground">{project.path}</div>
              </div>
              {grant ? (
                <Select
                  value={grant.mode}
                  disabled={!enabled}
                  onValueChange={(next) => setMode(project.id, next as 'read' | 'write')}
                >
                  <SelectTrigger className="h-7 w-28 shrink-0 text-[11px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="read">Read only</SelectItem>
                    {/*
                      Offered only where the folder itself allows it. A grant
                      cannot widen what the project was added as — the runtime
                      takes the narrower of the two anyway, and an option that
                      silently does nothing is worse than no option.
                    */}
                    {project.mode === 'write' ? <SelectItem value="write">Read & write</SelectItem> : null}
                  </SelectContent>
                </Select>
              ) : null}
            </div>
          );
        })}
      </div>

      <p className="text-[11px] leading-relaxed text-muted-foreground">
        {enabled
          ? 'Which folder is private to this machine — the chain records only that it may reach some.'
          : 'Turn on “Reach files on this machine” above for these to take effect.'}
      </p>
    </div>
  );
};
