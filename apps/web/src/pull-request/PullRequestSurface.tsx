// SPDX-License-Identifier: AGPL-3.0-only
// The Pull request pane, after T3 Code's pull request tab: a header with the number in its state's ink, the title,
// the state as a quiet word, the branches, the author and when it last moved; then three tabs. Overview renders the
// body as markdown, clamped with a fade and Show more, then CHECKS (a failure first, each a mark with its fix under
// it), REVIEW, the CONVERSATION and the line COMMENTS. Commits is a rail with one dot per commit, hollow for a merge. Files is the
// same tree the turn's changed-files card draws. The page is read as the pane opens and on its refresh, never kept;
// the head reads the fact the host pushes on the workspace's status.
import { Suspense, useCallback, useEffect, useState, type ReactNode } from "react";
import { ArrowLeftIcon, ChevronsDownUpIcon, ChevronsUpDownIcon, CircleCheckIcon, CircleDashedIcon, CircleMinusIcon, CircleXIcon, GitMergeIcon, HammerIcon, RefreshCwIcon, type LucideIcon } from "lucide-react";
import { CHECK_STATE_WORDS, capitalised, isPullRequestFact, isPullRequestNamed, pullRequestCounts, pullRequestWord, type CheckState, type PullRequestPage } from "@wsp/protocol";
import ChatMarkdown from "../components/ChatMarkdown.js";
import { ChangedFilesTree } from "../components/chat/ChangedFilesTree.js";
import { CLAMP_FADE_MASK, shouldClampText } from "../components/chat/clamp.js";
import { DiffStatLabel, hasNonZeroStat } from "../components/chat/DiffStatLabel.js";
import { type TurnDiffFileChange } from "../components/chat/adapt.js";
import { summarizeTurnDiffStats } from "../lib/turnDiffTree.js";
import { SegmentedControl } from "../components/ui/segmented-control.js";
import { Button } from "../components/ui/button.js";
import { sendToThread, prCommentQuote } from "../diffs/sendToThread.js";
import { GROUP_LABEL } from "../lib/microLabel.js";
import { cn } from "../lib/utils.js";
import { formatRelativeTimeLabel } from "../lib/timestampFormat.js";
import { failureOf } from "../protocol/failure.js";
import { useAppDark } from "../settings/theme.js";
import { useProjects, useStatus, useStore, useWorkspace } from "../protocol/store.js";
import { askToFix, updateFromBase } from "./acts.js";
import { MergeControls } from "./MergeControls.js";
import { PR_INK, PR_WORDS } from "./words.js";

const ROW = "flex min-w-0 items-start gap-3 rounded-[var(--control-radius)] px-2 py-2 transition-colors duration-150 hover:bg-accent";
const NOTE = "text-[11px] leading-[14px] text-muted-foreground";
const WORD = "shrink-0 text-[13px] leading-5 text-muted-foreground";
const CHECK_MARK: Record<CheckState, LucideIcon> = { pass: CircleCheckIcon, fail: CircleXIcon, pending: CircleDashedIcon, skipped: CircleMinusIcon, cancelled: CircleMinusIcon };
const CHECK_INK: Record<CheckState, string> = { pass: "text-success", fail: "text-status-failed", pending: "text-muted-foreground", skipped: "text-muted-foreground", cancelled: "text-muted-foreground" };
const CHECK_RANK: Record<CheckState, number> = { fail: 0, pending: 1, cancelled: 2, skipped: 3, pass: 4 };

type Tab = "overview" | "commits" | "files";
const TABS: { value: Tab; label: string }[] = [
  { value: "overview", label: PR_WORDS.tabs.overview },
  { value: "commits", label: PR_WORDS.tabs.commits },
  { value: "files", label: PR_WORDS.tabs.files },
];

function Section({ head, children }: { head: string; children: ReactNode }) {
  return (
    <section data-pr-section={head.toLowerCase()} className="mt-6 flex flex-col gap-0.5">
      <span className={cn(GROUP_LABEL, "flex h-6 items-center px-2 text-muted-foreground")}>{head}</span>
      {children}
    </section>
  );
}

/** A merge commit, read off its subject as git writes one: only these get the hollow dot on the rail. */
const isMergeCommit = (subject: string): boolean => /^Merge (pull request|branch|remote-tracking branch)\b/.test(subject);

/** The body under the bubbles' own fade and toggle: the same mask and length rule, so a long body ends in words
 * going to nothing with Show more standing in the clear bottom. */
function ClampedBody({ text, children }: { text: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const clamps = shouldClampText(text);
  const folded = clamps && !open;
  return (
    <div data-pr-body className="mt-4 px-2">
      <div className="relative">
        <div
          data-pr-body-fade={folded || undefined}
          className={cn("relative", folded && "max-h-44 overflow-hidden")}
          style={folded ? { WebkitMaskImage: CLAMP_FADE_MASK, maskImage: CLAMP_FADE_MASK } : undefined}
        >
          {children}
        </div>
        {clamps ? (
          <div className={cn("flex items-center justify-end", folded ? "absolute inset-x-0 bottom-0" : "mt-1.5")}>
            <Button type="button" size="xs" variant="ghost" data-pr-show-more onClick={() => setOpen(o => !o)}>
              {open ? PR_WORDS.showLess : PR_WORDS.showMore}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** The commits on a rail in the accent at low alpha: one dot each centred on its row, hollow for a merge, then the
 * subject, the author and the relative time in fixed columns so their edges line up down the list. */
function PullRequestCommits({ commits }: { commits: PullRequestPage["commits"] }) {
  if (commits.length === 0) return <p className="mt-4 px-2 text-[13px] text-muted-foreground">{PR_WORDS.noCommits}</p>;
  return (
    <div data-pr-commits className="relative mt-4 pl-6">
      <span aria-hidden className="absolute bottom-4 left-[9px] top-4 w-px bg-primary/35" />
      {commits.map(commit => {
        const merge = isMergeCommit(commit.subject);
        return (
          <div key={commit.oid} data-pr-commit={commit.oid} className="relative flex items-center gap-3 rounded-[var(--control-radius)] py-1.5 pr-2">
            <span
              aria-hidden
              data-pr-commit-merge={merge || undefined}
              className={cn("absolute left-[5px] top-1/2 size-2 -translate-y-1/2 rounded-full", merge ? "border border-primary bg-background" : "bg-primary")}
            />
            <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">{commit.oid.slice(0, 7)}</span>
            <span className="min-w-0 flex-1 truncate text-[14px] leading-5 text-foreground">{commit.subject}</span>
            <span className="w-24 shrink-0 truncate text-[12px] text-muted-foreground">{commit.author}</span>
            <span className="w-16 shrink-0 text-right font-mono text-[11px] tabular-nums text-muted-foreground">{formatRelativeTimeLabel(commit.at)}</span>
          </div>
        );
      })}
    </div>
  );
}

/** The changed files as the turn's card draws them, the tree with its counts, a row opening the pull request's files
 * on its host. */
function PullRequestFiles({ files, url, dark }: { files: readonly TurnDiffFileChange[]; url: string; dark: boolean }) {
  const [allExpanded, setAllExpanded] = useState(false);
  const summary = summarizeTurnDiffStats(files);
  if (files.length === 0) return <p className="mt-4 px-2 text-[13px] text-muted-foreground">{PR_WORDS.noFiles}</p>;
  const nested = files.some(f => /[/\\]/.test(f.path));
  return (
    <div data-pr-files className="mt-4">
      <div className="flex items-center justify-between gap-2 px-2 py-1.5">
        <span className="flex min-w-0 items-center gap-3 text-[13px] text-foreground">
          <span>{files.length} changed {files.length === 1 ? "file" : "files"}</span>
          {hasNonZeroStat(summary) ? <DiffStatLabel additions={summary.additions} deletions={summary.deletions} layout="inline" tone="diff" className="text-[12px]" /> : null}
        </span>
        {nested ? (
          <Button type="button" size="icon-xs" variant="ghost" aria-label={allExpanded ? PR_WORDS.collapseFolders : PR_WORDS.expandFolders} title={allExpanded ? PR_WORDS.collapseFolders : PR_WORDS.expandFolders} onClick={() => setAllExpanded(v => !v)}>
            {allExpanded ? <ChevronsDownUpIcon aria-hidden className="size-3.5" /> : <ChevronsUpDownIcon aria-hidden className="size-3.5" />}
          </Button>
        ) : null}
      </div>
      <ChangedFilesTree
        files={files}
        allDirectoriesExpanded={allExpanded}
        resolvedTheme={dark ? "dark" : "light"}
        statTone="diff"
        onOpenFile={url === "" ? undefined : () => window.open(`${url}/files`, "_blank", "noopener,noreferrer")}
      />
    </div>
  );
}

export function PullRequestSurface({ workspaceId }: { workspaceId: string }) {
  const seen = useStatus(workspaceId)?.pr;
  const workspace = useWorkspace(workspaceId);
  const projects = useProjects();
  const dark = useAppDark();
  const view = useStore(s => s.api?.pullRequestView);
  const [page, setPage] = useState<PullRequestPage | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [asked, setAsked] = useState(0);
  const [tab, setTab] = useState<Tab>("overview");
  const name = workspace?.name ?? workspaceId;
  const project = projects.find(p => p.id === workspace?.project.id);
  const base = isPullRequestFact(seen) ? seen.base : (project?.base ?? project?.defaultBranch ?? "main");

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

  const refresh = useCallback(() => setAsked(n => n + 1), []);

  if (!isPullRequestNamed(seen)) {
    return (
      <div data-pr-pane className="flex h-full min-h-0 flex-col px-4 py-6 text-[13px] text-muted-foreground">
        {seen !== undefined && "why" in seen ? seen.why : PR_WORDS.reading}
      </div>
    );
  }

  const fact = isPullRequestFact(seen) ? seen : null;
  const word = pullRequestWord(seen);
  const checks = fact === null ? [] : [...fact.checks].sort((a, b) => CHECK_RANK[a.state] - CHECK_RANK[b.state]);
  const updated = page !== null && page.updatedAt !== "" ? formatRelativeTimeLabel(page.updatedAt) : "";
  const treeFiles: TurnDiffFileChange[] = (page?.files ?? []).map(f => ({ path: f.path, kind: "modified", additions: f.additions, deletions: f.deletions }));

  return (
    <div data-pr-pane className="flex h-full min-h-0 flex-col overflow-y-auto px-4 pb-8 pt-4">
      <div data-pr-head className="flex flex-col px-2">
        <div className="flex h-7 min-w-0 items-center gap-3 text-xs text-muted-foreground">
          <a href={seen.url} target="_blank" rel="noopener noreferrer" data-pr-number data-pr-state={seen.state} className={cn("shrink-0 font-medium tabular-nums hover:underline", PR_INK[seen.state])}>
            {PR_WORDS.number(seen.number)}
          </a>
          {fact === null ? null : (
            <span data-pr-branches className="flex min-w-0 flex-1 items-center gap-1 font-mono text-[11px] tabular-nums">
              <span className="shrink-0">{fact.base}</span>
              <ArrowLeftIcon aria-hidden className="size-3 shrink-0 opacity-60" />
              <span className="min-w-0 truncate">{fact.branch}</span>
            </span>
          )}
          <Button type="button" size="icon-xs" variant="ghost" aria-label={PR_WORDS.refresh} title={PR_WORDS.refresh} className="ms-auto" onClick={refresh}>
            <RefreshCwIcon aria-hidden className="size-3.5" />
          </Button>
        </div>
        <h2 data-pr-title className="mt-1 text-[15px] leading-5 font-medium text-foreground">
          {page?.title ?? fact?.headSubject ?? PR_WORDS.row(seen.number)}
        </h2>
        <div data-pr-facts className="mt-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span data-pr-word>{capitalised(word)}</span>
          {page !== null && page.author !== "" ? <span data-pr-author>{page.author}</span> : null}
          {updated === "" ? null : <span data-pr-updated>{PR_WORDS.updated(updated)}</span>}
          {fact === null ? null : pullRequestCounts(fact).map(part => (
            <span key={part} className="font-mono text-[11px] tabular-nums">
              {part}
            </span>
          ))}
        </div>
        {fact === null ? null : (
          <div className="mt-3 flex flex-wrap items-center gap-2 empty:hidden">
            <MergeControls workspaceId={workspaceId} name={name} fact={fact} repo={page?.merge} />
            {fact.state === "open" && (fact.behindBase ?? 0) > 0 && fact.mergeable !== "conflicting" ? (
              <Button type="button" size="xs" variant="outline" data-pr-update onClick={() => void updateFromBase(workspaceId, name)}>
                <GitMergeIcon aria-hidden />
                {PR_WORDS.update(base)}
              </Button>
            ) : null}
            {fact.state === "open" && fact.mergeable === "conflicting" ? (
              <Button type="button" size="xs" variant="outline" data-pr-fix-conflicts onClick={() => void askToFix(workspaceId, name)}>
                <HammerIcon aria-hidden />
                {PR_WORDS.fix}
              </Button>
            ) : null}
          </div>
        )}
        {refusal === null ? null : <p className="mt-2 text-[13px] text-error-foreground">{refusal}</p>}
      </div>

      <div data-pr-tabs className="mt-4 px-2">
        <SegmentedControl<Tab> value={tab} segments={TABS} onChange={setTab} aria-label={PR_WORDS.row(seen.number)} />
      </div>

      {tab !== "overview" ? null : (
        <>
          {page === null || page.body === "" ? null : (
            <ClampedBody text={page.body}>
              <Suspense fallback={<p className="whitespace-pre-wrap text-sm text-foreground">{page.body}</p>}>
                <ChatMarkdown text={page.body} cwd="" resolvedTheme={dark ? "dark" : "light"} restricted />
              </Suspense>
            </ClampedBody>
          )}

          {checks.length === 0 ? null : (
            <Section head={PR_WORDS.heads.checks}>
              {checks.map(check => {
                const Mark = CHECK_MARK[check.state];
                const failed = check.state === "fail";
                return (
                  <div key={check.name} data-pr-check={check.name} data-open={failed || undefined} className={cn(ROW, "items-center py-1.5", failed && "items-start py-2")}>
                    <Mark {...(failed ? { "aria-hidden": true } : { role: "img", "aria-label": CHECK_STATE_WORDS[check.state] })} data-pr-check-mark className={cn("size-3.5 shrink-0", CHECK_INK[check.state], failed && "mt-[3px]")} />
                    <div className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-[13px] leading-5 text-foreground">
                        {check.link === undefined ? check.name : (
                          <a href={check.link} target="_blank" rel="noopener noreferrer" className="hover:underline">
                            {check.name}
                          </a>
                        )}
                      </span>
                      {failed ? (
                        <>
                          {check.workflow !== undefined ? <span className={NOTE}>{check.workflow}</span> : check.description !== undefined ? <span className={NOTE}>{check.description}</span> : null}
                          <span className="mt-1.5">
                            <Button type="button" size="xs" variant="outline" data-pr-fix={check.name} onClick={() => void askToFix(workspaceId, name, check.name)}>
                              <HammerIcon aria-hidden />
                              {PR_WORDS.fix}
                            </Button>
                          </span>
                        </>
                      ) : null}
                    </div>
                    {failed ? (
                      <span data-pr-check-state className={WORD}>
                        {CHECK_STATE_WORDS[check.state]}
                      </span>
                    ) : null}
                  </div>
                );
              })}
            </Section>
          )}

          {page === null || page.reviews.length === 0 ? null : (
            <Section head={PR_WORDS.heads.review}>
              {page.reviews.map((r, i) => (
                <div key={`${r.author}:${i}`} data-pr-review className={ROW}>
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm text-foreground">{r.author}</span>
                    {r.body === "" ? null : <span className="whitespace-pre-wrap text-[12px] leading-4 text-muted-foreground">{r.body}</span>}
                  </div>
                  <span className={WORD}>{capitalised(r.state.replace(/_/g, " "))}</span>
                </div>
              ))}
            </Section>
          )}

          {page === null || page.comments.length === 0 ? null : (
            <Section head={PR_WORDS.heads.conversation}>
              {page.comments.map((c, i) => (
                <div key={`${c.author}:${i}`} data-pr-conversation className={ROW}>
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className={NOTE}>{c.author}</span>
                    <span className="whitespace-pre-wrap text-[12px] leading-4 text-muted-foreground">{c.body}</span>
                  </div>
                </div>
              ))}
            </Section>
          )}

          {page === null || page.reviewComments.length === 0 ? null : (
            <Section head={PR_WORDS.heads.comments}>
              {page.reviewComments.map(c => (
                <div key={c.id} data-pr-comment={c.id} className={ROW}>
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="flex min-w-0 items-center gap-3">
                      <span className="min-w-0 truncate font-mono text-[13px] text-foreground tabular-nums">{c.line === undefined ? c.path : `${c.path}:${c.line}`}</span>
                      <span className={NOTE}>{c.author}</span>
                    </span>
                    <span className="whitespace-pre-wrap text-[12px] leading-4 text-muted-foreground">{c.body}</span>
                    <span className="mt-1">
                      <Button type="button" size="xs" variant="ghost" data-pr-send={c.id} onClick={() => sendToThread(workspaceId, prCommentQuote(c))}>
                        {PR_WORDS.sendToThread}
                      </Button>
                    </span>
                  </div>
                </div>
              ))}
            </Section>
          )}
        </>
      )}

      {tab !== "commits" ? null : page === null ? <p className="mt-4 px-2 text-[13px] text-muted-foreground">{PR_WORDS.reading}</p> : <PullRequestCommits commits={page.commits} />}

      {tab !== "files" ? null : page === null ? <p className="mt-4 px-2 text-[13px] text-muted-foreground">{PR_WORDS.reading}</p> : <PullRequestFiles files={treeFiles} url={seen.url} dark={dark} />}
    </div>
  );
}
