// SPDX-License-Identifier: AGPL-3.0-only
// The Conversation tab's timeline, on a hairline rail with a 24 px face on each entry: comments, a bot's notice folded
// to one line, reviews with their verdict and the threads they left with the last lines of code each sits on, a
// thread no review holds, and the commits pushed between two of them as one quiet row. Every body is the restricted
// markdown the description reads, and every comment, review and thread line takes a quiet send to the agent.
import { FileIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { PullRequestItem, PullRequestPage } from "@wsp/protocol";
import { DiffCommentAnnotation } from "../components/diffs/DiffCommentAnnotation.js";
import { Button } from "../components/ui/button.js";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip.js";
import { formatRelativeTimeLabel } from "../lib/timestampFormat.js";
import { cn } from "../lib/utils.js";
import { isMergeCommit } from "./commits.logic.js";
import { conversationOf, hunkTail, reviewVerdict, sentAt, type LineComment, type ReviewThread, type TimelineEntry } from "./conversation.logic.js";
import { AgentMark, Clamped, Face, PrMarkdown, StateWord } from "./parts.js";
import { PR_WORDS, authorName, spacedAgo } from "./words.js";

export type Agent = { id: string; name: string };
/** How an item reaches the agent: when it was sent, or the send, or nothing while it is on its way or where no host
 * serves one. */
export type SendOf = (item: PullRequestItem) => { sent: number } | { send: () => void } | undefined;

const ago = (at: string): string => formatRelativeTimeLabel(at);
const sentWord = (at: number): string => PR_WORDS.sent(spacedAgo(formatRelativeTimeLabel(new Date(at).toISOString())));

/** The quiet send on an item's head, shown on the entry's hover: the agent's mark, the agent named on its tooltip. */
export function SendToAgent({ agent, send, item }: { agent: Agent; send: () => void; item: PullRequestItem }) {
  const label = PR_WORDS.sendToAgent(agent.name);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            data-pr-send={`${item.kind}:${item.id}`}
            aria-label={label}
            className="ml-2 shrink-0 self-center opacity-0 transition-opacity duration-150 group-hover/ev:opacity-100 group-hover/comment:opacity-100 focus-visible:opacity-100 data-[popup-open]:opacity-100"
            onClick={send}
          />
        }
      >
        <AgentMark agent={agent} />
      </TooltipTrigger>
      <TooltipPopup side="top" align="end">
        {label}
      </TooltipPopup>
    </Tooltip>
  );
}

/** What an item's head carries for the agent: when it was sent, before the time, or the send, after it. */
function sendParts(agent: Agent, of: SendOf | undefined, item: PullRequestItem): { sent?: string; send?: ReactNode } {
  const road = of?.(item);
  if (road === undefined) return {};
  return "sent" in road ? { sent: sentWord(road.sent) } : { send: <SendToAgent agent={agent} send={road.send} item={item} /> };
}

function Head({ author, verb, word, at, sent, send }: { author: string; verb?: string; word?: ReactNode; at: string; sent?: string; send?: ReactNode }) {
  return (
    <div data-pr-entry-head className="flex min-h-6 min-w-0 items-baseline gap-2 text-[13px] leading-6">
      <b className="shrink-0 font-medium text-foreground">{authorName(author)}</b>
      {verb === undefined ? null : <span className="min-w-0 truncate text-muted-foreground">{verb}</span>}
      {word === undefined ? null : <span className="ml-0.5 self-center">{word}</span>}
      {sent === undefined ? null : (
        <span data-pr-sent className="ml-auto text-xs whitespace-nowrap text-muted-foreground">
          {sent}
        </span>
      )}
      <span className={cn("font-mono text-xs whitespace-nowrap text-muted-foreground", sent === undefined ? "ml-auto" : "ml-2.5")}>{ago(at)}</span>
      {send}
    </div>
  );
}

function Entry({ kind, face, avatar, quiet = false, children }: { kind: TimelineEntry["kind"]; face: string; avatar?: string | undefined; quiet?: boolean; children: ReactNode }) {
  return (
    <li data-pr-entry={kind} data-quiet={quiet || undefined} className="group/ev relative grid grid-cols-[24px_minmax(0,1fr)] gap-3">
      <Face login={face} size={24} src={avatar} />
      <div className="min-w-0">{children}</div>
    </li>
  );
}

/** One comment on a line, as the diff draws the same comment. */
export function LineCommentRow({ comment, agent, of }: { comment: LineComment; agent: Agent; of: SendOf | undefined }) {
  const parts = sendParts(agent, of, { kind: "reviewComment", id: comment.id });
  return (
    <div data-pr-line-comment={comment.id} className="border-t border-border/50">
      <DiffCommentAnnotation
        kind="comment"
        rangeLabel={comment.line === undefined ? comment.path : `${comment.path}:${comment.line}`}
        text={comment.body}
        onCancel={() => {}}
        onComment={() => {}}
        said={{
          author: authorName(comment.author),
          face: <Face login={comment.author} size={20} src={comment.avatar} />,
          at: ago(comment.at),
          ...(parts.sent !== undefined ? { note: parts.sent } : {}),
          ...(parts.send !== undefined ? { action: parts.send } : {}),
          body: <PrMarkdown text={comment.body} said line />,
        }}
      />
    </div>
  );
}

const LINE_INK = { add: "bg-success/[0.11] text-success", del: "bg-error/[0.11] text-error-foreground", ctx: "" } as const;
const LINE_MARK = { add: "+ ", del: "- ", ctx: "  " } as const;

/** The code a thread sits on: the last lines of its hunk, the commented one lit. */
function ThreadCode({ hunk }: { hunk: string }) {
  const lines = hunkTail(hunk);
  if (lines.length === 0) return null;
  return (
    <div data-pr-thread-code className="border-t border-border/50 bg-[var(--code-background)] py-1 font-mono text-xs leading-[18px]">
      {lines.map((l, i) => (
        <div key={i} data-line={l.kind} className={cn("grid grid-cols-[34px_34px_minmax(0,1fr)]", LINE_INK[l.kind], i === lines.length - 1 && "shadow-[inset_0_0_0_100vmax_color-mix(in_srgb,var(--primary)_9%,transparent)]")}>
          <em className="pr-2 text-right text-muted-foreground not-italic select-none">{l.old ?? ""}</em>
          <em className="pr-2 text-right text-muted-foreground not-italic select-none">{l.new ?? ""}</em>
          <span className="pr-2.5 break-words whitespace-pre-wrap">
            {LINE_MARK[l.kind]}
            {l.text}
          </span>
        </div>
      ))}
    </div>
  );
}

export function ThreadBox({ thread, agent, of }: { thread: ReviewThread; agent: Agent; of: SendOf | undefined }) {
  return (
    <div data-pr-thread={thread.key} data-resolved={thread.resolved || undefined} className="mt-2.5 overflow-hidden rounded-lg border border-border bg-card">
      <div className="flex h-[30px] min-w-0 items-center gap-2 bg-[var(--code-background)] px-2.5 font-mono text-xs">
        <FileIcon aria-hidden className="size-[13px] shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate">{thread.path}</span>
        {thread.line === undefined ? null : <span className="shrink-0 text-muted-foreground">:{thread.line}</span>}
      </div>
      {thread.hunk === undefined ? null : <ThreadCode hunk={thread.hunk} />}
      {thread.comments.map(c => (
        <LineCommentRow key={c.id} comment={c} agent={agent} of={of} />
      ))}
    </div>
  );
}

function PushList({ commits }: { commits: readonly PullRequestPage["commits"][number][] }) {
  return (
    <div className="mt-1.5 flex flex-col gap-[5px]">
      {commits.map(c => (
        <div key={c.oid} data-pr-pushed={c.oid} className="grid grid-cols-[56px_minmax(0,1fr)] items-baseline gap-2.5 text-[13px]">
          <code className="font-mono text-xs text-muted-foreground">{c.oid.slice(0, 7)}</code>
          <span className={cn("truncate", isMergeCommit(c) && "text-muted-foreground")}>{c.subject}</span>
        </div>
      ))}
    </div>
  );
}

/** A bot's notice: one quiet line, its words a press away. */
function BotNotice({ entry, agent, of }: { entry: Extract<TimelineEntry, { kind: "comment" }>; agent: Agent; of: SendOf | undefined }) {
  const [open, setOpen] = useState(false);
  const c = entry.comment;
  return (
    <Entry kind="comment" face={c.author} avatar={c.avatar} quiet>
      <Head
        author={c.author}
        verb={PR_WORDS.leftNotice}
        word={
          <Button type="button" size="xs" variant="ghost" data-pr-notice-toggle onClick={() => setOpen(v => !v)}>
            {open ? PR_WORDS.hide : PR_WORDS.show}
          </Button>
        }
        at={entry.at}
        {...sendParts(agent, of, { kind: "comment", id: c.id })}
      />
      {open ? (
        <div className="mt-1">
          <PrMarkdown text={c.body} said />
        </div>
      ) : null}
    </Entry>
  );
}

export function Timeline({ page, agent, of }: { page: PullRequestPage; agent: Agent; of?: SendOf | undefined }) {
  const entries = conversationOf(page);
  if (entries.length === 0) return null;
  return (
    <ol data-pr-timeline className="relative flex flex-col gap-[22px] pt-0.5 before:absolute before:top-3.5 before:bottom-3.5 before:left-[11.5px] before:w-px before:bg-border before:content-['']">
      {entries.map(entry => {
        switch (entry.kind) {
          case "comment":
            if (entry.comment.bot) return <BotNotice key={entry.key} entry={entry} agent={agent} of={of} />;
            return (
              <Entry key={entry.key} kind="comment" face={entry.comment.author} avatar={entry.comment.avatar}>
                <Head author={entry.comment.author} verb={PR_WORDS.commented} at={entry.at} {...sendParts(agent, of, { kind: "comment", id: entry.comment.id })} />
                <div className="mt-1">
                  <Clamped>
                    <PrMarkdown text={entry.comment.body} said />
                  </Clamped>
                </div>
              </Entry>
            );
          case "review": {
            const verdict = reviewVerdict(entry.review.state);
            const id = entry.review.id;
            return (
              <Entry key={entry.key} kind="review" face={entry.review.author}>
                <Head
                  author={entry.review.author}
                  verb={PR_WORDS.reviewed}
                  word={<StateWord word={verdict.word} tone={verdict.tone} k="pr-verdict" />}
                  at={entry.at}
                  {...(entry.review.body === "" || id === undefined ? {} : sendParts(agent, of, { kind: "review", id }))}
                />
                {entry.review.body === "" ? null : (
                  <div className="mt-1">
                    <Clamped>
                      <PrMarkdown text={entry.review.body} said />
                    </Clamped>
                  </div>
                )}
                {entry.threads.map(t => (
                  <ThreadBox key={t.key} thread={t} agent={agent} of={of} />
                ))}
              </Entry>
            );
          }
          case "thread":
            return (
              <Entry key={entry.key} kind="thread" face={entry.thread.comments[0]!.author} avatar={entry.thread.comments[0]!.avatar}>
                <Head author={entry.thread.comments[0]!.author} verb={PR_WORDS.commentedOnLine} at={entry.at} />
                <ThreadBox thread={entry.thread} agent={agent} of={of} />
              </Entry>
            );
          case "push":
            return (
              <Entry key={entry.key} kind="push" face={entry.authors[0]!}>
                <Head author={entry.authors.map(authorName).join(", ")} verb={PR_WORDS.pushed(entry.commits.length)} at={entry.at} />
                <PushList commits={entry.commits} />
              </Entry>
            );
        }
      })}
    </ol>
  );
}

/** The send road for a page: sent where the page says so, nothing while on its way, else a send through the host. */
export function sendRoad(page: Pick<PullRequestPage, "sent">, sending: readonly PullRequestItem[], send: ((items: readonly PullRequestItem[]) => void) | undefined): SendOf | undefined {
  if (send === undefined) return undefined;
  return item => {
    const at = sentAt(page, item);
    if (at !== undefined) return { sent: at };
    if (sending.some(s => s.kind === item.kind && s.id === item.id)) return undefined;
    return { send: () => send([item]) };
  };
}
