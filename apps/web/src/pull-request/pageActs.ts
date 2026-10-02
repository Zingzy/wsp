// SPDX-License-Identifier: AGPL-3.0-only
// The page's acts as the person, through this computer's own signed-in gh: a reply lands on the page as GitHub answered
// with it, a resolve folds or opens its thread once GitHub said so, and a reaction moves at once and goes back where
// the host refuses it. None is offered where the page was not read through this computer's gh, nor where the host
// serves no such act.
import { useMemo, useRef, type Dispatch, type SetStateAction } from "react";
import type { PullRequestPage, PullRequestReaction, ReactionContent } from "@wsp/protocol";
import { noticeFailure } from "../notices/store.js";
import { useStore } from "../protocol/store.js";
import type { PageActs } from "./Conversation.js";

type Reactions = readonly PullRequestReaction[];

/** The reactions with the person's own put on or taken off, as GitHub would count them. */
export function toggled(reactions: Reactions, content: ReactionContent, on: boolean): PullRequestReaction[] {
  const held = reactions.find(r => r.content === content);
  if (on) return held === undefined ? [...reactions, { content, count: 1, mine: true }] : reactions.map(r => (r === held && !r.mine ? { ...r, count: r.count + 1, mine: true } : r));
  if (held === undefined || !held.mine) return [...reactions];
  return held.count <= 1 ? reactions.filter(r => r !== held) : reactions.map(r => (r === held ? { ...r, count: r.count - 1, mine: false } : r));
}

/** The page with one item's reactions given, the item named by its node id. */
export function withReactions(page: PullRequestPage, subject: string, next: (r: Reactions) => PullRequestReaction[]): PullRequestPage {
  const on = <T extends { nodeId?: string | undefined; reactions?: Reactions | undefined }>(items: readonly T[]): T[] => items.map(i => (i.nodeId === subject ? { ...i, reactions: next(i.reactions ?? []) } : i));
  return { ...page, comments: on(page.comments), reviews: on(page.reviews), reviewComments: on(page.reviewComments) };
}

/** The acts where this computer's own signed-in gh read the page, the one they post through; none elsewhere. */
export function usePageActs(workspaceId: string, name: string, postsAsYou: boolean, setPage: Dispatch<SetStateAction<PullRequestPage | null>>): PageActs | undefined {
  const api = useStore(s => s.api);
  const presses = useRef(new Map<string, number>()).current;
  return useMemo(() => {
    if (!postsAsYou) return undefined;
    const reply = api?.pullRequestReply;
    const resolve = api?.pullRequestResolve;
    const react = api?.pullRequestReact;
    const page = (f: (p: PullRequestPage) => PullRequestPage): void => setPage(p => (p === null ? p : f(p)));
    return {
      ...(reply === undefined
        ? {}
        : {
            reply: async (body: string, into?: { replyTo: number; threadId?: string | undefined }) => {
              const done = await reply(workspaceId, { body, ...(into === undefined ? {} : { replyTo: into.replyTo, ...(into.threadId !== undefined ? { threadId: into.threadId } : {}) }) });
              page(p => ({
                ...p,
                ...(done.comment !== undefined ? { comments: [...p.comments, done.comment] } : {}),
                ...(done.reviewComment !== undefined ? { reviewComments: [...p.reviewComments, done.reviewComment] } : {}),
              }));
            },
          }),
      ...(resolve === undefined
        ? {}
        : {
            resolve: async (threadId: string, resolved: boolean) => {
              try {
                const done = await resolve(workspaceId, threadId, resolved);
                page(p => ({ ...p, reviewComments: p.reviewComments.map(c => (c.threadId === done.threadId ? { ...c, resolved: done.resolved } : c)) }));
              } catch (e) {
                noticeFailure(e, said => said, { where: name });
                throw e;
              }
            },
          }),
      ...(react === undefined
        ? {}
        : {
            react: (subject: string, content: ReactionContent, on: boolean) => {
              // Only the latest press on an item may settle it: an older answer, or an older refusal's roll back,
              // would put back a state a later press already moved past.
              const press = (presses.get(subject) ?? 0) + 1;
              presses.set(subject, press);
              const latest = (): boolean => presses.get(subject) === press;
              let before: Reactions | undefined;
              page(p => withReactions(p, subject, r => ((before = r), toggled(r, content, on))));
              react(workspaceId, { subject, content, on }).then(
                done => {
                  if (latest()) page(p => withReactions(p, done.subject, () => [...done.reactions]));
                },
                (e: unknown) => {
                  if (latest() && before !== undefined) {
                    const was = before;
                    page(p => withReactions(p, subject, () => [...was]));
                  }
                  noticeFailure(e, said => said, { where: name });
                },
              );
            },
          }),
    };
  }, [api, name, postsAsYou, presses, setPage, workspaceId]);
}
