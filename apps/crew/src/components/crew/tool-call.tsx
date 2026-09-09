/**
 * A step where the agent reached for a tool rather than spoke.
 *
 * Rendered as its own thing and not as an empty message. Half an agent's steps
 * are tool calls once it has a workspace, and showing them as blank bubbles
 * makes a working agent look stuck — while showing what it reached for is the
 * more interesting half of the transcript anyway: this is the step where it
 * wrote the file, and it cost exactly what a sentence costs.
 */
import { FileText, FolderOpen, PenLine, Search, Wrench } from 'lucide-react';
import type { ReactNode } from 'react';

const ICONS: Record<string, ReactNode> = {
  read_file: <FileText className="size-3.5" />,
  write_file: <PenLine className="size-3.5" />,
  list_files: <FolderOpen className="size-3.5" />,
  search_files: <Search className="size-3.5" />,
};

/** `write_file` reads as "write file" to anyone; no lookup table needed. */
const spoken = (name: string) => name.replace(/_/g, ' ');

export const ToolCall = ({ tools }: { tools: string[] }) => (
  <div className="flex flex-wrap gap-1.5 self-start">
    {tools.map((name, index) => (
      <span
        key={`${name}-${index}`}
        className="flex items-center gap-1.5 rounded-md border bg-muted/50 px-2.5 py-1 font-mono text-[11px] text-muted-foreground"
      >
        {ICONS[name] ?? <Wrench className="size-3.5" />}
        {spoken(name)}
      </span>
    ))}
  </div>
);
