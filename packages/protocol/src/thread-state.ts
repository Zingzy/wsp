// SPDX-License-Identifier: AGPL-3.0-only
// The one vocabulary for a thread's state, read off the rows the runtime
// writes and nowhere else. The latest turn's own state leads, except while
// that turn is stopped on a question nobody has answered: its own prompt, or
// the prompt of the thread its running call is behind, which stops it just as
// dead. Either way the thread is waiting on the person, which is what a row
// has to say before anything else. A turn that ended and that no window has
// shown since reads Done until one does. Every client renders these words, so the
// sidebar, the pane header and the command line never say two things about
// one thread.
import { askingLine } from "./format.js";
import type { SessionPermissionEvent, SessionStatus, ThreadView } from "./index.js";

export type ThreadState = SessionStatus | "waiting" | "done";

/** Whether the thread's latest turn ended and no window has shown the thread since, off the read stamp the host keeps
 * per thread. A failed turn is not a finish: it reads Failed whether it was seen or not. */
export function threadUnread(thread: Pick<ThreadView, "status" | "endedAt" | "readAt">): boolean {
  if (thread.status !== "completed" && thread.status !== "interrupted") return false;
  return thread.endedAt !== undefined && (thread.readAt === undefined || thread.readAt < thread.endedAt);
}

/** What a thread reads as, from its folded row alone. */
export function threadState(thread: Pick<ThreadView, "status" | "asking" | "waitingOn" | "endedAt" | "readAt">): ThreadState {
  if (thread.asking !== undefined || thread.waitingOn !== undefined) return "waiting";
  return threadUnread(thread) ? "done" : thread.status;
}

/** What a waiting thread is stopped on, in one line: its own open prompt, else the question the thread it is behind
 * has open, named as the answer somebody else's row is holding. Nothing for a thread waiting on nobody. */
export function waitingLine(thread: Pick<ThreadView, "asking" | "waitingOn">): string | undefined {
  if (thread.asking !== undefined) return thread.asking;
  return thread.waitingOn === undefined ? undefined : `${askingLine(thread.waitingOn.prompt)} needs an answer`;
}

const WORDS: Record<ThreadState, string> = {
  waiting: "Needs you",
  running: "Working",
  completed: "Idle",
  interrupted: "Idle",
  failed: "Failed",
  done: "Done",
};

export function threadStateWord(state: ThreadState): string {
  return WORDS[state];
}

/** The word a thread's row shows, the short road every surface takes. */
export function threadWordOf(thread: Pick<ThreadView, "status" | "asking" | "waitingOn" | "endedAt" | "readAt">): string {
  return threadStateWord(threadState(thread));
}

/** What a terminal watching a turn prints the moment that turn stops on a prompt: the thread's own state word, in
 * the lowercase a line of work reads, and under it the lead the app puts the question by. The word comes off the
 * table above, so the terminal and the sidebar cannot say two things about one stopped thread. */
export function needsYouLine(ask: Pick<SessionPermissionEvent, "toolName" | "input" | "detail">): string {
  return `${threadStateWord("waiting").toLowerCase()}: ${askingLine(ask)}`;
}
