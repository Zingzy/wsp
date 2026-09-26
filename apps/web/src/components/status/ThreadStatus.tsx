// SPDX-License-Identifier: AGPL-3.0-only
// A thread's status in one slot, the same wherever a thread shows: the kind's
// glyph, its word, the elapsed time of a working turn, a resting thread's age,
// and the crab where the caller has no other place for it. The kind's tone
// inks the whole slot; a slot with none keeps the row's own ink.
import { cn } from "../../lib/utils.js";
import { Crab } from "./Crab.js";
import type { ThreadStatusInput } from "./kinds/index.js";
import { threadStatusOf } from "./threadStatusOf.js";
import { WorkingSince } from "./WorkingSince.js";

/** The slot in a one-line row: 88px, right-aligned, 12px, so times and words line up down a list. */
export const LINE_SLOT_CLASS = "w-22 justify-end text-muted-foreground text-xs";

export function ThreadStatus({
  thread,
  age,
  crab = false,
  className,
}: {
  thread: ThreadStatusInput;
  /** How long ago the thread last moved, as the surface words it; what a resting thread shows. */
  age?: string;
  /** Draw the crab inside the slot, for a surface with no row end of its own to put it at. */
  crab?: boolean;
  className?: string;
}) {
  const kind = threadStatusOf(thread);
  const Glyph = kind.glyph;
  return (
    <span
      data-thread-status={kind.id}
      data-tone={kind.tone}
      className={cn("inline-flex shrink-0 items-center gap-1 whitespace-nowrap tabular-nums", className, kind.tone !== undefined && "font-medium", kind.ink)}
    >
      {Glyph !== undefined && <Glyph aria-hidden className="size-3 shrink-0" />}
      {kind.word !== undefined && <span className={kind.timed ? "sr-only" : undefined}>{kind.word}</span>}
      {kind.timed && <WorkingSince since={thread.startedAt} />}
      {kind.aged && age !== undefined && <span>{age}</span>}
      {crab && kind.crab && <Crab />}
    </span>
  );
}
