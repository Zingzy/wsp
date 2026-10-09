// SPDX-License-Identifier: AGPL-3.0-only
// A thread's status as a card's status row: the glyph (the crab while it
// works), the word in the kind's ink, the time at the right, how long the turn
// has run while it works and the age after, and the reason on its own line under
// the word: what it asks, why it failed, what holds it.
import { cn } from "../../lib/utils.js";
import { Crab } from "./Crab.js";
import { FINISHED } from "./kinds/finished.js";
import type { StatusKind, ThreadStatusInput } from "./kinds/index.js";
import { RESTING } from "./kinds/resting.js";
import { threadStatusOf } from "./threadStatusOf.js";
import { useMinuteClock } from "./useMinuteClock.js";
import { WorkingSince } from "./WorkingSince.js";

export function StatusLine({ thread, kind: given, age, reason }: { thread: ThreadStatusInput; kind?: StatusKind; age?: string; reason?: string }) {
  const read = given ?? threadStatusOf(thread);
  // A row says how a resting thread ended, which its slot leaves to the age.
  const kind = read === RESTING ? FINISHED : read;
  const Glyph = kind.glyph;
  return (
    <li data-status-line={kind.id} className="flex min-w-0 flex-col gap-0.5">
      <span className="flex min-w-0 items-center gap-2">
        <span className={cn("flex w-3 shrink-0 justify-center", kind.ink)}>{Glyph === undefined ? kind.crab === true ? <Crab /> : null : <Glyph aria-hidden className="size-3" />}</span>
        <span data-status-line-word className={cn("shrink-0", kind.tone === undefined ? "text-foreground" : "font-medium", kind.ink)}>
          {kind.wordOf === undefined ? kind.word : <TickingWord word={now => kind.wordOf!(thread, now)} />}
        </span>
        <span data-status-line-time className="ms-auto shrink-0 tabular-nums">
          {kind.timed ? <WorkingSince since={thread.startedAt} /> : kind.aged ? age : null}
        </span>
      </span>
      {reason === undefined ? null : (
        <span data-status-reason className="line-clamp-3 min-w-0 ps-5 break-words">
          {reason}
        </span>
      )}
    </li>
  );
}

/** A word read off the minute clock, so a reset's "resets in 14 min" moves while it stands. */
function TickingWord({ word }: { word: (now: number) => string }) {
  return <>{word(useMinuteClock())}</>;
}
