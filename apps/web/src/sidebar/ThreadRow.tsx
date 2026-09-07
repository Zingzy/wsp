// SPDX-License-Identifier: AGPL-3.0-only
// One thread's row under its workspace, in the workspace row's grammar: the
// same leading slot, so the title starts where the name starts; the title
// takes the line up to a fixed mono time column at the right edge; under it
// the status pill, the agent's mark and who opened the thread. Renaming turns
// that title into an input in the same slot, so the row keeps its height and
// its grammar while a name is typed.
import { MessageSquareIcon } from "lucide-react";
import { useEffect, useRef, type KeyboardEvent, type MouseEvent } from "react";
import { agentName } from "@wsp/catalog";
import { THREAD_WORDS } from "../actions/format.js";
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

export function ThreadRow({
  thread,
  time,
  active,
  renaming,
  onSelect,
  onContextMenu,
  onRename,
  onRenameCancel,
}: {
  thread: SidebarThreadSnapshot;
  time: string;
  active: boolean;
  /** The name is being typed on this row: the title slot holds the input instead of the text. */
  renaming: boolean;
  onSelect: () => void;
  onContextMenu: (event: MouseEvent<HTMLElement>) => void;
  onRename: (title: string) => void;
  onRenameCancel: () => void;
}) {
  const pill = threadPill(thread);
  // The Idle header can be shut, so the row carries the difference itself, in the title's colour.
  const idle = !isThreadWorking(thread);
  return (
    <SidebarMenuSubItem data-thread-item>
      <SidebarMenuSubButton
        // An input may not sit inside a button, so a row being renamed is a plain box with the same grammar.
        render={renaming ? <div /> : <button type="button" />}
        isActive={active}
        data-sidebar-row
        data-row-id={`thread:${thread.id}`}
        {...(renaming ? {} : { onClick: onSelect, onContextMenu })}
        className={cn(TWO_LINE_ROW_CLASS, "w-full")}
      >
        <span aria-hidden className={ROW_LEAD_CLASS}>
          <ProjectFavicon src={null} className="size-3.5 opacity-60" fallbackIcon={MessageSquareIcon} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5 leading-tight">
          <span className="flex items-center gap-2">
            {renaming ? (
              <ThreadNameInput title={thread.title} onRename={onRename} onCancel={onRenameCancel} />
            ) : (
              <span data-thread-title className={cn("min-w-0 flex-1 truncate", idle && "text-sidebar-muted-foreground")}>
                {thread.title}
              </span>
            )}
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

/** The title as a field, in the title's own font and size: the name it had, selected, so typing replaces it. Enter
 * names the thread, Escape and leaving it cancel, and a name that is blank or unchanged is a cancel too. Keys stop
 * here rather than reaching the sidebar's own traversal, which reads Home and End. */
function ThreadNameInput({ title, onRename, onCancel }: { title: string; onRename: (title: string) => void; onCancel: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
    ref.current?.select();
  }, []);
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
      return;
    }
    if (event.key !== "Enter") return;
    event.preventDefault();
    const typed = event.currentTarget.value.trim();
    if (typed === "" || typed === title) onCancel();
    else onRename(typed);
  };
  return (
    <input
      ref={ref}
      data-thread-title-input
      aria-label={THREAD_WORDS.rename}
      defaultValue={title}
      spellCheck={false}
      className="min-w-0 flex-1 rounded-sm bg-transparent p-0 text-inherit outline-hidden ring-1 ring-ring/50"
      onKeyDown={onKeyDown}
      onBlur={onCancel}
    />
  );
}
