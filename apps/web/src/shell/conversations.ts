// SPDX-License-Identifier: AGPL-3.0-only
// The conversations the agents kept in a project's folder outside wsp, as this window holds them: each project's
// list as the host last answered it, the one a project's New thread page holds for its next send, and the confirm a
// conversation another app holds open waits on. In memory alone, one entry per project at most: a reload reads
// the list again and drops a pick nobody sent.
import { create } from "zustand";
import { failureOf } from "../protocol/failure.js";
import { useStore } from "../protocol/store.js";
import { newId, useComposerDraftStore } from "../components/chat/composerDraftStore.js";
import type { ConversationsAnswer, OutsideConversation } from "@wsp/protocol";

/** A conversation held on a project's New thread page: its next send opens the thread on it, or on a copy of it. */
export interface HeldPick {
  readonly row: OutsideConversation;
  readonly copy: boolean;
}

/** The picks a send off a project's New thread page carries, as its composer holds them. */
export interface SendPicks {
  readonly model?: string;
  readonly effort?: string;
  readonly permissionMode?: string;
}

/** A send that waits on the person's answer: its message, the picks it went with, and the composer it came from. */
export interface HeldSend {
  readonly prompt: string;
  readonly picks: SendPicks;
  readonly key: string;
}

/** A conversation another app holds open, waiting on the person's answer: picked off the page, or refused at a send,
 * which kept the message typed. */
export interface OpenConfirm {
  readonly project: string;
  readonly row: OutsideConversation;
  readonly send?: HeldSend;
}

/** A list as the host answered it, or its refusal in two halves; absent while it is read. */
export type ConversationsRead = ConversationsAnswer | { readonly said: string; readonly fix?: string };

interface ConversationsState {
  readonly answers: Readonly<Record<string, ConversationsRead>>;
  readonly held: Readonly<Record<string, HeldPick>>;
  readonly confirm: OpenConfirm | null;
  read(project: string): Promise<void>;
  hold(project: string, pick: HeldPick | null): void;
  ask(confirm: OpenConfirm | null): void;
}

export const isAnswer = (read: ConversationsRead | undefined): read is ConversationsAnswer => read !== undefined && "rows" in read;

export const useConversationsStore = create<ConversationsState>(set => ({
  answers: {},
  held: {},
  confirm: null,
  async read(project) {
    const list = useStore.getState().api?.conversationsList;
    if (list === undefined) return;
    try {
      const answer = await list(project);
      set(s => ({ answers: { ...s.answers, [project]: answer } }));
    } catch (e) {
      const { said, fix } = failureOf(e);
      set(s => ({ answers: { ...s.answers, [project]: { said, ...(fix !== undefined ? { fix } : {}) } } }));
    }
  },
  hold(project, pick) {
    set(s => {
      const { [project]: _was, ...rest } = s.held;
      return { held: pick === null ? rest : { ...rest, [project]: pick } };
    });
  },
  ask(confirm) {
    set({ confirm });
  },
}));

/** What a pick off the page does: a conversation another app holds asks first, any other is held on its project's
 * New thread page, which the person lands on. */
export function pickConversation(project: string, row: OutsideConversation): void {
  if (row.live) {
    useConversationsStore.getState().ask({ project, row });
    return;
  }
  useConversationsStore.getState().hold(project, { row, copy: false });
  useStore.getState().openProjectHome(project);
}

/** A thread opened on a conversation, from a project's New thread page: the host reads the conversation and opens the
 * thread in the folder it ran in, which this window then shows, the page's draft and pick gone. Its refusal comes
 * back in its halves and kind, and the draft is left as the caller holds it. */
export async function sendOn(project: string, pick: HeldPick, send: HeldSend): Promise<ReturnType<typeof failureOf> | null> {
  const { api, select } = useStore.getState();
  const resume = api?.resumeConversation;
  if (resume === undefined) return null;
  try {
    const view = await resume({
      project,
      prompt: send.prompt,
      requestId: newId(),
      harness: pick.row.agent,
      resume: { id: pick.row.id, ...(pick.copy ? { copy: true } : {}) },
      ...(send.picks.model !== undefined ? { model: send.picks.model } : {}),
      ...(send.picks.effort !== undefined ? { effort: send.picks.effort } : {}),
      ...(send.picks.permissionMode !== undefined ? { permissionMode: send.picks.permissionMode } : {}),
    });
    useConversationsStore.getState().hold(project, null);
    useComposerDraftStore.getState().setDraft(send.key, { prompt: "", cursor: 0 });
    select(view.workspaceId, view.threadId ?? null);
    return null;
  } catch (e) {
    return failureOf(e);
  }
}
