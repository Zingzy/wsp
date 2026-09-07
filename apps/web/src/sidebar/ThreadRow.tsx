// SPDX-License-Identifier: AGPL-3.0-only
// One thread's row under its workspace, in the workspace row's grammar: the
// same leading slot, so the title starts where the name starts; the title
// takes the line up to a fixed mono time column at the right edge; under it
// the status pill, the agent's mark and who opened the thread.
import { MessageSquareIcon } from "lucide-react";
import type { MouseEvent } from "react";
import { agentName } from "@wsp/catalog";
import type { SidebarThreadSnapshot } from "../adapt/index.js";
import { HarnessMark } from "../components/chat/HarnessMark.js";
import { SidebarMenuSubButton, SidebarMenuSubItem } from "../components/ui/sidebar.js";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip.js";
import { cn } from "../lib/utils.js";
import { ProjectFavicon } from "./ProjectFavicon.js";
import { ROW_LEAD_CLASS, ROW_META_CLASS, TWO_LINE_ROW_CLASS } from "./rowGrammar.js";
import { isThreadWorking } from "./Sidebar.logic.js";
import { ThreadRowLeadingStatus } from "./ThreadStatusIndicators.js";
import { openerWord, provenanceLabel, threadPill } from "./workspaceRows.js";

export function ThreadRow({ thread, time, active, onSelect, onContextMenu }: { thread: SidebarThreadSnapshot; time: string; active: boolean; onSelect: () => void; onContextMenu: (event: MouseEvent<HTMLElement>) => void }) {
  const pill = threadPill(thread);
  // The Idle header can be shut, so the row carries the difference itself, in the title's colour.
  const idle = !isThreadWorking(thread);
  return (
    <SidebarMenuSubItem data-thread-item>
      <SidebarMenuSubButton render={<button type="button" />} isActive={active} data-sidebar-row data-row-id={`thread:${thread.id}`} onClick={onSelect} onContextMenu={onContextMenu} className={cn(TWO_LINE_ROW_CLASS, "w-full")}>
        <span aria-hidden className={ROW_LEAD_CLASS}>
          <ProjectFavicon src={null} className="size-3.5 opacity-60" fallbackIcon={MessageSquareIcon} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5 leading-tight">
          <span className="flex items-center gap-2">
            <span data-thread-title className={cn("min-w-0 flex-1 truncate", idle && "text-sidebar-muted-foreground")}>
              {thread.title}
            </span>
            <span className={cn(ROW_META_CLASS, "min-w-[3ch] shrink-0 text-right")}>{time}</span>
          </span>
          <span data-thread-meta className={cn(ROW_META_CLASS, "flex min-w-0 items-center gap-1.5")}>
            <ThreadRowLeadingStatus status={pill} />
            {pill ? <span aria-hidden>·</span> : null}
            <Tooltip>
              <TooltipTrigger render={<span data-thread-provenance aria-label={provenanceLabel(thread)} className="inline-flex min-w-0 items-center gap-1 text-sidebar-foreground" />}>
                <HarnessMark harness={thread.harness} label={agentName(thread.harness)} className="size-[13px]" />
                <span className="truncate text-[var(--top-row-meta)]">{openerWord(thread.startedBy)}</span>
              </TooltipTrigger>
              <TooltipPopup side="top">{provenanceLabel(thread)}</TooltipPopup>
            </Tooltip>
          </span>
        </span>
      </SidebarMenuSubButton>
    </SidebarMenuSubItem>
  );
}
