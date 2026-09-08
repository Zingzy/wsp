// SPDX-License-Identifier: AGPL-3.0-only
// The one section row the sidebar has, over Workspaces and Forwarded ports
// alike: a caps mono zone label, the count of what the row hides while it is
// shut, a chevron that shuts the group, room at the right edge for a group
// action the caller places, and the section's own menu on a right-click where
// the caller has one.
import { ChevronDownIcon } from "lucide-react";
import type { MouseEvent, ReactNode } from "react";
import { SidebarMenuButton } from "../components/ui/sidebar.js";
import { cn } from "../lib/utils.js";
import { ROW_META_CLASS, TOP_ROW_CLASS } from "./rowGrammar.js";

export function SectionRow({
  label,
  count,
  collapsed,
  onToggle,
  action,
  onContextMenu,
}: {
  label: string;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
  action?: ReactNode;
  /** The section's own menu, where the section has one; a row without it keeps the browser's. */
  onContextMenu?: ((event: MouseEvent<HTMLElement>) => void) | undefined;
}) {
  return (
    <>
      <SidebarMenuButton aria-expanded={!collapsed} aria-label={label} className={cn(TOP_ROW_CLASS, action !== undefined && "pe-8")} onClick={onToggle} {...(onContextMenu === undefined ? {} : { onContextMenu })}>
        <span className="font-mono text-[11px] uppercase tracking-[0.12em]">{label}</span>
        {collapsed ? <span className={ROW_META_CLASS}>{count}</span> : null}
        <ChevronDownIcon aria-hidden className={cn("size-3.5 transition-transform duration-150", collapsed && "-rotate-90")} />
      </SidebarMenuButton>
      {action}
    </>
  );
}
