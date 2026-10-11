// SPDX-License-Identifier: AGPL-3.0-only
// The thread's actions, one registry: what a thread row's context menu offers
// for one session. Stop takes the runtime's session id, the one
// sessions.interrupt is keyed by; the rename opens the name for editing on
// the row by the thread's own key, and the row sends it. A settle and a
// restore take a root thread with every thread under it; a pin and a snooze
// mark the root alone, which carries its tree with it. Keep this one, on a
// thread one send to several models opened, deletes the copies the others run in.
import { AlarmClockIcon, ArchiveIcon, ArchiveRestoreIcon, CheckIcon, FileTextIcon, HistoryIcon, LinkIcon, MessageSquareIcon, PencilIcon, PinIcon, PinOffIcon, RotateCwIcon, SquareIcon, SquareTerminalIcon, Trash2Icon, Undo2Icon } from "lucide-react";
import { terminalResumeLine, threadMarkdown, threadMessages, type SessionSettleResult, type HarnessCatalog, type SessionEvent, type SessionStatus, type ThreadMarks, type WorkspaceState } from "@wsp/protocol";
import type { SidebarThreadSnapshot } from "../adapt/index.js";
import { addressLink } from "../protocol/address.js";
import { CHILD_WORDS, CLIENT_CANNOT_OPEN, CLIENT_CANNOT_SEND, CLIENT_CANNOT_REWIND, CLIENT_CANNOT_DELETE, CLIENT_CANNOT_MARK, CLIENT_CANNOT_RESTORE, CLIENT_CANNOT_SETTLE, CLIENT_CANNOT_STOP, NOTHING_READ_TO_SETTLE, THREAD_HAS_NO_ID, THREAD_STILL_RUNNING_HERE, THREAD_NOT_RUNNING, THREAD_TREE_WORKING, THREAD_WORDS, threadForgetRefusalFor, threadRenameRefusal, CLIENT_CANNOT_READ } from "./format.js";
import type { ChildPart } from "../components/threads/leadTree.js";
import { addNotice } from "../notices/store.js";
import type { ActionEntry } from "./registry.js";

export interface ThreadTarget {
  /** The fold key of the thread, what a row is keyed by. */
  readonly id: string;
  /** The runtime's thread id, what a link opens; null for a row the runtime stamped none on. */
  readonly threadId: string | null;
  /** The latest turn's runtime session id, what a stop interrupts and what a rename names. */
  readonly sessionId: string;
  readonly workspaceId: string;
  /** The agent the thread runs on: whose store a rename would have to be kept in. */
  readonly harness: string;
  readonly title: string;
  readonly status: SessionStatus;
  /** Whether a turn of this thread ever did work, as the protocol's fold reads the rows; a thread with none is
   * the one a forget removes. */
  readonly ran: boolean;
  /** That agent's catalog row on this workspace's machine, which says whether a name of a person's is kept there;
   * null while no catalog is known, which is no answer either way. */
  readonly catalog: HarnessCatalog | null;
  /** The workspace's state, since the store a rename writes to is on its machine. */
  readonly state: WorkspaceState;
  /** What the runtime said about a machine that is gone, for the refusal that names it. */
  readonly goneWords?: string | undefined;
  /** The tree this thread roots: its fold key and every one under it, whether one of them is working, whether the
   * person pinned the root, and whether the tree sits in the Settled fold. Null on a thread under another, which
   * goes where its root goes. */
  readonly root: RootTree | null;
  /** The workspaces the other threads of this thread's send to several models run in, which Keep this one deletes;
   * empty on a thread opened alone. */
  readonly others: ReadonlyArray<string>;
  /** Set while Undo rewind can still put back the files the thread's last rewind replaced. */
  readonly rewound?: boolean;
  /** The line that goes on with the thread in its agent's own terminal, as the agent's row words it; null where the
   * row names no such command or the agent announced no session yet. */
  readonly terminalLine: string | null;
  /** The computer the thread runs on, by its name, where that is not the one the host runs on: where the line goes. */
  readonly elsewhere?: string | undefined;
}

export interface RootTree {
  readonly threadIds: ReadonlyArray<string>;
  /** The workspaces the tree's threads run in, the copies Delete copies takes. */
  readonly workspaceIds: ReadonlyArray<string>;
  readonly working: boolean;
  readonly pinned: boolean;
  readonly settled: boolean;
}

/** One thread as its actions read it: the row, the agent's catalog row for the machine it runs on, and that
 * machine's state, as workspaceTarget does for a workspace row. */
export function threadTarget(
  thread: SidebarThreadSnapshot,
  machine: { catalog: HarnessCatalog | null; state: WorkspaceState; goneWords?: string | undefined; elsewhere?: string | undefined },
  root: RootTree | null = null,
  others: ReadonlyArray<string> = [],
): ThreadTarget {
  return {
    id: thread.id,
    threadId: thread.threadId,
    sessionId: thread.sessionId,
    workspaceId: thread.workspaceId,
    harness: thread.harness,
    title: thread.title,
    status: thread.status,
    ran: thread.ran,
    catalog: machine.catalog,
    state: machine.state,
    ...(machine.goneWords !== undefined ? { goneWords: machine.goneWords } : {}),
    root,
    others,
    ...(thread.rewound ? { rewound: true } : {}),
    terminalLine: thread.harnessSession === undefined ? null : terminalResumeLine(machine.catalog, thread.harnessSession.folder, thread.harnessSession.id),
    ...(machine.elsewhere !== undefined ? { elsewhere: machine.elsewhere } : {}),
  };
}

/** Copies the line that goes on with the thread in a terminal, and says so where the menu that ran it has closed. */
async function copyTerminalLine(target: ThreadTarget, verbs: ThreadVerbs): Promise<void> {
  if (target.terminalLine === null) return;
  await verbs.copyText(target.terminalLine);
  addNotice({ kind: "done", text: THREAD_WORDS.terminalLineCopied(target.elsewhere), where: target.title });
}

export interface ThreadVerbs {
  readonly stop?: ((sessionId: string) => Promise<void>) | undefined;
  /** Opens the name for editing on the thread's own row, by the thread's fold key, which a turn starting on the
   * thread does not move; the surface that draws the rows puts its own opener here, and a surface with no row to
   * edit leaves it out. */
  readonly rename?: ((threadId: string) => void) | undefined;
  /** Drops a thread no turn ever ran on through the host; the surface that draws the rows leaves it out when its
   * client has no road to the op. */
  readonly forget?: ((thread: { threadId: string; workspaceId: string }) => void) | undefined;
  /** Settles threads by hand through the host, by fold key; left out by a client with no road to the op. */
  readonly settle?: ((threadIds: ReadonlyArray<string>) => Promise<void>) | undefined;
  /** Takes settled threads back out of the fold through the host, by fold key; left out as settle is. */
  readonly restore?: ((threadIds: ReadonlyArray<string>) => Promise<void>) | undefined;
  /** Pins, snoozes or places threads through the host, by fold key; left out as settle is. */
  readonly mark?: ((threadIds: ReadonlyArray<string>, marks: ThreadMarks) => Promise<void>) | undefined;
  /** Opens the snooze's pick of times for a thread, by fold key; the surface that draws the rows puts its own opener
   * here, as it does the rename's. */
  readonly snooze?: ((threadId: string) => void) | undefined;
  /** Asks to delete these workspaces, the copies with them: the surface that draws the rows puts its confirmation
   * here, as it does the rename's opener, and a client with no road to the op leaves it out. */
  readonly keep?: ((workspaceIds: ReadonlyArray<string>) => void) | undefined;
  /** Opens the one confirmation for deleting a settled tree's copies, or every settled tree's. */
  readonly deleteCopies?: ((workspaceIds: ReadonlyArray<string>) => void) | undefined;
  /** Asks to put back the files the thread's last rewind replaced: the surface puts its confirmation here. */
  readonly undoRewind?: ((thread: { threadId: string; workspaceId: string }) => void) | undefined;
  /** Every event the host holds for a workspace, which a thread's copy folds its own out of; left out by a client
   * with no road to the history. */
  readonly readEvents?: ((workspaceId: string) => Promise<SessionEvent[]>) | undefined;
  readonly copyText: (text: string) => Promise<void>;
}

/** The page's own address for one thread: the link a person pastes elsewhere, and the href a row that points at
 * another thread carries. One shape for both, so an address written in the app never differs from one copied out. */
export const threadLink = (target: Pick<ThreadTarget, "workspaceId">, threadId: string): string => addressLink({ workspaceId: target.workspaceId, threadId });

export const threadActions: ReadonlyArray<ActionEntry<ThreadTarget, ThreadVerbs>> = [
  {
    id: "stop",
    group: "state",
    icon: () => SquareIcon,
    title: () => THREAD_WORDS.stop,
    refusal: (target, verbs) => (target.status !== "running" ? THREAD_NOT_RUNNING : verbs.stop === undefined ? CLIENT_CANNOT_STOP : null),
    run: (target, verbs) => verbs.stop?.(target.sessionId),
  },
  {
    id: "settle",
    group: "state",
    icon: () => ArchiveIcon,
    shortcutCommand: "thread.settle",
    applies: target => target.root !== null && !target.root.settled,
    title: () => THREAD_WORDS.settle,
    refusal: (target, verbs) => (verbs.settle === undefined ? CLIENT_CANNOT_SETTLE : target.root?.working ? THREAD_TREE_WORKING : null),
    run: (target, verbs) => (target.root === null ? undefined : verbs.settle?.(target.root.threadIds)),
  },
  {
    id: "restore",
    group: "state",
    icon: () => ArchiveRestoreIcon,
    applies: target => target.root?.settled === true,
    title: () => THREAD_WORDS.restore,
    refusal: (_target, verbs) => (verbs.restore === undefined ? CLIENT_CANNOT_RESTORE : null),
    run: (target, verbs) => (target.root === null ? undefined : verbs.restore?.(target.root.threadIds)),
  },
  {
    id: "rename",
    group: "edit",
    icon: () => PencilIcon,
    title: () => THREAD_WORDS.rename,
    refusal: (target, verbs) =>
      threadRenameRefusal({ catalog: target.catalog, harness: target.harness, state: target.state, goneWords: target.goneWords, hasVerb: verbs.rename !== undefined }),
    run: (target, verbs) => verbs.rename?.(target.id),
  },
  {
    id: "undo-rewind",
    group: "edit",
    icon: () => Undo2Icon,
    applies: target => target.rewound === true && target.threadId !== null,
    title: () => THREAD_WORDS.undoRewind,
    refusal: (_target, verbs) => (verbs.undoRewind === undefined ? CLIENT_CANNOT_REWIND : null),
    run: (target, verbs) => (target.threadId === null ? undefined : verbs.undoRewind?.({ threadId: target.threadId, workspaceId: target.workspaceId })),
  },
  {
    id: "copy-markdown",
    group: "edit",
    icon: () => FileTextIcon,
    title: () => THREAD_WORDS.copyMarkdown,
    refusal: (target, verbs) => (target.threadId === null ? THREAD_HAS_NO_ID : verbs.readEvents === undefined ? CLIENT_CANNOT_READ : null),
    run: async (target, verbs) => {
      if (target.threadId === null || verbs.readEvents === undefined) return;
      await verbs.copyText(threadMarkdown(threadMessages(await verbs.readEvents(target.workspaceId), target.threadId)));
    },
  },
  {
    id: "pin",
    group: "place",
    icon: target => (target.root?.pinned ? PinOffIcon : PinIcon),
    applies: target => target.root !== null && !target.root.settled,
    title: target => (target.root?.pinned ? THREAD_WORDS.unpin : THREAD_WORDS.pin),
    refusal: (_target, verbs) => (verbs.mark === undefined ? CLIENT_CANNOT_MARK : null),
    run: (target, verbs) => verbs.mark?.([target.id], { pinned: !target.root?.pinned }),
  },
  {
    id: "snooze",
    group: "place",
    icon: () => AlarmClockIcon,
    applies: target => target.root !== null && !target.root.settled,
    title: () => THREAD_WORDS.snooze,
    refusal: (_target, verbs) => (verbs.mark === undefined || verbs.snooze === undefined ? CLIENT_CANNOT_MARK : null),
    run: (target, verbs) => verbs.snooze?.(target.id),
  },
  {
    id: "copy-link",
    group: "copy",
    icon: () => LinkIcon,
    title: () => THREAD_WORDS.copyLink,
    refusal: target => (target.threadId === null ? THREAD_HAS_NO_ID : null),
    run: (target, verbs) => (target.threadId === null ? undefined : verbs.copyText(threadLink(target, target.threadId))),
  },
  {
    id: "continue-in-terminal",
    group: "copy",
    icon: () => SquareTerminalIcon,
    applies: target => target.terminalLine !== null,
    title: () => THREAD_WORDS.continueInTerminal,
    // Measured on 2.1.296: a terminal resumes a session wsp's process still holds with no warning, and both write it.
    refusal: target => (target.status === "running" ? THREAD_STILL_RUNNING_HERE : null),
    run: copyTerminalLine,
  },
  {
    id: "stop-continue-in-terminal",
    group: "copy",
    icon: () => SquareTerminalIcon,
    applies: target => target.terminalLine !== null && target.status === "running",
    title: () => THREAD_WORDS.stopAndContinueInTerminal,
    refusal: (_target, verbs) => (verbs.stop === undefined ? CLIENT_CANNOT_STOP : null),
    run: async (target, verbs) => {
      // The copy first: a browser takes a clipboard write only inside the click, which an awaited stop outlasts.
      await copyTerminalLine(target, verbs);
      await verbs.stop?.(target.sessionId);
    },
  },
  {
    id: "keep",
    group: "remove",
    icon: () => CheckIcon,
    destructive: true,
    applies: target => target.others.length > 0,
    title: () => THREAD_WORDS.keep,
    refusal: (_target, verbs) => (verbs.keep === undefined ? CLIENT_CANNOT_DELETE : null),
    run: (target, verbs) => verbs.keep?.(target.others),
  },
  {
    id: "delete-copies",
    group: "remove",
    icon: () => Trash2Icon,
    destructive: true,
    applies: target => target.root !== null && target.root.settled && target.root.workspaceIds.length > 0,
    title: () => THREAD_WORDS.deleteCopies,
    refusal: (_target, verbs) => (verbs.deleteCopies === undefined ? CLIENT_CANNOT_DELETE : null),
    run: (target, verbs) => (target.root === null ? undefined : verbs.deleteCopies?.(target.root.workspaceIds)),
  },
  {
    id: "forget",
    group: "remove",
    icon: () => Trash2Icon,
    destructive: true,
    title: () => THREAD_WORDS.forget,
    refusal: (target, verbs) => threadForgetRefusalFor(target, verbs.forget !== undefined),
    run: (target, verbs) => (target.threadId === null ? undefined : verbs.forget?.({ threadId: target.threadId, workspaceId: target.workspaceId })),
  },
];

/** The Settled fold's own row: what it settles is every live tree whose threads have all been read and are quiet. */
export interface SettledFoldTarget {
  readonly threadIds: ReadonlyArray<string>;
  /** The workspaces every settled tree runs in, the copies the fold's Delete copies takes. */
  readonly workspaceIds: ReadonlyArray<string>;
}

export const settledFoldActions: ReadonlyArray<ActionEntry<SettledFoldTarget, ThreadVerbs>> = [
  {
    id: "settle-read",
    group: "state",
    icon: () => ArchiveIcon,
    title: () => THREAD_WORDS.settleRead,
    refusal: (target, verbs) => (verbs.settle === undefined ? CLIENT_CANNOT_SETTLE : target.threadIds.length === 0 ? NOTHING_READ_TO_SETTLE : null),
    run: (target, verbs) => verbs.settle?.(target.threadIds),
  },
  {
    id: "delete-copies",
    group: "remove",
    icon: () => Trash2Icon,
    destructive: true,
    applies: target => target.workspaceIds.length > 0,
    title: () => THREAD_WORDS.deleteCopies,
    refusal: (_target, verbs) => (verbs.deleteCopies === undefined ? CLIENT_CANNOT_DELETE : null),
    run: (target, verbs) => verbs.deleteCopies?.(target.workspaceIds),
  },
];

/** One child of a lead's tree as its acts read it: a thread, or a subagent of the thread whose session runs it. */
export interface ChildTarget {
  readonly title: string;
  /** The session a stop goes to: the thread's own, or for a subagent the thread's whose agent runs it. */
  readonly sessionId: string;
  readonly harness: string;
  /** The subagent's own id, what a stop of it names; null on a thread. */
  readonly task: string | null;
  readonly part: ChildPart;
  readonly running: boolean;
  /** What a settle of the thread takes, and whether anything in it works, which holds the settle. */
  readonly settles: ReadonlyArray<string>;
  readonly working: boolean;
  /** The thread a restart replaced and the thread that restarts this one, by id; null where there is none. */
  readonly replaces: string | null;
  readonly replacedBy: string | null;
}

export interface ChildVerbs {
  /** Opens the message field on the child's own row; the surface that draws the row puts its opener here. */
  readonly message?: (() => void) | undefined;
  /** Opens a thread in the centre, by its id. */
  readonly open?: ((threadId: string) => void) | undefined;
  readonly stop?: ((sessionId: string) => Promise<void>) | undefined;
  readonly stopTask?: ((task: { sessionId: string; task: string; harness: string; title: string }) => Promise<void>) | undefined;
  readonly settle?: ((threadIds: ReadonlyArray<string>) => Promise<SessionSettleResult | undefined>) | undefined;
  readonly restore?: ((threadIds: ReadonlyArray<string>) => Promise<void>) | undefined;
}

/** Settles threads and says what the host settled and what it left with why, with the way back, which restores what
 * the host settled: every settle the app sends goes through here. A refusal is the store's toast. */
export async function settleSaying(threadIds: ReadonlyArray<string>, verbs: Pick<ChildVerbs, "settle" | "restore">, where?: string): Promise<void> {
  if (verbs.settle === undefined) return;
  const answer = await verbs.settle(threadIds);
  if (answer === undefined) return;
  const whys = [...new Set(answer.left.map(t => t.why))].map(why => CHILD_WORDS.left(answer.left.filter(t => t.why === why).length, why));
  const moved = answer.settled.map(t => t.threadId);
  addNotice({
    kind: moved.length > 0 ? "done" : "note",
    text: [...(moved.length > 0 ? [CHILD_WORDS.settled(moved.length)] : []), ...whys].join(". "),
    ...(where !== undefined ? { where } : {}),
    ...(moved.length > 0 ? { action: { word: CHILD_WORDS.undo, run: () => void verbs.restore?.(moved) } } : {}),
  });
}

const isThread = (target: ChildTarget): boolean => target.task === null;

/** A child's acts, in the order its hover draws them: Send a message, then Stop, Settle or Restore. A subagent takes
 * Stop subagent while it runs and nothing after: no message reaches it but through its lead. */
export const childActions: ReadonlyArray<ActionEntry<ChildTarget, ChildVerbs>> = [
  {
    id: "send",
    group: "talk",
    icon: () => MessageSquareIcon,
    applies: isThread,
    title: () => CHILD_WORDS.send,
    refusal: (_target, verbs) => (verbs.message === undefined ? CLIENT_CANNOT_SEND : null),
    run: (_target, verbs) => verbs.message?.(),
  },
  {
    id: "stop",
    group: "state",
    icon: () => SquareIcon,
    applies: target => isThread(target) && target.part !== "settled" && target.running,
    title: () => THREAD_WORDS.stop,
    refusal: (_target, verbs) => (verbs.stop === undefined ? CLIENT_CANNOT_STOP : null),
    run: (target, verbs) => verbs.stop?.(target.sessionId),
  },
  {
    id: "settle",
    group: "state",
    icon: () => ArchiveIcon,
    applies: target => isThread(target) && target.part !== "settled" && !target.running,
    title: () => THREAD_WORDS.settle,
    refusal: (target, verbs) => (verbs.settle === undefined ? CLIENT_CANNOT_SETTLE : target.working ? THREAD_TREE_WORKING : null),
    run: (target, verbs) => settleSaying(target.settles, verbs, target.title),
  },
  {
    id: "restore",
    group: "state",
    icon: () => ArchiveRestoreIcon,
    applies: target => isThread(target) && target.part === "settled",
    title: () => THREAD_WORDS.restore,
    refusal: (_target, verbs) => (verbs.restore === undefined ? CLIENT_CANNOT_RESTORE : null),
    run: (target, verbs) => verbs.restore?.(target.settles),
  },
  {
    id: "stop-subagent",
    group: "state",
    icon: () => SquareIcon,
    applies: target => !isThread(target) && target.running,
    title: () => CHILD_WORDS.stopSubagent,
    refusal: (_target, verbs) => (verbs.stopTask === undefined ? CLIENT_CANNOT_STOP : null),
    run: (target, verbs) => (target.task === null ? undefined : verbs.stopTask?.({ sessionId: target.sessionId, task: target.task, harness: target.harness, title: target.title })),
  },
  {
    id: "open-replaced",
    group: "open",
    icon: () => HistoryIcon,
    applies: target => target.replaces !== null,
    title: () => CHILD_WORDS.openReplaced,
    refusal: (_target, verbs) => (verbs.open === undefined ? CLIENT_CANNOT_OPEN : null),
    run: (target, verbs) => (target.replaces === null ? undefined : verbs.open?.(target.replaces)),
  },
  {
    id: "open-restart",
    group: "open",
    icon: () => RotateCwIcon,
    applies: target => target.replacedBy !== null,
    title: () => CHILD_WORDS.openRestart,
    refusal: (_target, verbs) => (verbs.open === undefined ? CLIENT_CANNOT_OPEN : null),
    run: (target, verbs) => (target.replacedBy === null ? undefined : verbs.open?.(target.replacedBy)),
  },
];

/** A lead over its tree: every finished thread in it, which Settle N finished takes at once. */
export interface LeadTarget {
  readonly title: string;
  readonly finished: ReadonlyArray<string>;
  /** How many threads those hold with what is under them, what the act's label counts. */
  readonly threads: number;
}

export const leadActions: ReadonlyArray<ActionEntry<LeadTarget, ChildVerbs>> = [
  {
    id: "settle-finished",
    group: "state",
    icon: () => ArchiveIcon,
    applies: target => target.finished.length > 0,
    title: target => CHILD_WORDS.settleFinished(target.threads),
    refusal: (_target, verbs) => (verbs.settle === undefined ? CLIENT_CANNOT_SETTLE : null),
    run: (target, verbs) => settleSaying(target.finished, verbs, target.title),
  },
];
