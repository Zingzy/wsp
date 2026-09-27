// SPDX-License-Identifier: AGPL-3.0-only
// The thread's actions, one registry: what a thread row's context menu offers
// for one session. Stop takes the runtime's session id, the one
// sessions.interrupt is keyed by; the rename opens the name for editing on
// the row by the thread's own key, and the row sends it. A settle and a
// restore take a root thread with every thread under it; a pin and a snooze
// mark the root alone, which carries its tree with it. Keep this one, on a
// thread one send to several models opened, deletes the copies the others run in.
import { AlarmClockIcon, ArchiveIcon, ArchiveRestoreIcon, CheckIcon, LinkIcon, PencilIcon, PinIcon, PinOffIcon, SquareIcon, Trash2Icon } from "lucide-react";
import type { HarnessCatalog, SessionStatus, ThreadMarks, WorkspaceState } from "@wsp/protocol";
import type { SidebarThreadSnapshot } from "../adapt/index.js";
import { addressLink } from "../protocol/address.js";
import { CLIENT_CANNOT_DELETE, CLIENT_CANNOT_MARK, CLIENT_CANNOT_RESTORE, CLIENT_CANNOT_SETTLE, CLIENT_CANNOT_STOP, NOTHING_READ_TO_SETTLE, THREAD_HAS_NO_ID, THREAD_NOT_RUNNING, THREAD_TREE_WORKING, THREAD_WORDS, threadForgetRefusalFor, threadRenameRefusal } from "./format.js";
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
}

export interface RootTree {
  readonly threadIds: ReadonlyArray<string>;
  readonly working: boolean;
  readonly pinned: boolean;
  readonly settled: boolean;
}

/** One thread as its actions read it: the row, the agent's catalog row for the machine it runs on, and that
 * machine's state, as workspaceTarget does for a workspace row. */
export function threadTarget(
  thread: SidebarThreadSnapshot,
  machine: { catalog: HarnessCatalog | null; state: WorkspaceState; goneWords?: string | undefined },
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
  };
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
];
