// SPDX-License-Identifier: AGPL-3.0-only
// The Pull request pane: the workspace's pull request in the list grammar, its title as the link with its number,
// its word and its counts, then CHECKS, REVIEW, COMMENTS and the timeline of commits and conversation. A failed check
// carries the fix button; a comment on a line carries Send to thread, which quotes it into the composer for the
// person to send. The page is asked for as the pane opens and on its refresh, and never kept; the head reads the
// fact the host pushes on the workspace's status.
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { RefreshCwIcon } from "lucide-react";
import { CHECK_STATE_WORDS, capitalised, isPullRequestFact, isPullRequestNamed, pullRequestCounts, pullRequestWord, type PullRequestPage } from "@wsp/protocol";
import { Button } from "../components/ui/button.js";
import { sendToThread, prCommentQuote } from "../diffs/sendToThread.js";
import { MICRO_LABEL } from "../lib/microLabel.js";
import { cn } from "../lib/utils.js";
import { failureOf } from "../protocol/failure.js";
import { useProjects, useStatus, useStore, useWorkspace } from "../protocol/store.js";
import { askToFix, updateFromBase } from "./acts.js";
import { MergeControls } from "./MergeControls.js";
import { PR_WORDS } from "./words.js";

const ROW = "flex min-w-0 items-start gap-3 rounded-[var(--control-radius)] px-2 py-2 transition-colors duration-150 hover:bg-accent";
const NOTE = "text-[11px] leading-[14px] text-muted-foreground";
const WORD = "shrink-0 text-[13px] leading-5 text-muted-foreground";

function Section({ head, children }: { head: string; children: ReactNode }) {
  return (
    <section data-pr-section={head.toLowerCase()} className="mt-8 flex flex-col gap-0.5">
      <span className={cn(MICRO_LABEL, "flex h-6 items-center px-2 text-muted-foreground")}>{head}</span>
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
      <div data-pr-head className="flex flex-col gap-1 px-2">
        <div className="flex min-w-0 items-baseline gap-2">
          <a href={seen.url} target="_blank" rel="noopener noreferrer" data-pr-title className="min-w-0 truncate text-[15px] leading-5 font-medium text-foreground hover:underline">
            {page?.title ?? PR_WORDS.row(seen.number)}
          </a>
          <span className="shrink-0 font-mono text-[12px] text-muted-foreground tabular-nums">{PR_WORDS.number(seen.number)}</span>
        </div>
        <div className="flex min-w-0 items-center gap-3">
          <span data-pr-word className="text-[13px] text-muted-foreground">
            {word}
          </span>
          {fact === null ? null : (
            <span data-pr-counts className="flex gap-3 font-mono text-[11px] text-muted-foreground tabular-nums">
              {pullRequestCounts(fact).map(part => (
                <span key={part}>{part}</span>
              ))}
            </span>
          )}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {fact === null ? null : <MergeControls workspaceId={workspaceId} name={name} fact={fact} repo={page?.merge} />}
          {fact !== null && fact.state === "open" ? (
            <Button type="button" size="xs" variant="ghost" data-pr-update onClick={() => void updateFromBase(workspaceId, name)}>
              {PR_WORDS.update(base)}
            </Button>
          ) : null}
          {fact !== null && fact.mergeable === "conflicting" ? (
            <Button type="button" size="xs" variant="ghost" data-pr-fix-conflicts onClick={() => void askToFix(workspaceId, name)}>
              {PR_WORDS.fix}
            </Button>
          ) : null}
          <Button type="button" size="icon-xs" variant="ghost" aria-label={PR_WORDS.refresh} title={PR_WORDS.refresh} className="ms-auto" onClick={refresh}>
            <RefreshCwIcon aria-hidden className="size-3.5" />
          </Button>
        </div>
        {refusal === null ? null : <p className="mt-2 text-[13px] text-error-foreground">{refusal}</p>}
        {page === null || page.body === "" ? null : <p className="mt-3 whitespace-pre-wrap text-sm text-foreground">{page.body}</p>}
      </div>

      {fact === null || fact.checks.length === 0 ? null : (
        <Section head={PR_WORDS.heads.checks}>
          {fact.checks.map(check => (
            <div key={check.name} data-pr-check={check.name} className={ROW}>
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm text-foreground">
                  {check.link === undefined ? check.name : (
                    <a href={check.link} target="_blank" rel="noopener noreferrer" className="hover:underline">
                      {check.name}
                    </a>
                  )}
                </span>
                {check.workflow !== undefined ? <span className={NOTE}>{check.workflow}</span> : check.description !== undefined ? <span className={NOTE}>{check.description}</span> : null}
                {check.state === "fail" ? (
                  <span className="mt-1.5">
                    <Button type="button" size="xs" variant="outline" data-pr-fix={check.name} onClick={() => void askToFix(workspaceId, name, check.name)}>
                      {PR_WORDS.fix}
                    </Button>
                  </span>
                ) : null}
              </div>
              <span data-pr-check-state className={WORD}>
                {CHECK_STATE_WORDS[check.state]}
              </span>
            </div>
          ))}
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
