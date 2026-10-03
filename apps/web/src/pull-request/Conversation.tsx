// SPDX-License-Identifier: AGPL-3.0-only
// The Conversation tab's Activity, on a hairline rail with a 24 px face on each entry: comments, a bot's notice folded
// to one line, reviews with their verdict and the threads they left with the last lines of code each sits on, a
// thread no review holds, and one quiet line where commits were pushed between two of them, which opens the Commits
// tab. Every body is the restricted markdown the description reads, and every comment, review and thread line takes a
// quiet send to the agent.
import { ChevronRightIcon, CircleCheckIcon, FileIcon, QuoteIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { PullRequestItem, PullRequestPage, PullRequestReaction, ReactionContent } from "@wsp/protocol";
import { DiffCommentAnnotation } from "../components/diffs/DiffCommentAnnotation.js";
import { Button } from "../components/ui/button.js";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip.js";
import { formatRelativeTimeLabel } from "../lib/timestampFormat.js";
import { cn } from "../lib/utils.js";
import { conversationOf, hunkTail, reviewVerdict, sentAt, type LineComment, type ReviewThread, type TimelineEntry } from "./conversation.logic.js";
import { ReactAdd, ReplyField, Reactions } from "./ThreadActs.js";
import { AgentMark, Hover, Clamped, Face, PrMarkdown, StateWord } from "./parts.js";
import { PR_WORDS, authorName, spacedAgo } from "./words.js";

export type Agent = { id: string; name: string };
/** How an item reaches the agent: when it was sent, or the send, or nothing while it is on its way or where no host
 * serves one. */
export type SendOf = (item: PullRequestItem) => { sent: number } | { send: () => void } | undefined;

/** What the person can do on the page as themselves through the signed-in gh; each absent where no host serves it. */
export interface PageActs {
  /** A reply into a thread under its first comment, or with none a new comment at the conversation's end. */
  readonly reply?: (body: string, into?: { replyTo: number; threadId?: string | undefined }) => Promise<void>;
  readonly resolve?: (threadId: string, resolved: boolean) => Promise<void>;
  /** A reaction put on or taken off an item by its node id, at once and taken back where the host refuses. */
  readonly react?: (subject: string, content: ReactionContent, on: boolean) => void;
}

const ago = (at: string): string => formatRelativeTimeLabel(at);

/** The reactions under an item, the add button where its node id lets the person react. */
type Reactable = { nodeId?: string | undefined; reactions?: readonly PullRequestReaction[] | undefined };

/** How a press reacts on an item, where its node id lets the person. */
function toggleOn(item: Reactable, acts: PageActs | undefined): ((content: ReactionContent) => void) | undefined {
  const react = acts?.react;
  const subject = item.nodeId;
  if (react === undefined || subject === undefined) return undefined;
  return content => react(subject, content, !(item.reactions ?? []).some(r => r.content === content && r.mine));
}

/** The chips under an item, and the head's tools for it: Reply where it takes one, and the add button. */
function itemActs(item: Reactable, acts: PageActs | undefined, k: string, onQuote?: () => void): { chips: ReactNode; tools: ReactNode } {
  const onToggle = toggleOn(item, acts);
  return {
    chips: <Reactions k={k} reactions={item.reactions ?? []} {...(onToggle === undefined ? {} : { onToggle })} />,
    tools:
      onQuote === undefined && onToggle === undefined ? null : (
        <>
          {onQuote === undefined ? null : (
            <Hover words={PR_WORDS.quoteReply}>
              <Button type="button" size="icon-xs" variant="ghost" data-pr-quote={k} aria-label={PR_WORDS.quoteReply} className="ml-1 self-center" onClick={onQuote}>
                <QuoteIcon aria-hidden className="size-[13px]" />
              </Button>
            </Hover>
          )}
          {onToggle === undefined ? null : <ReactAdd reactions={item.reactions ?? []} onToggle={onToggle} />}
        </>
      ),
  };
}

/** A comment or a review in the conversation: its head with Quote reply and the add button on a hover, its body and its
 * chips. GitHub has no nesting in the conversation, so an answer is a quote in the comment box at Activity's foot. */
function Said({ kind, face, avatar, head, body, after, item, quote, acts, k }: { kind: "comment" | "review"; face: string; avatar?: string | undefined; head: (tools: ReactNode) => ReactNode; body: ReactNode; /** A review's threads, after its body. */ after?: ReactNode; item: Reactable; quote?: (() => void) | undefined; acts: PageActs | undefined; k: string }) {
  const { chips, tools } = itemActs(item, acts, k, acts?.reply === undefined ? undefined : quote);
  return (
    <Entry kind={kind} face={face} avatar={avatar}>
      {head(tools)}
      {body}
      {chips}
      {after}
    </Entry>
  );
}
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

function Head({ author, verb, word, at, sent, send, tools, go = false }: { author: string; verb?: string; word?: ReactNode; at: string; sent?: string; send?: ReactNode; /** Reply and the add button, before the send. */ tools?: ReactNode; /** The line opens somewhere: a chevron after the verb. */ go?: boolean }) {
  return (
    <div data-pr-entry-head className="flex min-h-6 min-w-0 items-baseline gap-2 text-[13px] leading-6">
      <b className="shrink-0 font-medium text-foreground">{authorName(author)}</b>
      {verb === undefined ? null : (
        <span data-verb className="min-w-0 truncate text-muted-foreground">
          {verb}
        </span>
      )}
      {go ? <ChevronRightIcon aria-hidden className="-ml-0.5 size-[13px] shrink-0 self-center text-muted-foreground/70" /> : null}
      {word === undefined ? null : <span className="ml-0.5 self-center">{word}</span>}
      {sent === undefined ? null : (
        <span data-pr-sent className="ml-auto text-xs whitespace-nowrap text-muted-foreground">
          {sent}
        </span>
      )}
      <span data-pr-time className={cn("inline-flex items-center self-center font-mono text-xs whitespace-nowrap text-muted-foreground", sent === undefined ? "ml-auto" : "ml-2.5")}>
        {/* The hover's acts open just left of the time and take no width at rest, so every head's time ends on one
            edge; the pane stands on the Mac's glass, so they push the words aside rather than cover them. */}
        {(tools ?? null) === null && (send ?? null) === null ? null : (
          <span data-pr-head-acts className="inline-flex w-0 items-center overflow-hidden font-sans opacity-0 transition-opacity duration-150 group-hover/ev:mr-1.5 group-hover/ev:w-auto group-hover/ev:opacity-100 focus-within:mr-1.5 focus-within:w-auto focus-within:opacity-100 has-[[data-popup-open]]:mr-1.5 has-[[data-popup-open]]:w-auto has-[[data-popup-open]]:opacity-100">
            {tools}
            {send}
          </span>
        )}
        {ago(at)}
      </span>
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
export function LineCommentRow({ comment, agent, of, acts }: { comment: LineComment; agent: Agent; of: SendOf | undefined; acts?: PageActs | undefined }) {
  const parts = sendParts(agent, of, { kind: "reviewComment", id: comment.id });
  const { chips, tools } = itemActs(comment, acts, `reviewComment:${comment.id}`);
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
          ...(parts.send !== undefined || tools !== null
            ? {
                action: (
                  <>
                    {tools}
                    {parts.send}
                  </>
                ),
              }
            : {}),
          body: (
            <>
              <PrMarkdown text={comment.body} said line />
              {chips}
            </>
          ),
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

/** What a thread offers the person where the signed-in gh can act: resolve or unresolve it, and reply in it. */
export interface ThreadActs {
  readonly resolve?: (resolved: boolean) => Promise<void>;
  readonly reply?: (body: string) => Promise<void>;
}

function PathRow({ thread, folded, onOpen }: { thread: ReviewThread; folded: boolean; onOpen?: () => void }) {
  const inner = (
    <>
      <FileIcon aria-hidden className="size-[13px] shrink-0 text-muted-foreground/70" />
      <span className="min-w-0 truncate">{thread.path}</span>
      {thread.line === undefined ? null : <span className="shrink-0 text-muted-foreground">:{thread.line}</span>}
      {thread.resolved ? (
        <span data-pr-thread-resolved className="ml-auto inline-flex shrink-0 items-center gap-1.5 font-sans text-muted-foreground">
          <CircleCheckIcon aria-hidden className="size-[13px] text-status-done" />
          {PR_WORDS.resolved}
        </span>
      ) : null}
      {folded ? <span className="ml-2.5 shrink-0 font-sans text-muted-foreground">{PR_WORDS.commentCount(thread.comments.length)}</span> : null}
      {thread.resolved ? <ChevronRightIcon aria-hidden className={cn("ml-2 size-[13px] shrink-0 text-muted-foreground/70 transition-transform duration-150", !folded && "rotate-90")} /> : null}
    </>
  );
  const row = cn("flex w-full min-w-0 items-center gap-2 bg-[var(--code-background)] px-2.5 text-left font-mono text-xs", folded ? "h-[34px]" : "h-[30px]");
  return onOpen === undefined ? (
    <div className={row}>{inner}</div>
  ) : (
    <button type="button" data-pr-thread-toggle aria-expanded={!folded} onClick={onOpen} className={cn(row, "cursor-pointer")}>
      {inner}
    </button>
  );
}

export function ThreadBox({ thread, agent, of, acts: page }: { thread: ReviewThread; agent: Agent; of: SendOf | undefined; acts?: PageActs | undefined }) {
  const threadId = thread.threadId;
  const root = thread.comments[0]!.id;
  const acts: ThreadActs = {
    ...(page?.resolve === undefined || threadId === undefined ? {} : { resolve: (resolved: boolean) => page.resolve!(threadId, resolved) }),
    ...(page?.reply === undefined ? {} : { reply: (body: string) => page.reply!(body, { replyTo: root, threadId }) }),
  };
  const [open, setOpen] = useState(!thread.resolved);
  const [replying, setReplying] = useState(false);
  const [busy, setBusy] = useState(false);
  const shown = open || !thread.resolved;
  const resolve = acts.resolve;
  const toggle = (): void => {
    if (resolve === undefined || busy) return;
    setBusy(true);
    resolve(!thread.resolved).then(
      () => {
        setBusy(false);
        setOpen(thread.resolved);
      },
      () => setBusy(false),
    );
  };
  return (
    <div data-pr-thread={thread.key} data-resolved={thread.resolved || undefined} data-folded={!shown || undefined} className="mt-2.5 overflow-hidden rounded-lg border border-border bg-card">
      <PathRow thread={thread} folded={!shown} {...(thread.resolved ? { onOpen: () => setOpen(v => !v) } : {})} />
      {!shown ? null : (
        <>
          {thread.hunk === undefined ? null : <ThreadCode hunk={thread.hunk} />}
          {thread.comments.map(c => (
            <LineCommentRow key={c.id} comment={c} agent={agent} of={of} acts={page} />
          ))}
          {resolve === undefined && acts?.reply === undefined ? null : (
            <div data-pr-thread-foot className="flex justify-end gap-0.5 border-t border-border/50 px-2 py-1.5">
              {resolve === undefined ? null : (
                <Button type="button" size="xs" variant="ghost" data-pr-thread-resolve disabled={busy} onClick={toggle}>
                  {thread.resolved ? PR_WORDS.unresolve : PR_WORDS.resolve}
                </Button>
              )}
              {acts?.reply === undefined ? null : (
                <Button type="button" size="xs" variant="ghost" data-pr-thread-reply className="text-foreground" onClick={() => setReplying(true)}>
                  {PR_WORDS.reply}
                </Button>
              )}
            </div>
          )}
          {replying && acts?.reply !== undefined ? (
            <div className="mx-3 mb-3">
              <ReplyField to={authorName(thread.comments[0]!.author)} onSend={body => acts.reply!(body).then(() => setReplying(false))} onCancel={() => setReplying(false)} />
            </div>
          ) : null}
        </>
      )}
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

export function Timeline({ page, agent, of, acts, onOpenCommits, onQuote }: { page: PullRequestPage; agent: Agent; of?: SendOf | undefined; acts?: PageActs | undefined; /** Where a push line goes: the Commits tab. */ onOpenCommits: () => void; /** Where a quote reply goes: the comment box at Activity's foot. */ onQuote?: (author: string, body: string) => void }) {
  const entries = conversationOf(page);
  if (entries.length === 0) return null;
  return (
    <ol data-pr-timeline className="relative flex flex-col gap-[22px] pt-0.5 before:absolute before:top-3.5 before:bottom-3.5 before:left-[11.5px] before:w-px before:bg-border before:content-['']">
      {entries.map(entry => {
        switch (entry.kind) {
          case "comment":
            if (entry.comment.bot) return <BotNotice key={entry.key} entry={entry} agent={agent} of={of} />;
            return (
              <Said
                key={entry.key}
                kind="comment"
                face={entry.comment.author}
                avatar={entry.comment.avatar}
                head={tools => <Head author={entry.comment.author} verb={PR_WORDS.commented} at={entry.at} tools={tools} {...sendParts(agent, of, { kind: "comment", id: entry.comment.id })} />}
                body={
                  <div className="mt-1">
                    <Clamped>
                      <PrMarkdown text={entry.comment.body} said />
                    </Clamped>
                  </div>
                }
                item={entry.comment}
                {...(onQuote === undefined ? {} : { quote: () => onQuote(entry.comment.author, entry.comment.body) })}
                acts={acts}
                k={`comment:${entry.comment.id}`}
              />
            );
          case "review": {
            const verdict = reviewVerdict(entry.review.state);
            const id = entry.review.id;
            const said = entry.review.body !== "";
            return (
              <Said
                key={entry.key}
                kind="review"
                face={entry.review.author}
                head={tools => (
                  <Head
                    author={entry.review.author}
                    verb={PR_WORDS.reviewed}
                    word={<StateWord word={verdict.word} tone={verdict.tone} k="pr-verdict" />}
                    at={entry.at}
                    tools={tools}
                    {...(!said || id === undefined ? {} : sendParts(agent, of, { kind: "review", id }))}
                  />
                )}
                body={
                  !said ? null : (
                    <div className="mt-1">
                      <Clamped>
                        <PrMarkdown text={entry.review.body} said />
                      </Clamped>
                    </div>
                  )
                }
                after={entry.threads.map(t => (
                  <ThreadBox key={t.key} thread={t} agent={agent} of={of} acts={acts} />
                ))}
                item={said ? entry.review : {}}
                {...(onQuote === undefined ? {} : { quote: () => onQuote(entry.review.author, entry.review.body) })}
                acts={said ? acts : undefined}
                k={`review:${entry.review.id ?? entry.key}`}
              />
            );
          }
          case "thread":
            return (
              <Entry key={entry.key} kind="thread" face={entry.thread.comments[0]!.author} avatar={entry.thread.comments[0]!.avatar}>
                <Head author={entry.thread.comments[0]!.author} verb={PR_WORDS.commentedOnLine} at={entry.at} />
                <ThreadBox thread={entry.thread} agent={agent} of={of} acts={acts} />
              </Entry>
            );
          case "push":
            return (
              <Entry key={entry.key} kind="push" face={entry.authors[0]!}>
                <button type="button" data-pr-push-open onClick={onOpenCommits} className="block w-full cursor-pointer rounded-sm text-left focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none [&_[data-verb]]:transition-colors [&_[data-verb]]:duration-150 hover:[&_[data-verb]]:text-foreground [&_svg]:transition-colors [&_svg]:duration-150 hover:[&_svg]:text-foreground">
                  <Head author={entry.authors.map(authorName).join(", ")} verb={PR_WORDS.pushed(entry.commits.length)} at={entry.at} go />
                </button>
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
