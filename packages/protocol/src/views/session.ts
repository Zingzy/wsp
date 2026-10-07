// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";
import { openingTitle, titleLine } from "../format.js";
import { threadNeedsYou } from "../thread-state.js";
import { TurnLimit } from "../usage.js";
import { permissionPrompt } from "../wire/helpers.js";

export const SessionStatus = z.enum(["running", "completed", "interrupted", "failed"]);
export type SessionStatus = z.infer<typeof SessionStatus>;

/** Who asked the runtime for the turn: a person in the app, the command line on this computer, or a local agent
 * through the MCP server. All are clients of one host; the sidebar shows which one opened a thread. */
export const SessionOrigin = z.enum(["person", "cli", "agent"]);
export type SessionOrigin = z.infer<typeof SessionOrigin>;

/** Where a thread's title came from, the one rule that decides whether a new one may replace it: seed is the opening
 * turn's own words, here or in the harness's own store, auto the one title the harness was asked for as the first turn
 * started, person a name the person gave the thread here or inside the harness. Auto replaces a seed and nothing else;
 * a person's name is never replaced. */
export const TitleSource = z.enum(["seed", "auto", "person"]);
export type TitleSource = z.infer<typeof TitleSource>;

/** What the agent refused a turn for, where it named a cause wsp knows: the word every door reads to class the
 * failure, since the sentence is the agent's and no door may read a reason out of its words. Adding a cause is an
 * entry here and its road on the client that shows one. */
export const TurnRefusal = z.enum(["sign-in"]);
export type TurnRefusal = z.infer<typeof TurnRefusal>;

/** How a permission prompt ended. allowed and denied are a person's pick. cancelled is the prompt going with its
 * turn: a stop, or a harness that withdrew the question. unanswered is only ever read back off a transcript written
 * while wsp still denied a prompt on a clock of its own; nothing closes one that way now. */
export const PermissionOutcome = z.enum(["allowed", "denied", "unanswered", "cancelled"]);
export type PermissionOutcome = z.infer<typeof PermissionOutcome>;

export const ThreadPrompt = z.object(permissionPrompt);
export type ThreadPrompt = z.infer<typeof ThreadPrompt>;

/** What one thread is stopped behind when the thread itself was asked nothing: the thread whose open prompt its own
 * running call is waiting on, that thread's turn as sessions.answer names it, and the question whole, so the caller
 * draws it and answers it where the person is already reading. A thread carrying this is waiting on a person as
 * surely as one carrying a prompt of its own, and the answer ends both waits at once. */
export const ThreadWaitingOn = z.object({
  threadId: z.string(),
  workspaceId: z.string(),
  sessionId: z.string(),
  /** What that thread is called, by the one title rule foldThreads reads, so the caller names it the way every
   * other surface does rather than by an id nobody recognises. */
  title: z.string(),
  prompt: ThreadPrompt,
});
export type ThreadWaitingOn = z.infer<typeof ThreadWaitingOn>;

/** A turn a computer's threads at once holds back: the computer by its id and its name, and what runs there against
 * its cap as the turn last looked. Read off the live wait and never written down, as waitingOn is, so a host that
 * restarts holds no turn waiting on a slot it no longer counts. */
export const ThreadCapWait = z.object({
  placeId: z.string(),
  place: z.string(),
  running: z.number().int(),
  atOnce: z.number().int(),
});
export type ThreadCapWait = z.infer<typeof ThreadCapWait>;

/** The sidebar's sections a thread's own state files it under; Pinned is a mark of its own and the Settled fold is
 * the settle, so neither is a place a thread is dragged to by this. */
export const ThreadSection = z.enum(["needs-you", "working", "done", "idle"]);
export type ThreadSection = z.infer<typeof ThreadSection>;

/** Where the person dragged a thread, and the state it was in then as the sidebar words it: the placement holds while
 * the thread is still in that state and lapses the moment it moves, so the thread rejoins the section its state
 * files it under. */
export const ThreadPlacement = z.object({ name: ThreadSection, whileState: z.string() });
export type ThreadPlacement = z.infer<typeof ThreadPlacement>;

/** What sessions.mark moves on a thread: a pin set or taken off, a snooze set until a moment or taken off, a
 * placement set or taken off, Resume at reset armed or cancelled. A field left out is left as it is. */
export const ThreadMarks = z
  .object({ pinned: z.boolean().optional(), snoozedUntil: z.number().nullable().optional(), section: ThreadPlacement.nullable().optional(), resumeAtReset: z.boolean().optional() })
  .strict();
export type ThreadMarks = z.infer<typeof ThreadMarks>;

/** Where one of an agent's own subagents stands: the words every agent's adapter maps its own statuses onto, so no
 * reader ever sees one agent's word for it. A subagent is the agent's, run inside the thread's own process, never a
 * thread of wsp's. */
export const SubagentState = z.enum(["running", "done", "failed", "stopped"]);
export type SubagentState = z.infer<typeof SubagentState>;

/** One of a thread's subagents as a listing carries it, read off the transcript's session.subagent rows at answer
 * time and never written on the row: id is the agent's own for it, what a stop names, and parentToolUseId the call
 * that launched it, which its lines carry. A child stays for as long as its start row is in the transcript. */
export const SubagentView = z.object({
  id: z.string(),
  title: z.string(),
  state: SubagentState,
  parentToolUseId: z.string().optional(),
  depth: z.number().int().positive().optional(),
  startedAt: z.number(),
  endedAt: z.number().optional(),
});
export type SubagentView = z.infer<typeof SubagentView>;

export const SessionView = z.object({
  id: z.string(),
  workspaceId: z.string(),
  harness: z.string(),
  status: SessionStatus,
  /** Who opened the thread this row belongs to: a resumed turn takes over the row of the turn it resumes and keeps
   * its answer. Absent on rows written before provenance was recorded; foldThreads reads those as a person's. */
  startedBy: SessionOrigin.optional(),
  claudeSessionId: z.string().optional(),
  /** The thread this turn belongs to, as the runtime stamps its events; rows sharing one are one sidebar thread. */
  threadId: z.string().optional(),
  /** The thread that opened this row's thread, when an agent inside another thread did; absent on every thread a
   * person or the command line opened. rootThreadId is the top of that tree, which the machine cap counts against;
   * a row carrying a parent always carries one. */
  parentThreadId: z.string().optional(),
  rootThreadId: z.string().optional(),
  /** The id one send to several models stamps on each thread it opens, so the threads that send made are drawn and
   * settled together; absent on a thread opened alone. */
  attempt: z.string().optional(),
  /** The turn that opened this row's thread; a resumed turn keeps it, and its own prompt rides its session.start
   * event, so the title every client derives from a row never follows the latest send. */
  prompt: z.string().optional(),
  /** What the harness itself calls this row's session, read from the harness's own store on the machine: the title
   * it generated, or the person's rename inside it. Absent on a harness that keeps none, and until one is read. */
  harnessTitle: z.string().optional(),
  /** Where harnessTitle came from; absent on a row written before provenance was recorded and on one with no title
   * at all, both of which read as seed. */
  titleSource: TitleSource.optional(),
  /** Ms epoch, runtime clock; endedAt is unset while the session runs. */
  startedAt: z.number().optional(),
  endedAt: z.number().optional(),
  /** The folder the harness runs in: the start request's until the harness announces its own. A resume of this
   * session runs here whatever folder it asks for, since the CLI keys the session to it; the shell folder the
   * agent's tool calls move rides the delta events instead. */
  cwd: z.string().optional(),
  /** What the agent refused this turn for, where it named a cause wsp knows, off the turn's own result: a refused
   * turn did none of the work it was asked for, so a row carrying this is a turn that ran nothing. Absent on every
   * turn the agent worked on, however it ended. */
  refusal: TurnRefusal.optional(),
  /** The usage limit that stopped this turn, off its own result; absent on every turn that ended another way. */
  limit: TurnLimit.optional(),
  /** The reset this turn is armed to go on at, ms epoch, where the person pressed Resume at reset; kept on the row
   * so it survives a restart, and cleared when the turn goes on, is cancelled, or the thread moves on without it. */
  resumeAt: z.number().optional(),
  /** What the turns that ran on this row have cost together, as each result reported it; absent where no turn of it
   * has ended and on a harness that reports no figure, which is not the same as nothing spent. It rides the row so
   * a listing can say what a thread spent without anyone reading its transcript. */
  costUsd: z.number().optional(),
  /** What the session runs with, as the harness's own slugs: the start request's model until the harness announces
   * its own; effort as requested, since the CLI never echoes it, and the permission mode the thread is at, which is
   * the start's until an access pick moves it, on the running turn or for the next one. */
  model: z.string().optional(),
  effort: z.string().optional(),
  permissionMode: z.string().optional(),
  contextWindow: z.string().optional(),
  /** The latest turn asked for the model's faster output; absent on a turn that did not. */
  fast: z.boolean().optional(),
  /** The lead of the permission prompt this turn has open and nobody has answered, as askingLine writes it;
   * absent on a turn waiting on nobody. The harness is stopped on the question while it stands, so this is the one
   * fact that says a thread is waiting on the person rather than working. */
  asking: z.string().optional(),
  /** The thread this turn's own running call is stopped behind, when that thread has a prompt open and nobody has
   * answered it. The harness here is working, but nothing it is doing can finish until a person answers somewhere
   * else, so a row carrying this is waiting on the person too. Absent on every turn blocked on nobody. Beside the
   * pid and for the same reason, it is never written down: it is read off two live turns, and a wait written down
   * outlives the question it was on. */
  waitingOn: ThreadWaitingOn.optional(),
  /** Why this thread's agent cannot start or read its own store on that computer now: its config folder was last
   * read leading out of that computer's home, onto it, or into wsp's own. Rides the answer and never the row, as
   * waitingOn does. */
  setupRefusal: z.string().optional(),
  /** The computer's threads at once this turn waits on before it starts; absent on every turn that is not held. */
  capped: ThreadCapWait.optional(),
  /** The process this turn leads on the computer the host runs on, where the turn runs there: the pid the Processes
   * pane heads this thread's tree with. Absent on a turn running on another machine, whose pids are not this
   * computer's, and on a turn that is over. It is never written down: a pid outlives nothing, and the computer is
   * free to hand it to a stranger the moment the turn ends. */
  pid: z.number().int().optional(),
  /** The agent's own subagents of every turn of this row's thread, in the order they started, on the thread's latest
   * row alone. Stamped at answer time off the transcript like pid, never written down. */
  subagents: z.array(SubagentView).optional(),
  /** When a window last showed this row's thread, ms epoch on the host's clock; where no window has since the host
   * began keeping the stamp, that beginning, or the turn's own end where it ended before. The host keeps it per thread and stamps it on every row of the thread
   * as it answers a listing; the row itself never writes it down. */
  readAt: z.number().optional(),
  /** When the person settled this row's thread by hand, kept and stamped as readAt is; absent on a thread nobody
   * settled. Activity after it brings the thread back. */
  settledAt: z.number().optional(),
  /** When the person pinned this row's thread to the top of the sidebar, kept and stamped as readAt is. */
  pinnedAt: z.number().optional(),
  /** When a snooze on this row's thread ends, while it has not: the sidebar leaves the thread out until then. Once
   * the host's clock passes it the listing carries wokeAt instead, and every window is told at that moment. */
  snoozedUntil: z.number().optional(),
  /** When the thread's last snooze ended; the thread reads Done until a read at or after it. */
  wokeAt: z.number().optional(),
  /** The sidebar section the person dragged the thread into, held only while the thread is still as it was then. */
  section: ThreadPlacement.optional(),
  /** When the thread was last rewound, while the files that rewind replaced can still be put back: until the
   * thread's next turn ends. Kept and stamped as readAt is. */
  rewoundAt: z.number().optional(),
});
export type SessionView = z.infer<typeof SessionView>;

/** One sidebar thread as every client lists it: the turns sharing a threadId (a row stamped none is its own),
 * titled by what the harness calls the latest turn's session and by the opening turn's words where it calls it
 * nothing, in the state and times of the latest, with the opening turn's provenance, always filled in. id is the
 * fold key, the runtime's thread id or the lone row's id; sessionId is the latest turn's row id, what a stop
 * interrupts; claudeSessionId is the latest turn's harness id, what a send resumes. */
export const ThreadView = z.object({
  id: z.string(),
  threadId: z.string().optional(),
  workspaceId: z.string(),
  harness: z.string(),
  startedBy: SessionOrigin,
  status: SessionStatus,
  title: z.string(),
  sessionId: z.string(),
  claudeSessionId: z.string().optional(),
  startedAt: z.number().optional(),
  endedAt: z.number().optional(),
  /** The folder the latest turn's harness runs in, as SessionView.cwd; absent when no turn recorded one. */
  cwd: z.string().optional(),
  turns: z.number().int().positive(),
  /** Whether any turn of this thread ever did work, as threadRan reads the rows: false is a launch that never got
   * going, the thread a forget removes. */
  ran: z.boolean(),
  /** The opening turn's parent and root, so a listing draws the tree a root thread spawned without reading rows. */
  parentThreadId: z.string().optional(),
  rootThreadId: z.string().optional(),
  /** The opening turn's attempt, as SessionView.attempt carries it. */
  attempt: z.string().optional(),
  /** The latest turn's open permission prompt, as SessionView.asking carries it; what threadState reads. */
  asking: z.string().optional(),
  /** The thread the latest turn is stopped behind, as SessionView.waitingOn carries it; threadState reads this too,
   * since a thread that cannot move until a question elsewhere is answered is not working. */
  waitingOn: ThreadWaitingOn.optional(),
  /** Why the latest turn's agent cannot start or read its own store there now, as SessionView.setupRefusal carries it. */
  setupRefusal: z.string().optional(),
  /** The cap the latest turn waits on before it starts, as SessionView.capped carries it. */
  capped: ThreadCapWait.optional(),
  /** The usage limit that stopped the latest turn, and the reset it is armed to go on at, as SessionView carries them. */
  limit: TurnLimit.optional(),
  resumeAt: z.number().optional(),
  /** What this thread has cost: its rows' figures added up. Absent where no row of it carries one. */
  costUsd: z.number().optional(),
  /** The latest turn's process on the computer the host runs on, as SessionView.pid carries it. */
  pid: z.number().int().optional(),
  /** The thread's stamps and marks, as SessionView carries them; threadUnread reads readAt and wokeAt. */
  readAt: z.number().optional(),
  settledAt: z.number().optional(),
  pinnedAt: z.number().optional(),
  snoozedUntil: z.number().optional(),
  wokeAt: z.number().optional(),
  section: ThreadPlacement.optional(),
  /** As SessionView.rewoundAt: set while Undo rewind can put the files back. */
  rewoundAt: z.number().optional(),
  /** The access and the fast mode the latest turn ran at, as its row carries them. */
  permissionMode: z.string().optional(),
  fast: z.boolean().optional(),
  /** The agent's own subagents of every turn, as the latest row carries them. */
  subagents: z.array(SubagentView).optional(),
});
export type ThreadView = z.infer<typeof ThreadView>;

/** The thread a turn's row belongs to: the runtime's thread id, else the row's own, since a row the runtime stamped
 * no thread on is a thread of one turn. The one rule for grouping rows by thread. */
export const threadKeyOf = (session: SessionView): string => session.threadId ?? session.id;

/** Whether a turn of these rows ever did any work: one is still working, or one announced a harness session and
 * ended for something other than a refusal. Announcing is not enough on its own, since both CLIs announce their
 * session before they learn they have no sign-in, and a refused turn did none of the work it was asked for. A
 * thread with no such turn never got going, so nothing of it was written down anywhere and dropping it loses none. */
export function threadRan(turns: ReadonlyArray<Pick<SessionView, "claudeSessionId" | "status" | "refusal">>): boolean {
  return turns.some(turn => turn.status === "running" || (turn.claudeSessionId !== undefined && turn.refusal === undefined));
}

/** Folds the session index into threads, in the order each thread's first turn appears. The one place a row from
 * before provenance was recorded is read as a person's; clients print the answer and never decide it. */
export function foldThreads(sessions: ReadonlyArray<SessionView>): ThreadView[] {
  const byThread = new Map<string, SessionView[]>();
  for (const session of sessions) {
    const key = threadKeyOf(session);
    const turns = byThread.get(key);
    if (turns === undefined) byThread.set(key, [session]);
    else turns.push(session);
  }
  return [...byThread].map(([id, turns]) => {
    const first = turns[0]!;
    const latest = turns[turns.length - 1]!;
    const spent = threadCost(turns);
    // The one title rule every client reads: the harness's own name for the session the next send resumes wins, so
    // a rename made inside the harness shows here, and the opening turn's first sentence stands until one is read.
    const title = latest.harnessTitle !== undefined ? titleLine(latest.harnessTitle) : first.prompt !== undefined ? openingTitle(first.prompt) : first.claudeSessionId ?? first.id;
    return {
      id,
      ...(first.threadId !== undefined ? { threadId: first.threadId } : {}),
      workspaceId: first.workspaceId,
      harness: first.harness,
      startedBy: first.startedBy ?? "person",
      status: latest.status,
      title,
      sessionId: latest.id,
      ...(latest.claudeSessionId !== undefined ? { claudeSessionId: latest.claudeSessionId } : {}),
      ...(latest.startedAt !== undefined ? { startedAt: latest.startedAt } : {}),
      ...(latest.endedAt !== undefined ? { endedAt: latest.endedAt } : {}),
      ...(latest.cwd !== undefined ? { cwd: latest.cwd } : {}),
      ...(latest.asking !== undefined ? { asking: latest.asking } : {}),
      ...(latest.waitingOn !== undefined ? { waitingOn: latest.waitingOn } : {}),
      ...(latest.setupRefusal !== undefined ? { setupRefusal: latest.setupRefusal } : {}),
      ...(latest.capped !== undefined ? { capped: latest.capped } : {}),
      ...(latest.limit !== undefined ? { limit: latest.limit } : {}),
      ...(latest.resumeAt !== undefined ? { resumeAt: latest.resumeAt } : {}),
      ...(latest.pid !== undefined ? { pid: latest.pid } : {}),
      ...(latest.readAt !== undefined ? { readAt: latest.readAt } : {}),
      ...(latest.settledAt !== undefined ? { settledAt: latest.settledAt } : {}),
      ...(latest.pinnedAt !== undefined ? { pinnedAt: latest.pinnedAt } : {}),
      ...(latest.snoozedUntil !== undefined ? { snoozedUntil: latest.snoozedUntil } : {}),
      ...(latest.wokeAt !== undefined ? { wokeAt: latest.wokeAt } : {}),
      ...(latest.section !== undefined ? { section: latest.section } : {}),
      ...(latest.rewoundAt !== undefined ? { rewoundAt: latest.rewoundAt } : {}),
      ...(latest.permissionMode !== undefined ? { permissionMode: latest.permissionMode } : {}),
      ...(latest.fast === true ? { fast: true } : {}),
      ...(latest.subagents !== undefined && latest.subagents.length > 0 ? { subagents: latest.subagents } : {}),
      turns: turns.length,
      ran: threadRan(turns),
      ...(first.parentThreadId !== undefined ? { parentThreadId: first.parentThreadId } : {}),
      ...(first.rootThreadId !== undefined ? { rootThreadId: first.rootThreadId } : {}),
      ...(first.attempt !== undefined ? { attempt: first.attempt } : {}),
      ...(spent !== undefined ? { costUsd: spent } : {}),
    };
  });
}

/** How many threads wait on the person, off every row the host lists: the dock's badge and the menu bar read this one
 * count, so the two never disagree. */
export const needsYouCount = (sessions: ReadonlyArray<SessionView>): number => foldThreads(sessions).filter(threadNeedsYou).length;

/** What a thread has cost: the figures its rows carry, added up; undefined where not one of them reported a
 * figure, which no reader may take for nothing spent. */
function threadCost(turns: ReadonlyArray<Pick<SessionView, "costUsd">>): number | undefined {
  const said = turns.filter(turn => turn.costUsd !== undefined);
  return said.length === 0 ? undefined : said.reduce((sum, turn) => sum + turn.costUsd!, 0);
}
