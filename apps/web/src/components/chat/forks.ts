// SPDX-License-Identifier: AGPL-3.0-only
// Fork from here: which messages offer it, what each forks, and the draft a
// fork waits in until its first send. A reply forks its turn and every turn
// before it; a person's message forks the turns before it and opens the draft
// with that message in it. Nothing reaches the host until the send, so a draft
// dismissed leaves nothing anywhere.
import { create } from "zustand";
import type { AttachmentRecord, ForkSource } from "@wsp/protocol";
import type { TimelineEntry, TurnSummary } from "./adapt";
import type { ComposerDraft } from "./composerDraftStore";
import type { ComposerFile } from "./composerFiles";

/** What Fork from here on one message forks. */
export interface ForkPick {
  /** The turn the fork carries through; null on the thread's first message, whose fork carries none. */
  readonly turnId: string | null;
  /** That turn's checkpoint of the files, which a new branch starts from; null where it kept none. */
  readonly checkpoint: string | null;
  /** That checkpoint stands on the commit the turn ended on, where a new branch starts; else it starts at today's HEAD. */
  readonly based: boolean;
  /** A later turn changed files, so this turn's files are not the folder's any more. */
  readonly laterChanged: boolean;
  /** On a person's message, the words and the files it opens the draft with. */
  readonly message?: { readonly text: string; readonly attachments: ReadonlyArray<AttachmentRecord>; readonly requestId?: string };
}

/** The messages Fork from here stands on, by message id, on an agent that forks: each finished turn's last reply, and
 * the person's message that opened a finished turn, which forks the turn before it. A turn forks where it named an
 * anchor or where its agent counts turns; the running turn, a steered message and a reply inside a turn offer none. */
export function forkableMessages(turns: ReadonlyArray<TurnSummary>, entries: ReadonlyArray<TimelineEntry>, agent: { forks: boolean; byCount: boolean }): Map<string, ForkPick> {
  const out = new Map<string, ForkPick>();
  if (!agent.forks) return out;
  const at = new Map(turns.map((t, i) => [t.turnId, i] as const));
  const finished = (t: TurnSummary): boolean => t.state !== "running";
  const cuts = (t: TurnSummary): boolean => agent.byCount || (t.checkpoint?.anchor ?? null) !== null;
  const changedAfter = (i: number): boolean => turns.slice(i + 1).some(t => t.changes !== null && t.changes.files.length > 0);
  const pick = (i: number): Omit<ForkPick, "message"> => ({ turnId: turns[i]!.turnId, checkpoint: turns[i]!.checkpoint?.ref ?? null, based: turns[i]!.checkpoint?.based === true, laterChanged: changedAfter(i) });
  const lastReply = new Map<string, string>();
  const opener = new Map<string, Extract<TimelineEntry, { kind: "message" }>>();
  for (const e of entries) {
    if (e.kind !== "message" || e.message.turnId === null) continue;
    if (e.message.role === "assistant") lastReply.set(e.message.turnId, e.message.id);
    else if (e.message.steered !== true && !opener.has(e.message.turnId)) opener.set(e.message.turnId, e);
  }
  for (const [turnId, id] of lastReply) {
    const i = at.get(turnId);
    if (i !== undefined && finished(turns[i]!) && cuts(turns[i]!)) out.set(id, pick(i));
  }
  for (const [turnId, e] of opener) {
    const i = at.get(turnId);
    if (i === undefined || !finished(turns[i]!)) continue;
    const message = { text: e.message.text, attachments: e.message.attachments ?? [], ...(e.message.requestId !== undefined ? { requestId: e.message.requestId } : {}) };
    if (i === 0) out.set(e.message.id, { turnId: null, checkpoint: null, based: false, laterChanged: false, message });
    else if (cuts(turns[i - 1]!)) out.set(e.message.id, { ...pick(i - 1), message });
  }
  return out;
}

/** A fork's draft, held by the workspace its composer opens in until the send or the dismiss. */
export interface ForkDraft {
  readonly source: { readonly workspaceId: string; readonly threadId: string; readonly title: string };
  readonly fork: ForkSource;
  /** The worktree's branch where the fork goes onto a new one; absent runs it in the source's folder. */
  readonly branch?: string;
  /** What the composer held before a fork off a person's message took it over, which the dismiss puts back. */
  readonly before?: { readonly draft: ComposerDraft; readonly files: ReadonlyArray<ComposerFile> };
}

interface ForkDraftsState {
  readonly drafts: Readonly<Record<string, ForkDraft>>;
  readonly open: (workspaceId: string, draft: ForkDraft) => void;
  readonly drop: (workspaceId: string) => void;
}

export const useForkDrafts = create<ForkDraftsState>()(set => ({
  drafts: {},
  open: (workspaceId, draft) => set(s => ({ drafts: { ...s.drafts, [workspaceId]: draft } })),
  drop: workspaceId =>
    set(s => {
      if (s.drafts[workspaceId] === undefined) return s;
      const { [workspaceId]: _gone, ...rest } = s.drafts;
      return { drafts: rest };
    }),
}));

/** The source a fork from this pick names to the host. */
export const forkSourceOf = (threadId: string, pick: Pick<ForkPick, "turnId">): ForkSource => (pick.turnId === null ? { threadId, at: 0 } : { threadId, turnId: pick.turnId });
