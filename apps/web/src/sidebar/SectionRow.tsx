// SPDX-License-Identifier: AGPL-3.0-only
// The one section head the sidebar has, over every thread section, Settled and
// Forwarded ports: the name and its count in parentheses in muted sans, a
// hairline filling the row and a chevron that folds the section. The hairline
// is the one divider the sidebar draws (the owner's ruling of 2026-09-28).
import { ChevronDownIcon } from "lucide-react";
import type { MouseEvent } from "react";
import { cn } from "../lib/utils.js";

export function SectionRow({
  label,
  count,
  collapsed,
  onToggle,
  onContextMenu,
  rowId,
  head,
}: {
  label: string;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
  /** The section's own menu, where the section has one; a row without it keeps the browser's. */
  onContextMenu?: ((event: MouseEvent<HTMLElement>) => void) | undefined;
  /** Where the keyboard's walk over the sidebar's rows stops on this head. */
  rowId?: string | undefined;
  /** What a test and a screenshot step name a thread section's head by. */
  head?: string | undefined;
}) {
  return (
    <button
      type="button"
      {...(rowId === undefined ? {} : { "data-sidebar-row": "", "data-row-id": rowId })}
      {...(head === undefined ? {} : { "data-section-head": head })}
      aria-expanded={!collapsed}
      aria-label={`${label} ${count}`}
      onClick={onToggle}
      {...(onContextMenu === undefined ? {} : { onContextMenu })}
      className="flex h-7 w-full min-w-0 items-center gap-2 rounded-[var(--control-radius)] px-2 text-left text-xs text-sidebar-muted-foreground outline-none transition-colors duration-150 hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="shrink-0 whitespace-nowrap">
        <span data-group-word>{label}</span> <span data-group-count className="tabular-nums">({count})</span>
      </span>
      <span aria-hidden data-section-rule className="h-px min-w-4 flex-1 bg-sidebar-border" />
      <ChevronDownIcon aria-hidden className={cn("size-3.5 shrink-0 transition-transform duration-150", collapsed && "-rotate-90")} />
    </button>
  );
}
