// SPDX-License-Identifier: AGPL-3.0-only
// The Pull request pane as a small GitHub view in the Settings grammar: a head with the state glyph in its frame, the
// title, who opened it, the number as a link out, the one word with its dot and the branches; then three tabs with
// their counts. Conversation is Status first, then the description, then Activity, the conversation alone; Commits is
// one rail by day; Files is the tree, a file opening its diff in place. The page is read as the pane opens and on its
// refresh, never kept; the head reads the fact the host pushes on the workspace's status.
import { useCallback, useEffect, useRef, useState } from "react";
import { ExternalLinkIcon, GitBranchIcon, GitMergeIcon, GitPullRequestClosedIcon, GitPullRequestDraftIcon, GitPullRequestIcon, RefreshCwIcon } from "lucide-react";
import { START_WORDS, isPullRequestFact, isPullRequestNamed, type PullRequestItem, type PullRequestPage } from "@wsp/protocol";
import { noticeFailure } from "../notices/store.js";
import { PanelStripControl } from "../components/PanelStripSlot.js";
import { SegmentedControl } from "../components/ui/segmented-control.js";
import { Button } from "../components/ui/button.js";
import { cn } from "../lib/utils.js";
import { formatRelativeTimeLabel } from "../lib/timestampFormat.js";
import { failureOf } from "../protocol/failure.js";
import { GlyphFrame } from "../settings/grid.js";
import { useAppDark } from "../settings/theme.js";
import { useProjects, useStatus, useStore, useWorkspace } from "../protocol/store.js";
import { Commits } from "./Commits.js";
import { Skeleton } from "../components/ui/skeleton.js";
import { Timeline, sendRoad } from "./Conversation.js";
import { conversationCount } from "./conversation.logic.js";
import { Files, type DiffRead } from "./Files.js";
import { StatusBox } from "./Status.js";
import { usePageActs } from "./pageActs.js";
import { CommentBox, quoteOf } from "./ThreadActs.js";
import { SECTION_HEAD } from "../settings/layout.js";
import { Clamped, CommitsSkeleton, CutNote, FilesSkeleton, Hover, PrMarkdown, StateWord, TimelineSkeleton, Who, usePrAgent } from "./parts.js";
import { ReviewDialog } from "./ReviewDialog.js";
import { ReviewDraftSection } from "./ReviewDraftSection.js";
import { PR_WORDS, TONE_INK, pullRequestTone, spacedAgo } from "./words.js";

type Tab = "conversation" | "commits" | "files";

function TabLabel({ word, count }: { word: string; count: number | undefined }) {
  return (
    <>
      {word}
      {count === undefined ? null : <b className="font-mono text-xs font-normal text-muted-foreground">{count}</b>}
    </>
  );
}

/** One pane per workspace and pull request, so nothing read for one is drawn for another. */
export function PullRequestSurface({ workspaceId }: { workspaceId: string }) {
  const seen = useStatus(workspaceId)?.pr;
  return <PullRequestPane key={`${workspaceId}:${isPullRequestNamed(seen) ? seen.number : ""}`} workspaceId={workspaceId} />;
}

function PullRequestPane({ workspaceId }: { workspaceId: string }) {
  const status = useStatus(workspaceId);
  const seen = status?.pr;
  const workspace = useWorkspace(workspaceId);
  const projects = useProjects();
  const dark = useAppDark();
  const view = useStore(s => s.api?.pullRequestView);
  const agent = usePrAgent(workspaceId);
  const [page, setPage] = useState<PullRequestPage | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [asked, setAsked] = useState(0);
  const [tab, setTab] = useState<Tab>("conversation");
  const [reviewing, setReviewing] = useState(false);
  const [diff, setDiff] = useState<DiffRead | null>(null);
  const name = workspace?.name ?? workspaceId;
  const project = projects.find(p => p.id === workspace?.project.id);
  const base = isPullRequestNamed(seen) ? seen.base : (project?.base ?? project?.defaultBranch ?? "main");
  const diffAsk = useRef(0);
  const [sending, setSending] = useState<readonly PullRequestItem[]>([]);

  useEffect(() => {
    if (view === undefined || !isPullRequestNamed(seen)) return;
    let gone = false;
    view(workspaceId).then(
      read => {
        if (gone) return;
        setPage(read);
        setRefusal(null);
      },
      (e: unknown) => {
        if (!gone) setRefusal(failureOf(e).said);
      },
    );
    return () => {
      gone = true;
    };
    // The page is read as the pane opens, on its refresh, and when the pull request's number moves.
  }, [view, workspaceId, asked, isPullRequestNamed(seen) ? seen.number : null]);

  const refresh = useCallback(() => {
    setAsked(n => n + 1);
    diffAsk.current += 1;
    setDiff(null);
  }, []);

  // A read answered after a refresh asked again is the old diff's, and is dropped.
  const readDiff = useCallback(() => {
    const read = useStore.getState().api?.pullRequestDiff;
    if (read === undefined) return setDiff({ state: "refused", said: PR_WORDS.noDiffRead });
    const ask = ++diffAsk.current;
    setDiff({ state: "reading" });
    read(workspaceId).then(
      d => void (ask === diffAsk.current && setDiff({ state: "read", patch: d.diff, left: d.left })),
      (e: unknown) => void (ask === diffAsk.current && setDiff({ state: "refused", said: failureOf(e).said })),
    );
  }, [workspaceId]);

  const sendItems = useCallback(
    (items: readonly PullRequestItem[]) => {
      const send = useStore.getState().api?.pullRequestSend;
      if (send === undefined || items.length === 0) return;
      setSending(held => [...held, ...items]);
      const done = (): void => setSending(held => held.filter(h => !items.some(i => i.kind === h.kind && i.id === h.id)));
      send(workspaceId, items).then(
        sent => {
          setPage(p => (p === null ? p : { ...p, sent: sent.sent }));
          done();
        },
        (e: unknown) => {
          noticeFailure(e, said => said, { where: name });
          done();
        },
      );
    },
    [workspaceId, name],
  );
  const canSend = useStore(s => s.api?.pullRequestSend !== undefined);
  const acts = usePageActs(workspaceId, name, page?.postsAsYou === true, setPage);
  const [foot, setFoot] = useState("");
  const footField = useRef<HTMLTextAreaElement>(null);
  const [quoted, setQuoted] = useState(0);
  const quote = useCallback((author: string, body: string) => {
    setFoot(typed => (typed.trim() === "" ? quoteOf(author, body) : `${typed.trimEnd()}\n\n${quoteOf(author, body)}`));
    setQuoted(n => n + 1);
  }, []);
  // A quote reply brings the box into view with the caret after the quote, ready for the person's words.
  useEffect(() => {
    const field = footField.current;
    if (quoted === 0 || field === null) return;
    field.scrollIntoView?.({ block: "center", behavior: "smooth" });
    field.focus();
    field.setSelectionRange(field.value.length, field.value.length);
  }, [quoted]);

  if (!isPullRequestNamed(seen)) {
    if (seen !== undefined && "why" in seen)
      return (
        <div data-pr-pane className="flex h-full min-h-0 flex-col px-4 py-6 text-[13px] text-muted-foreground">
          {seen.why}
        </div>
      );
    // Not read yet: the pane's own shape, the head over the timeline, so nothing moves when the pull request lands.
    return (
      <div data-pr-pane aria-busy="true" className="flex h-full min-h-0 flex-col gap-5 px-4 py-5">
        <div className="grid grid-cols-[32px_minmax(0,1fr)] gap-3">
          <Skeleton className="size-8 rounded-[9px]" />
          <div className="flex flex-col gap-2 pt-1">
            <Skeleton className="h-3.5 w-4/5" />
            <Skeleton className="h-3 w-1/3" />
          </div>
        </div>
        <Skeleton className="h-9 w-full rounded-[10px]" />
        <TimelineSkeleton />
      </div>
    );
  }

  const fact = isPullRequestFact(seen) ? seen : null;
  const { word, tone, hollow } = pullRequestTone(seen);
  const Glyph = seen.state === "merged" ? GitMergeIcon : seen.state === "closed" ? GitPullRequestClosedIcon : fact?.draft === true ? GitPullRequestDraftIcon : GitPullRequestIcon;
  const author = page?.author || fact?.author;
  const opened = page !== null && page.createdAt !== "" ? spacedAgo(formatRelativeTimeLabel(page.createdAt)) : "";
  const of = page === null ? undefined : sendRoad(page, sending, canSend ? sendItems : undefined);
  const branch = fact?.branch ?? status?.checkout?.branch;
  const from = workspace?.from;
  const reviewWorkspace = from?.kind === "review";
  const tabs: { value: Tab; label: React.ReactNode }[] = [
    { value: "conversation", label: <TabLabel word={PR_WORDS.tabs.conversation} count={page === null ? undefined : conversationCount(page)} /> },
    { value: "commits", label: <TabLabel word={PR_WORDS.tabs.commits} count={page?.commits.length ?? fact?.commits} /> },
    { value: "files", label: <TabLabel word={PR_WORDS.tabs.files} count={page?.files.length ?? fact?.changedFiles} /> },
  ];

  return (
    <div data-pr-pane className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto px-4 pt-4 pb-5">
      <div data-pr-head className="flex flex-col gap-2.5">
        <div className="grid grid-cols-[32px_minmax(0,1fr)_auto] items-start gap-3">
          <GlyphFrame>
            <Glyph aria-hidden data-pr-glyph={seen.state} className={cn("size-4", TONE_INK[tone])} />
          </GlyphFrame>
          <div className="min-w-0">
            <h2 data-pr-title className="text-[15px] leading-[22px] font-medium text-pretty text-foreground">
              {page?.title ?? fact?.headSubject ?? PR_WORDS.row(seen.number)}
            </h2>
            {author === undefined || author === "" ? null : (
              <div data-pr-by className="mt-1 text-[13px] leading-5 text-muted-foreground">
                <Who login={author} /> {opened === "" ? null : <span data-pr-when>{PR_WORDS.opened(opened)}</span>}
              </div>
            )}
          </div>
          <a href={seen.url} target="_blank" rel="noopener noreferrer" data-pr-number className="inline-flex h-[22px] items-center gap-[5px] font-mono text-[13px] text-muted-foreground transition-colors duration-150 hover:text-foreground">
            {PR_WORDS.number(seen.number)}
            <ExternalLinkIcon aria-hidden className="size-3" />
          </a>
        </div>
        <div data-pr-state-row className="flex h-5 min-w-0 items-center justify-between gap-3.5 pl-11">
          <span className="flex h-5 items-center leading-5">
            <StateWord word={word} tone={tone} hollow={hollow} />
          </span>
          {branch === undefined ? null : (
            <span data-pr-branches className="flex min-w-0 items-center gap-1.5 font-mono text-xs leading-5 text-muted-foreground">
              <GitBranchIcon aria-hidden className="size-[13px] shrink-0" />
              <span className="min-w-0 truncate">{`${base} ← ${branch}`}</span>
            </span>
          )}
        </div>
        {page === null || page.labels.length === 0 ? null : (
          <div data-pr-labels className="flex flex-wrap gap-1.5 pl-11">
            {page.labels.map(l => {
              const chip = (
                <span key={l.name} data-pr-label={l.name} className="inline-flex h-[22px] items-center gap-1.5 rounded-md border border-border px-2 text-xs">
                  <i aria-hidden className="size-[7px] rounded-[2px]" style={{ background: `#${l.color}` }} />
                  {l.name}
                </span>
              );
              return l.description === undefined || l.description === "" ? chip : <Hover key={l.name} words={l.description}>{chip}</Hover>;
            })}
          </div>
        )}
        {page === null || page.reviewRequests.length === 0 ? null : (
          <div data-pr-asks className="pl-11 text-[13px] text-muted-foreground">
            {PR_WORDS.reviewAskedOf}{" "}
            {page.reviewRequests.map((r, i) => (
              <span key={r.name}>
                {i === 0 ? null : ", "}
                {r.team ? r.name : <Who login={r.name} />}
              </span>
            ))}
          </div>
        )}
        {from !== undefined && from.kind !== "review" ? (
          <a data-pr-from href={from.url} target="_blank" rel="noopener noreferrer" className="min-w-0 truncate pl-11 text-[13px] text-muted-foreground hover:text-foreground">
            {from.kind === "issue" ? START_WORDS.fromIssue(from.number, from.title) : START_WORDS.fromPullRequest(from.number)}
          </a>
        ) : null}
        {refusal === null ? null : <p className="pl-11 text-[13px] text-error-foreground">{refusal}</p>}
      </div>

      {reviewing ? <ReviewDialog workspaceId={workspaceId} onClose={() => setReviewing(false)} /> : null}

      <PanelStripControl>
        <Hover words={PR_WORDS.refresh}>
          <Button type="button" size="icon" variant="ghost" data-pr-refresh aria-label={PR_WORDS.refresh} onClick={refresh}>
            <RefreshCwIcon aria-hidden className="size-[15px] text-muted-foreground/70" />
          </Button>
        </Hover>
      </PanelStripControl>

      <div data-pr-tabs>
        <SegmentedControl<Tab> value={tab} segments={tabs} onChange={setTab} aria-label={PR_WORDS.row(seen.number)} className="flex w-full" segmentClassName="flex-1 gap-1.5 px-2" />
      </div>

      {tab !== "conversation" ? null : (
        <>
          <StatusBox workspaceId={workspaceId} name={name} seen={seen} page={page} base={base} agent={agent} reviewing={reviewWorkspace} onReview={() => setReviewing(true)} {...(canSend ? { sendAll: sendItems } : {})} sending={sending} />
          {page === null ? null : page.body.trim() === "" ? (
            <p data-pr-no-body className="text-[13px] text-muted-foreground">
              {PR_WORDS.noDescription}
            </p>
          ) : (
            <div data-pr-body>
              <Clamped>
                <PrMarkdown text={page.body} />
              </Clamped>
            </div>
          )}
          {reviewWorkspace ? <ReviewDraftSection workspaceId={workspaceId} name={name} fact={fact} head={PR_WORDS.heads.draft} /> : null}
          <section data-pr-activity className="flex flex-col gap-2.5">
            <h3 className={SECTION_HEAD}>{PR_WORDS.heads.activity}</h3>
            {page?.cut?.reviews === true ? <CutNote words={PR_WORDS.cut.reviews} /> : null}
            {page?.cut?.threads === true ? <CutNote words={PR_WORDS.cut.threads} /> : null}
            <div className="mt-0.5">{page === null ? <TimelineSkeleton /> : <Timeline page={page} agent={agent} of={of} acts={acts} onOpenCommits={() => setTab("commits")} onQuote={quote} />}</div>
            {page === null || acts?.reply === undefined ? null : <CommentBox text={foot} setText={setFoot} onSend={body => acts.reply!(body)} fieldRef={footField} />}
          </section>
        </>
      )}

      {tab !== "commits" ? null : page === null ? <CommitsSkeleton /> : <Commits commits={page.commits} cut={page.cut?.commits === true} />}

      {tab !== "files" ? null : page === null ? <FilesSkeleton /> : <Files workspaceId={workspaceId} page={page} theme={dark ? "dark" : "light"} read={diff} readDiff={readDiff} agent={agent} of={of} acts={acts} />}
    </div>
  );
}
