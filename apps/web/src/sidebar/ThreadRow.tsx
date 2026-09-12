// SPDX-License-Identifier: AGPL-3.0-only
// One thread's row under its workspace, in the workspace row's grammar. Every
// row in the list is a thread, so no glyph leads it: the title takes the line
// from the row's inset up to a fixed mono time column at the right edge; under
// it the status dot, the agent's mark, and the words workspaceRows gives the
// row, which are the project and who opened the thread on a row a person or
// the command line opened, and the workspace with where it runs on one another
// thread's agent opened. A spawned row that works stands on its dot alone, the
// rule a workspace row already follows, since its indent and the row above say
// the rest; every other state keeps its word. Renaming turns the title into the
// sidebar's one name box in the same slot, opened from the menu or by a
// double-click on the title, so the row keeps its height and its grammar while
// a name is typed.
import { Fragment, type MouseEvent } from "react";
import { agentName } from "@wsp/catalog";
import { THREAD_WORDS } from "../actions/format.js";
import type { SidebarThreadSnapshot } from "../adapt/index.js";
import { HarnessMark } from "../components/chat/HarnessMark.js";
import { SidebarMenuSubButton, SidebarMenuSubItem } from "../components/ui/sidebar.js";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip.js";
import { cn } from "../lib/utils.js";
import { RowNameInput } from "./RowNameInput.js";
import { ROW_META_CLASS, TWO_LINE_ROW_CLASS, threadRowId } from "./rowGrammar.js";
import { isThreadWorking } from "./Sidebar.logic.js";
import { ThreadRowLeadingStatus } from "./ThreadStatusIndicators.js";
import { provenanceLabel, threadMetaWords, threadPill } from "./workspaceRows.js";

export function ThreadRow({
  thread,
  time,
  runs,
  under,
  active,
  renaming,
  saving,
  onSelect,
  onContextMenu,
  onRename,
  onRenameCancel,
  onRenameOpen,
}: {
  thread: SidebarThreadSnapshot;
  time: string;
  /** The workspace this thread runs in and where that workspace runs, which a spawned row names in place of the project. */
  runs: { readonly workspace: string; readonly where: string };
  /** The workspace whose rows this one is drawn under: the row names its own only where the two differ. */
  under: string;
  active: boolean;
  /** The name is being typed on this row: the title slot holds the input instead of the text. */
  renaming: boolean;
  /** That name is on its way to the machine: the field stays exactly as it is and takes no second Enter. */
  saving: boolean;
  onSelect: () => void;
  onContextMenu: (event: MouseEvent<HTMLElement>) => void;
  onRename: (title: string) => void;
  onRenameCancel: () => void;
  /** Opens the box on this row, as the menu's Rename does; absent where the rename is refused, so the title is text alone. */
  onRenameOpen?: (() => void) | undefined;
}) {
  const pill = threadPill(thread);
  // The Idle header can be shut, so the row carries the difference itself, in the title's colour.
  const idle = !isThreadWorking(thread);
  const words = threadMetaWords(thread, runs, under);
  const label = provenanceLabel(thread, words);
  // A spawned row at work says it with the dot alone: the indent already says an agent opened it, and the word
  // would push where it runs out of the 256 px sidebar.
  const saysState = thread.parentThreadId === null || idle;
  return (
    <SidebarMenuSubItem data-thread-item>
      <SidebarMenuSubButton
        // An input may not sit inside a button, so a row being renamed is a plain box with the same grammar.
        render={renaming ? <div /> : <button type="button" />}
        isActive={active}
        data-sidebar-row
        data-row-id={threadRowId(thread.id)}
        {...(renaming ? {} : { onClick: onSelect, onContextMenu })}
        // One step in for a thread another thread's agent opened, drawn under the thread that opened it. One level
        // whatever the depth: the tree is capped at one by default, and a deeper one still reads as under its lead.
        className={cn(TWO_LINE_ROW_CLASS, "w-full", thread.parentThreadId !== null && "pl-5")}
      >
        <span className="flex min-w-0 flex-1 flex-col gap-0.5 leading-tight">
          <span className="flex items-center gap-2">
            {renaming ? (
              <RowNameInput name={thread.title} label={THREAD_WORDS.rename} saving={saving} onRename={onRename} onCancel={onRenameCancel} />
            ) : (
              <span
                data-thread-title
                className={cn("min-w-0 flex-1 truncate", idle && "text-sidebar-muted-foreground")}
                onDoubleClick={onRenameOpen === undefined ? undefined : event => {
                  event.stopPropagation();
                  onRenameOpen();
                }}
              >
                {thread.title}
              </span>
            )}
            <span className={cn(ROW_META_CLASS, "w-[3ch] shrink-0 text-right")}>{time}</span>
          </span>
          <span data-thread-meta className={cn(ROW_META_CLASS, "flex min-w-0 items-center gap-1.5")}>
            <ThreadRowLeadingStatus status={pill} word={saysState} />
            {pill ? <span aria-hidden>·</span> : null}
            <Tooltip>
              <TooltipTrigger render={<span data-thread-provenance aria-label={label} className="inline-flex min-w-0 items-center gap-1 text-sidebar-foreground" />}>
                <HarnessMark harness={thread.harness} label={agentName(thread.harness)} className="size-[13px]" />
                {words.map((word, at) => (
                  <Fragment key={`${at}-${word}`}>
                    <span aria-hidden className="text-[var(--top-row-meta)]">·</span>
                    <span data-thread-word className="truncate text-[var(--top-row-meta)]">{word}</span>
                  </Fragment>
                ))}
              </TooltipTrigger>
              <TooltipPopup side="top">{label}</TooltipPopup>
            </Tooltip>
          </span>
        </span>
      </SidebarMenuSubButton>
    </SidebarMenuSubItem>
  );
}
