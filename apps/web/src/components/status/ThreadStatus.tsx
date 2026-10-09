// SPDX-License-Identifier: AGPL-3.0-only
// A thread's status in one slot, the same wherever a thread shows: the kind's
// glyph alone (the crab while it works), its word on the slot's label and on a
// tooltip that adds the time, how long the turn has run or how long ago it
// ended, and a resting thread's age. The kind's tone inks the whole slot; a
// slot with none keeps the row's own ink.
import { cn } from "../../lib/utils.js";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip.js";
import { Crab } from "./Crab.js";
import type { StatusKind, ThreadStatusInput } from "./kinds/index.js";
import { RESTING } from "./kinds/resting.js";
import { threadStatusOf } from "./threadStatusOf.js";
import { useMinuteClock } from "./useMinuteClock.js";
import { WorkingSince } from "./WorkingSince.js";

/** The slot in a one-line row: as wide as the icon, growing for an age, right-aligned, 12px. */
export const LINE_SLOT_CLASS = "min-w-4 justify-end text-muted-foreground text-xs";

export function ThreadStatus({
  thread,
  age,
  settled = false,
  kind: given,
  className,
}: {
  thread: ThreadStatusInput;
  /** How long ago the thread last moved, as the surface words it; what a resting thread shows. */
  age?: string;
  /** The thread sits in the Settled fold, where the design's Settled row reads the age in the row's ink whatever the
   * thread's state: the fold holds what a person has put away, so nothing in it calls for them. */
  settled?: boolean;
  /** A kind no thread reads as, for a tile that holds no thread yet. */
  kind?: StatusKind;
  className?: string;
}) {
  const kind = given ?? (settled ? RESTING : threadStatusOf(thread));
  const slot = cn("inline-flex shrink-0 items-center whitespace-nowrap tabular-nums", className, kind.tone !== undefined && "font-medium", kind.ink);
  const Glyph = kind.glyph;
  if (Glyph === undefined && kind.crab !== true)
    return (
      <span data-thread-status={kind.id} data-tone={kind.tone} className={slot}>
        {kind.aged ? age : null}
      </span>
    );
  return kind.wordOf === undefined ? (
    <Mark thread={thread} kind={kind} word={kind.word ?? ""} age={age} className={slot} />
  ) : (
    <TickingMark thread={thread} kind={kind} word={now => kind.wordOf!(thread, now)} age={age} className={slot} />
  );
}

/** A word read off the minute clock, so a reset's "resets in 14 min" moves while it stands. */
function TickingMark({ word, ...mark }: { thread: ThreadStatusInput; kind: StatusKind; word: (now: number) => string; age: string | undefined; className: string }) {
  return <Mark {...mark} word={word(useMinuteClock())} />;
}

function Mark({ thread, kind, word, age, className }: { thread: ThreadStatusInput; kind: StatusKind; word: string; age: string | undefined; className: string }) {
  const Glyph = kind.glyph;
  return (
    <Tooltip>
      <TooltipTrigger render={<span data-thread-status={kind.id} data-tone={kind.tone} role="img" aria-label={word} className={className} />}>
        {Glyph === undefined ? <Crab /> : <Glyph aria-hidden className="size-3 shrink-0" />}
      </TooltipTrigger>
      <TooltipPopup side="top">
        <span className="tabular-nums">
          {word}
          {kind.timed ? (
            <>
              {" "}
              <WorkingSince since={thread.startedAt} />
            </>
          ) : kind.aged && age !== undefined ? (
            <span className="text-muted-foreground"> {age}</span>
          ) : null}
        </span>
      </TooltipPopup>
    </Tooltip>
  );
}
