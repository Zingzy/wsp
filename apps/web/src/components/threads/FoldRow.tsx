// SPDX-License-Identifier: AGPL-3.0-only
// A fold among a lead's children, in a thread row's box: the part's icon in the mark column (the check for Finished,
// the archive Settle wears for Settled, the double chevron for a row that mounts more), the word, then the count and
// the chevron at the right, turning as the sidebar's do.
import { ArchiveIcon, ChevronDownIcon, ChevronsDownIcon, CircleCheckIcon } from "lucide-react";
import type { MouseEvent } from "react";
import { cn } from "../../lib/utils.js";
import { LINE_SLOT_CLASS } from "../status/ThreadStatus.js";

const ICONS = { finished: CircleCheckIcon, settled: ArchiveIcon, more: ChevronsDownIcon } as const;

export function FoldRow({
  fold,
  label,
  count,
  open,
  onToggle,
  onContextMenu,
}: {
  fold: keyof typeof ICONS;
  label: string;
  count?: number;
  /** Whether the fold stands open; absent on a row that only mounts more. */
  open?: boolean;
  onToggle: () => void;
  onContextMenu?: (event: MouseEvent<HTMLElement>) => void;
}) {
  const Icon = ICONS[fold];
  return (
    <button
      type="button"
      data-child-fold={fold}
      {...(open !== undefined ? { "aria-expanded": open } : {})}
      onClick={onToggle}
      {...(onContextMenu !== undefined ? { onContextMenu } : {})}
      className="flex h-9 w-full min-w-0 items-center gap-2.5 rounded-[var(--control-radius)] px-2 text-left text-sm text-muted-foreground outline-none transition-colors duration-150 hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="inline-flex size-3.25 shrink-0 items-center justify-center">
        <Icon aria-hidden data-fold-icon={fold} className="size-3" />
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count === undefined && open === undefined ? null : (
        <span className={cn(LINE_SLOT_CLASS, "inline-flex shrink-0 items-center gap-1 tabular-nums")}>
          {count === undefined ? null : <span data-fold-count>{count}</span>}
          {open === undefined ? null : <ChevronDownIcon aria-hidden data-fold-chevron className={cn("size-3.5 shrink-0 transition-transform duration-150", !open && "-rotate-90")} />}
        </span>
      )}
    </button>
  );
}
