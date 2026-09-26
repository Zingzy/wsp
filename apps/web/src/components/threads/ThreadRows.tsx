// SPDX-License-Identifier: AGPL-3.0-only
// A list of threads as one-line rows under a small caps head: the agent's
// mark, the title as the way to the thread, where it runs in muted sans, and
// the one status slot at a fixed width so times and words line up down the
// list. The THREADS block under a reply and a computer's or cloud's threads
// running there are the same list; the caller names the place each row shows.
import { agentName } from "@wsp/catalog";
import type { SidebarThreadSnapshot } from "../../adapt/index.js";
import { MICRO_LABEL } from "../../lib/microLabel.js";
import { cn } from "../../lib/utils.js";
import { HarnessMark } from "../chat/HarnessMark.js";
import { restingAge } from "../status/restingAge.js";
import { LINE_SLOT_CLASS, ThreadStatus } from "../status/ThreadStatus.js";
import { ThreadLink } from "../ThreadLink.js";

export interface ThreadRowItem {
  readonly thread: SidebarThreadSnapshot;
  /** Where the thread runs as a person reads it: the computer by its name, or the project on a computer's own page. */
  readonly place: string;
}

export function ThreadRows({ label, rows, className }: { label: string; rows: ReadonlyArray<ThreadRowItem>; className?: string }) {
  return (
    <div data-thread-rows className={cn("flex flex-col", className)}>
      <span data-thread-rows-head className={cn(MICRO_LABEL, "flex h-8 items-center px-2 text-muted-foreground")}>
        {label}
      </span>
      {rows.map(({ thread, place }) => (
        <div
          key={thread.id}
          data-thread-row={thread.id}
          className="flex h-9 min-w-0 items-center gap-2.5 rounded-[var(--control-radius)] px-2 text-sm transition-colors duration-150 hover:bg-accent"
        >
          <HarnessMark harness={thread.harness} label={agentName(thread.harness)} className="size-[13px] shrink-0 text-muted-foreground" />
          <ThreadLink thread={thread} className="min-w-0 flex-1 truncate text-foreground" />
          {place === "" ? null : (
            <span data-thread-place className="max-w-[220px] shrink-0 truncate text-muted-foreground text-xs">
              {place}
            </span>
          )}
          <ThreadStatus thread={thread} age={restingAge(thread)} crab className={LINE_SLOT_CLASS} />
        </div>
      ))}
    </div>
  );
}
