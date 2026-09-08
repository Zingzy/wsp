// SPDX-License-Identifier: AGPL-3.0-only
// The one workspace on screen in Spaces mode, above its threads: the row's
// own line one (the lead slot with the state dot, the name, the state's word
// in muted mono off running) and under it the machine's lines, three or four
// lines once rather than repeated per row. The words come from
// workspaceRows.ts; the block carries the workspace's menu, since in this
// mode no row of its own is on screen to right-click.
import type { MouseEvent } from "react";
import { openContextMenu } from "../actions/contextMenu.js";
import type { ResolvedAction } from "../actions/registry.js";
import type { SidebarProjectSnapshot } from "../adapt/index.js";
import { cn } from "../lib/utils.js";
import { ROW_LEAD_CLASS, ROW_META_CLASS } from "./rowGrammar.js";
import { dotClassForTone, spaceHeaderLines, stateSlotWord } from "./workspaceRows.js";

export function SpaceHeader({
  project,
  cost,
  nowMs,
  actions,
}: {
  project: SidebarProjectSnapshot;
  cost: { readonly rateUsdPerHour: number; readonly accruedUsd: number } | null;
  nowMs: number;
  actions: ReadonlyArray<ResolvedAction>;
}) {
  const state = stateSlotWord(project);
  return (
    <div
      data-space-header
      className="mb-1 flex items-start gap-[var(--sidebar-control-gap)] border-b border-sidebar-border/60 px-2 pt-1.5 pb-2 text-sm"
      onContextMenu={(event: MouseEvent<HTMLElement>) => void openContextMenu(event, actions)}
    >
      <span aria-hidden className={ROW_LEAD_CLASS}>
        <span className={cn("size-2 rounded-full", dotClassForTone(project.indicator.tone), project.indicator.pulse && "animate-status-pulse")} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5 leading-tight">
        <span className="flex items-center gap-2">
          <span data-space-name className="min-w-0 flex-1 truncate font-medium text-sidebar-foreground">
            {project.displayName}
          </span>
          <span data-space-state className={cn(ROW_META_CLASS, "shrink-0 text-right")}>
            {state}
          </span>
        </span>
        {spaceHeaderLines({ project, cost, nowMs }).map(line => (
          <span key={line} data-space-meta className={cn(ROW_META_CLASS, "truncate")} title={line}>
            {line}
          </span>
        ))}
      </span>
    </div>
  );
}
