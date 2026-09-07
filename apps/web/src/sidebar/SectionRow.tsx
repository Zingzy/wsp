// SPDX-License-Identifier: AGPL-3.0-only
// The one section row the sidebar has, over Workspaces and Forwarded ports
// alike: a caps mono zone label, the count of what the row hides while it is
// shut, a chevron that shuts the group, and room at the right edge for a
// group action the caller places.
import { ChevronDownIcon } from "lucide-react";
import type { ReactNode } from "react";
import { SidebarMenuButton } from "../components/ui/sidebar.js";
import { cn } from "../lib/utils.js";
import { TOP_ROW_CLASS } from "./SearchRow.js";

/** The muted mono meta at the row's right: the count of what it hides while it is shut. */
const TOP_ROW_META_CLASS = "font-mono text-[11px] text-[var(--top-row-meta)]";

export function SectionRow({ label, count, collapsed, onToggle, action }: { label: string; count: number; collapsed: boolean; onToggle: () => void; action?: ReactNode }) {
  return (
    <>
      <SidebarMenuButton aria-expanded={!collapsed} aria-label={label} className={cn(TOP_ROW_CLASS, action !== undefined && "pe-8")} onClick={onToggle}>
        <span className="font-mono text-[11px] uppercase tracking-[0.12em]">{label}</span>
        {collapsed ? <span className={cn(TOP_ROW_META_CLASS, "tabular-nums")}>{count}</span> : null}
        <ChevronDownIcon aria-hidden className={cn("size-3.5 transition-transform duration-150", collapsed && "-rotate-90")} />
      </SidebarMenuButton>
      {action}
    </>
  );
}
