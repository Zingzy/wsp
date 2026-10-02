// SPDX-License-Identifier: AGPL-3.0-only
// A list of threads as one-line rows under a quiet sans head: the agent's
// mark, the title as the way to the thread, where it runs in muted sans, and
// the one status slot at a fixed width so times and words line up down the
// list. The THREADS block under a reply and a computer's or cloud's threads
// running there are the same list; the caller names the place each row shows.
// A lead's rows add its child's branch with one fact beside it, a note under
// the title, and in the status slot the one act there is to take, where there is.
import { agentName } from "@wsp/catalog";
import { GitBranchIcon } from "lucide-react";
import type { MouseEvent } from "react";
import type { SidebarThreadSnapshot } from "../../adapt/index.js";
import { GROUP_LABEL } from "../../lib/microLabel.js";
import { cn } from "../../lib/utils.js";
import { useStore } from "../../protocol/store.js";
import { HarnessMark } from "../chat/HarnessMark.js";
import { restingAge } from "../status/restingAge.js";
import { LINE_SLOT_CLASS, ThreadStatus } from "../status/ThreadStatus.js";
import { ThreadLink } from "../ThreadLink.js";
import { Button } from "../ui/button.js";

export interface ThreadRowItem {
  readonly thread: SidebarThreadSnapshot;
  /** Where the thread runs as a person reads it: the computer by its name, or the project on a computer's own page. */
  readonly place: string;
  /** The branch the thread's workspace is on, with the one fact about it a person reads beside it. */
  readonly branch?: { readonly name: string; readonly fact: string };
  /** A line under the title, for what the row cannot say in its cells. */
  readonly note?: string;
  /** The one act the row offers, drawn in the status slot in place of the status while there is one to take. */
  readonly act?: { readonly label: string; readonly run: () => void };
}

export function ThreadRows({ label, rows, className }: { label: string; rows: ReadonlyArray<ThreadRowItem>; className?: string }) {
  return (
    <div data-thread-rows className={cn("flex flex-col", className)}>
      <span data-thread-rows-head className={cn(GROUP_LABEL, "flex h-8 items-center px-2 text-muted-foreground")}>
        {label}
      </span>
      {rows.map(row => (
        <ThreadRow key={row.thread.id} {...row} />
      ))}
    </div>
  );
}

/** One thread's line; a press anywhere on it opens the thread, as its title does, except on the act it offers. */
export function ThreadRow({ thread, place, branch, note, act, className }: ThreadRowItem & { className?: string }) {
  const select = useStore(s => s.select);
  const threadId = thread.threadId;
  return (
    <div
      data-thread-row={thread.id}
      className={cn(
        "flex min-w-0 items-center gap-2.5 rounded-[var(--control-radius)] px-2 text-sm transition-colors duration-150 hover:bg-accent",
        note === undefined ? "h-9" : "min-h-12 py-1.5",
        threadId !== null && "cursor-pointer",
        className,
      )}
      {...(threadId === null
        ? {}
        : {
            onClick: (event: MouseEvent<HTMLDivElement>) => {
              if (!(event.target instanceof Element) || event.target.closest("a, button") === null) select(thread.workspaceId, threadId);
            },
          })}
    >
      {/* The muted ink is the wrapper's, so a mark with inks of its own keeps them and a bare one takes the row's quiet ink. */}
      <span className="inline-flex shrink-0 text-muted-foreground">
        <HarnessMark harness={thread.harness} label={agentName(thread.harness)} className="size-[13px]" />
      </span>
      {note === undefined ? (
        <ThreadLink thread={thread} className={cn("min-w-0 flex-1 truncate text-foreground", branch !== undefined && "min-w-28")} />
      ) : (
        <span className="flex min-w-28 flex-1 flex-col">
          <ThreadLink thread={thread} className="min-w-0 truncate text-foreground" />
          <span data-tree-note className="truncate text-[11px] leading-[14px] text-muted-foreground" title={note}>
            {note}
          </span>
        </span>
      )}
      {branch === undefined ? null : (
        <span className="flex min-w-0 max-w-[260px] shrink-0 items-center gap-1 text-xs">
          <GitBranchIcon aria-hidden className="size-3 shrink-0 text-[var(--top-row-meta)]" />
          <span data-tree-branch className="min-w-8 shrink-[100000] truncate text-foreground">
            {branch.name}
          </span>
          <span data-tree-fact className="ms-2 shrink-0 whitespace-nowrap text-muted-foreground">
            {branch.fact}
          </span>
        </span>
      )}
      {place === "" ? null : (
        <span data-thread-place className={cn("max-w-[220px] truncate text-muted-foreground text-xs", branch === undefined ? "shrink-0" : "min-w-0 shrink")}>
          {place}
        </span>
      )}
      {act === undefined ? (
        <ThreadStatus thread={thread} age={restingAge(thread)} crab className={LINE_SLOT_CLASS} />
      ) : (
        <Button type="button" size="xs" variant="outline" className="shrink-0" onClick={act.run}>
          {act.label}
        </Button>
      )}
    </div>
  );
}
