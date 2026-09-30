// SPDX-License-Identifier: AGPL-3.0-only
// The Pull request pane, after T3 Code's pull request tab: the number in its state's ink as the link with the
// branches beside it, the title once, the state and the stats as quiet facts, the buttons that apply (Merge, Update
// from the base while behind, the fix on a conflict), then CHECKS, each a mark with only a failure open, worded, with its fix under it,
// REVIEW, COMMENTS and the timeline. A comment on a line carries Send to thread, which quotes it into the composer for
// the person to send. The page is asked for as the pane opens and on its refresh, and never kept; the head reads the
// fact the host pushes on the workspace's status.
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ArrowLeftIcon, CircleCheckIcon, CircleDashedIcon, CircleMinusIcon, CircleXIcon, GitMergeIcon, HammerIcon, RefreshCwIcon, type LucideIcon } from "lucide-react";
import { CHECK_STATE_WORDS, capitalised, isPullRequestFact, isPullRequestNamed, pullRequestCounts, pullRequestWord, type CheckState, type PullRequestPage } from "@wsp/protocol";
import { Button } from "../components/ui/button.js";
import { sendToThread, prCommentQuote } from "../diffs/sendToThread.js";
import { GROUP_LABEL } from "../lib/microLabel.js";
import { cn } from "../lib/utils.js";
import { failureOf } from "../protocol/failure.js";
import { useProjects, useStatus, useStore, useWorkspace } from "../protocol/store.js";
import { askToFix, updateFromBase } from "./acts.js";
import { MergeControls } from "./MergeControls.js";
import { PR_INK, PR_WORDS } from "./words.js";

const ROW = "flex min-w-0 items-start gap-3 rounded-[var(--control-radius)] px-2 py-2 transition-colors duration-150 hover:bg-accent";
const NOTE = "text-[11px] leading-[14px] text-muted-foreground";
const WORD = "shrink-0 text-[13px] leading-5 text-muted-foreground";
const CHECK_MARK: Record<CheckState, LucideIcon> = { pass: CircleCheckIcon, fail: CircleXIcon, pending: CircleDashedIcon, skipped: CircleMinusIcon, cancelled: CircleMinusIcon };
const CHECK_INK: Record<CheckState, string> = { pass: "text-success", fail: "text-status-failed", pending: "text-muted-foreground", skipped: "text-muted-foreground", cancelled: "text-muted-foreground" };

function Section({ head, children }: { head: string; children: ReactNode }) {
  return (
    <section data-pr-section={head.toLowerCase()} className="mt-8 flex flex-col gap-0.5">
      <span className={cn(GROUP_LABEL, "flex h-6 items-center px-2 text-muted-foreground")}>{head}</span>
      {children}
    </section>
  );
}

/** An ISO time as the timeline orders and shows it. */
const when = (at: string): number => (Number.isNaN(Date.parse(at)) ? 0 : Date.parse(at));

export function PullRequestSurface({ workspaceId }: { workspaceId: string }) {
  const seen = useStatus(workspaceId)?.pr;
  const workspace = useWorkspace(workspaceId);
  const projects = useProjects();
  const view = useStore(s => s.api?.pullRequestView);
  const [page, setPage] = useState<PullRequestPage | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [asked, setAsked] = useState(0);
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
  const timeline = page === null ? [] : [
    ...page.commits.map(c => ({ key: `c:${c.oid}`, at: c.at, who: c.oid.slice(0, 7), what: PR_WORDS.committed, body: c.subject, mono: true })),
    ...page.comments.map((c, i) => ({ key: `m:${i}`, at: c.at, who: c.author, what: PR_WORDS.commented, body: c.body, mono: false })),
  ].sort((a, b) => when(a.at) - when(b.at));

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
        <div data-pr-facts className="mt-1 flex min-w-0 flex-wrap items-center gap-x-3 text-xs text-muted-foreground">
          <span data-pr-word>{capitalised(word)}</span>
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
        {page === null || page.body === "" ? null : <p className="mt-4 whitespace-pre-wrap text-sm text-foreground">{page.body}</p>}
      </div>

      {fact === null || fact.checks.length === 0 ? null : (
        <Section head={PR_WORDS.heads.checks}>
          {fact.checks.map(check => {
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

      {timeline.length === 0 ? null : (
        <Section head={PR_WORDS.heads.timeline}>
          {timeline.map(item => (
            <div key={item.key} data-pr-event className={ROW}>
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="flex min-w-0 items-center gap-3">
                  <span className={cn("truncate text-sm text-foreground", item.mono && "font-mono text-[13px] tabular-nums")}>{item.who}</span>
                  <span className={NOTE}>{item.what}</span>
                </span>
                <span className="whitespace-pre-wrap text-[12px] leading-4 text-muted-foreground">{item.body}</span>
              </div>
            </div>
          ))}
        </Section>
      )}
    </div>
  );
}
