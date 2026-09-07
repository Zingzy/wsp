// SPDX-License-Identifier: AGPL-3.0-only
// The thread's actions, one registry: what a thread row's context menu offers
// for one session. Stop takes the runtime's session id, the one
// sessions.interrupt is keyed by.
import { LinkIcon, PencilIcon, SquareIcon, Trash2Icon } from "lucide-react";
import { threadHash, type SessionStatus } from "@wsp/protocol";
import { CLIENT_CANNOT_STOP, NO_THREAD_DELETE, NO_THREAD_RENAME, THREAD_HAS_NO_ID, THREAD_NOT_RUNNING, THREAD_WORDS } from "./format.js";
import type { ActionEntry } from "./registry.js";

export interface ThreadTarget {
  /** The runtime's thread id, what a link opens; null for a row the runtime stamped none on. */
  readonly threadId: string | null;
  /** The latest turn's runtime session id, what a stop interrupts. */
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly title: string;
  readonly status: SessionStatus;
}

export interface ThreadVerbs {
  readonly stop?: ((sessionId: string) => Promise<void>) | undefined;
  readonly copyText: (text: string) => Promise<void>;
}

/** The page's own address for one thread, the link a person pastes elsewhere. */
export const threadLink = (target: ThreadTarget, threadId: string): string => `${window.location.origin}${window.location.pathname}${threadHash(target.workspaceId, threadId)}`;

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
    id: "rename",
    group: "edit",
    icon: () => PencilIcon,
    title: () => THREAD_WORDS.rename,
    refusal: () => NO_THREAD_RENAME,
    run: () => {},
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
    id: "delete",
    group: "remove",
    icon: () => Trash2Icon,
    destructive: true,
    title: () => THREAD_WORDS.delete,
    refusal: () => NO_THREAD_DELETE,
    run: () => {},
  },
];
