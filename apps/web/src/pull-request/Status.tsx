// SPDX-License-Identifier: AGPL-3.0-only
// Status: where the pull request stands now, first under the tabs, under a Settings head, one card of rows. The checks
// are always its first row, folded under one line that counts them with a failure open with its fix; the review says
// each reviewer's standing verdict; the base says how far behind it is with the update; one sentence says what holds
// the merge; the buttons stand in the last row. A settled pull request says it merged or closed, with when, and the
// link out.
import { ArrowUpIcon, ChevronDownIcon, ChevronRightIcon, CircleCheckIcon, CircleDashedIcon, CircleMinusIcon, CircleXIcon, ExternalLinkIcon, GitBranchIcon, GitMergeIcon, GitPullRequestClosedIcon, MessageSquareIcon, ScanEyeIcon, type LucideIcon } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { START_WORDS, isPullRequestFact, type CheckState, type PullRequestCheck, type PullRequestFact, type PullRequestKept, type PullRequestItem, type PullRequestPage } from "@wsp/protocol";
import { Button } from "../components/ui/button.js";
import { formatRelativeTimeLabel } from "../lib/timestampFormat.js";
import { cn } from "../lib/utils.js";
import { CARD_SURFACE } from "../settings/rows.js";
import { SECTION_HEAD } from "../settings/layout.js";
import { askToFix, updateFromBase } from "./acts.js";
import type { Tone } from "./conversation.logic.js";
import { BOX_BUTTON, MergeControls } from "./MergeControls.js";
import { AgentMark, Faces, Hover, Who } from "./parts.js";
import { openComments } from "./conversation.logic.js";
import { CHECK_COUNT_WORDS, PR_WORDS, TONE_INK, authorName, spacedAgo, spanWord } from "./words.js";

const COUNT_ORDER: readonly CheckState[] = ["pass", "fail", "pending", "skipped", "cancelled"];
const CHECK_MARK: Record<CheckState, { icon: LucideIcon; tone: Tone }> = {
  pass: { icon: CircleCheckIcon, tone: "ok" },
  fail: { icon: CircleXIcon, tone: "bad" },
  pending: { icon: CircleDashedIcon, tone: "run" },
  skipped: { icon: CircleMinusIcon, tone: "quiet" },
  cancelled: { icon: CircleMinusIcon, tone: "quiet" },
};

/** The worst of the checks, which the checks line wears: a failure, else one running, else all passed. */
function worstCheck(checks: readonly PullRequestCheck[]): CheckState {
  return checks.some(c => c.state === "fail") ? "fail" : checks.some(c => c.state === "pending") ? "pending" : checks.every(c => c.state === "pass") ? "pass" : "skipped";
}

/** The checks line: "3 passed, 1 failed, 1 running". */
export function checksLine(checks: readonly PullRequestCheck[]): string {
  return COUNT_ORDER.flatMap(state => {
    const n = checks.filter(c => c.state === state).length;
    return n === 0 ? [] : [`${n} ${CHECK_COUNT_WORDS[state]}`];
  }).join(", ");
}

/** Each reviewer's standing verdict where it approved or asked for changes. */
export function verdictsOf(latest: PullRequestPage["latestReviews"]): { author: string; approved: boolean }[] {
  return latest.flatMap(r => {
    const state = r.state.toLowerCase();
    return state === "approved" || state === "changes_requested" ? [{ author: r.author, approved: state === "approved" }] : [];
  });
}

/** What holds the merge, in one sentence; nothing where it is ready. */
export function holdLine(fact: PullRequestFact): string {
  const W = PR_WORDS.hold;
  if (fact.mergeable === "conflicting") return W.conflicts;
  if (fact.autoMerge !== undefined) return PR_WORDS.mergesWhenChecksPass(fact.autoMerge.method);
  if (fact.checks.some(c => c.state === "fail" || c.state === "pending")) return W.checks;
  if (fact.draft) return W.draft;
  if (fact.review === "required" || fact.review === "changes_asked") return W.review;
  if (fact.mergeable === "unknown") return W.unknown;
  return W.ready;
}

/** One row of the card, every part on its first 20 px line: a label of several lines keeps its mark on the first, and
 * a button stands in the line's height rather than pushing the row taller. */
function BoxRow({ k, lead, label, value, end, sub = false, className }: { k: string; lead?: ReactNode; label: ReactNode; value?: ReactNode; end?: ReactNode; sub?: boolean; className?: string }) {
  return (
    <div data-pr-box-row={k} className={cn("flex items-start gap-3 text-[13px] leading-5 [&>button]:-my-1 [&>svg]:mt-[2.5px] [&>svg]:shrink-0", sub ? "min-h-9 bg-foreground/[0.02] py-2 pr-3.5 pl-[39px]" : "min-h-12 p-3.5", className)}>
      <span className={cn("flex min-w-0 flex-1 items-start leading-5 [&>svg]:shrink-0", sub ? "gap-2 [&>svg]:mt-[3.5px] [&>svg]:size-[13px]" : "gap-2.5 [&>svg]:mt-[2.5px] [&>svg]:size-[15px]")}>
        {lead}
        {label}
      </span>
      {value === undefined ? null : <span className="leading-5 text-muted-foreground">{value}</span>}
      {end}
    </div>
  );
}

function CheckRows({ checks, open, onToggle, workspaceId, name, agent }: { checks: readonly PullRequestCheck[]; open: boolean; onToggle: () => void; workspaceId: string; name: string; agent: { id: string; name: string } }) {
  const worst = CHECK_MARK[worstCheck(checks)];
  const Fold = open ? ChevronDownIcon : ChevronRightIcon;
  const grouped = (["pass", "skipped", "cancelled"] as const).flatMap(state => {
    const held = checks.filter(c => c.state === state);
    return held.length === 0 ? [] : [{ state, held }];
  });
  return (
    <>
      <button type="button" data-pr-checks aria-expanded={open} onClick={onToggle} className="w-full cursor-pointer text-left transition-colors duration-150 hover:bg-accent/60">
        <BoxRow k="checks" lead={<worst.icon aria-hidden className={TONE_INK[worst.tone]} />} label={PR_WORDS.checks} value={checksLine(checks)} end={<Fold aria-hidden className="size-[15px] shrink-0 text-muted-foreground/70" />} />
      </button>
      {!open
        ? null
        : [
            ...checks
              .filter(c => c.state === "fail")
              .map(c => (
                <BoxRow
                  key={`fail:${c.name}`}
                  k={`check:${c.name}`}
                  sub
                  lead={<CircleXIcon aria-hidden className={TONE_INK.bad} />}
                  label={
                    <span data-pr-check={c.name} className="flex min-w-0 flex-col items-start gap-1.5 leading-5 [&>small]:leading-[18px] [&>span:last-child]:mt-0.5">
                      {c.link === undefined ? <span>{c.name}</span> : <a href={c.link} target="_blank" rel="noopener noreferrer" className="hover:underline">{c.name}</a>}
                      {failedNote(c) === undefined ? null : <small className="text-xs text-muted-foreground">{failedNote(c)}</small>}
                      <span>
                        <Button type="button" variant="outline" data-pr-fix={c.name} className={BOX_BUTTON} onClick={() => void askToFix(workspaceId, name, c.name)}>
                          <AgentMark agent={agent} />
                          {PR_WORDS.fix}
                        </Button>
                      </span>
                    </span>
                  }
                />
              )),
            ...checks
              .filter(c => c.state === "pending")
              .map(c => <BoxRow key={`run:${c.name}`} k={`check:${c.name}`} sub lead={<CircleDashedIcon aria-hidden className={TONE_INK.run} />} label={<span data-pr-check={c.name} className="truncate">{c.name}</span>} value={c.startedAt === undefined ? CHECK_COUNT_WORDS.pending : PR_WORDS.runningFor(spanWord(Date.now() - Date.parse(c.startedAt)))} />),
            ...grouped.map(({ state, held }) => {
              const Mark = CHECK_MARK[state].icon;
              const where = [...new Set(held.flatMap(c => (c.workflow === undefined ? [] : [c.workflow])))].join(", ");
              return <BoxRow key={state} k={`checks:${state}`} sub lead={<Mark aria-hidden className={TONE_INK[CHECK_MARK[state].tone]} />} label={`${held.length} ${CHECK_COUNT_WORDS[state]}`} {...(where === "" ? {} : { value: where })} />;
            }),
          ]}
    </>
  );
}

/** Under a failed check: its workflow and how long it ran before it failed, where the host read when. */
function failedNote(c: PullRequestCheck): string | undefined {
  if (c.startedAt !== undefined && c.completedAt !== undefined) return PR_WORDS.failedAfter(c.workflow, spanWord(Date.parse(c.completedAt) - Date.parse(c.startedAt)));
  return c.workflow ?? c.description;
}

function reviewSentence(verdicts: readonly { author: string; approved: boolean }[]): string {
  return verdicts.map(v => `${authorName(v.author)} ${v.approved ? "approved" : "asked for changes"}`).join(", ");
}

export function StatusBox(o: {
  workspaceId: string;
  name: string;
  seen: PullRequestFact | PullRequestKept;
  page: PullRequestPage | null;
  base: string;
  agent: { id: string; name: string };
  reviewing: boolean;
  onReview: () => void;
  sendAll?: ((items: readonly PullRequestItem[]) => void) | undefined;
  sending?: readonly PullRequestItem[];
}) {
  const { workspaceId, name, seen, page, base, agent } = o;
  const fact = isPullRequestFact(seen) ? seen : null;
  const settled = seen.state !== "open";
  const [checksOpen, setChecksOpen] = useState(!settled);
  // The checks fold shut as the pull request settles, and open again should it reopen.
  useEffect(() => setChecksOpen(!settled), [settled]);
  const checks = fact?.checks ?? (isPullRequestFact(seen) ? [] : (seen.checks ?? []));
  const rows: ReactNode[] = [];

  if (checks.length > 0) rows.push(<CheckRows key="checks" checks={checks} open={checksOpen} onToggle={() => setChecksOpen(v => !v)} workspaceId={workspaceId} name={name} agent={agent} />);

  if (seen.state === "merged" || seen.state === "closed") {
    const merged = seen.state === "merged";
    const kept = isPullRequestFact(seen) ? undefined : merged ? seen.mergedAt : seen.closedAt;
    const read = merged ? page?.mergedAt : page?.closedAt;
    const at = read !== undefined && read !== "" ? read : kept === undefined ? undefined : new Date(kept).toISOString();
    const Mark = merged ? GitMergeIcon : GitPullRequestClosedIcon;
    const by = merged ? page?.mergedBy : undefined;
    rows.push(
      <BoxRow
        key="settled"
        k="settled"
        lead={<Mark aria-hidden className={TONE_INK[merged ? "merged" : "quiet"]} />}
        label={
          by === undefined || by === "" ? (
            merged ? PR_WORDS.merged : PR_WORDS.closedNotMerged
          ) : (
            <span className="flex min-w-0 items-center gap-1.5">
              {PR_WORDS.mergedBy} <Who login={by} size={18} />
            </span>
          )
        }
        {...(at === undefined ? {} : { value: spacedAgo(formatRelativeTimeLabel(at)) })}
      />,
    );
    if (merged && page?.mergeCommit !== undefined && page.mergeCommit !== "") {
      rows.push(
        <BoxRow
          key="landed"
          k="landed"
          sub
          label={
            <span>
              {PR_WORDS.landedAs(seen.base)} <code className="font-mono">{page.mergeCommit.slice(0, 7)}</code>
            </span>
          }
        />,
      );
    }
  }

  if (fact !== null && fact.state === "open") {
    const verdicts = page === null ? [] : verdictsOf(page.latestReviews);
    const asked = verdicts.some(v => !v.approved);
    const reviewTone: Tone = asked ? "warn" : verdicts.length > 0 ? "ok" : "quiet";
    rows.push(
      <BoxRow
        key="review"
        k="review"
        lead={<ScanEyeIcon aria-hidden className={TONE_INK[reviewTone]} />}
        label={PR_WORDS.review}
        {...(verdicts.length > 0
          ? { value: <span className="text-right">{<Faces logins={verdicts.map(v => v.author)} />}{reviewSentence(verdicts)}</span> }
          : fact.review === "required"
            ? { value: PR_WORDS.reviewRequired }
            : {})}
        {...(o.reviewing
          ? {}
          : {
              end: (
                <Hover words={START_WORDS.reviewWithAgent}>
                  <Button type="button" variant="outline" size="icon" data-pr-review-agent aria-label={START_WORDS.reviewWithAgent} className="size-7 rounded-[7px] [&_svg]:size-[13px]" onClick={o.onReview}>
                    <ScanEyeIcon aria-hidden />
                  </Button>
                </Hover>
              ),
            })}
      />,
    );
    const open = page === null ? null : openComments(page);
    if (open !== null && open.items.length > 0) {
      rows.push(
        <BoxRow
          key="comments"
          k="comments"
          lead={<MessageSquareIcon aria-hidden className="text-muted-foreground" />}
          label={PR_WORDS.comments}
          value={PR_WORDS.unresolved(open.items.length, open.word)}
          {...(o.sendAll === undefined
            ? {}
            : {
                end: (
                  <Button type="button" variant="outline" data-pr-send-all className={BOX_BUTTON} disabled={(o.sending ?? []).length > 0} onClick={() => o.sendAll?.(open.items)}>
                    <AgentMark agent={agent} />
                    {PR_WORDS.sendAll}
                  </Button>
                ),
              })}
        />,
      );
    }
    const behind = fact.behindBase ?? 0;
    if (fact.mergeable === "conflicting") {
      rows.push(
        <BoxRow
          key="base"
          k="base"
          lead={<GitBranchIcon aria-hidden className="text-muted-foreground" />}
          label={base}
          value={PR_WORDS.conflicts}
          end={
            <Button type="button" variant="outline" data-pr-fix-conflicts className={BOX_BUTTON} onClick={() => void askToFix(workspaceId, name)}>
              <AgentMark agent={agent} />
              {PR_WORDS.fix}
            </Button>
          }
        />,
      );
    } else if (behind > 0) {
      rows.push(
        <BoxRow
          key="base"
          k="base"
          lead={<GitBranchIcon aria-hidden className="text-muted-foreground" />}
          label={base}
          value={PR_WORDS.behind(behind)}
          end={
            <Button type="button" variant="outline" data-pr-update className={BOX_BUTTON} onClick={() => void updateFromBase(workspaceId, name)}>
              <ArrowUpIcon aria-hidden />
              {PR_WORDS.update(base)}
            </Button>
          }
        />,
      );
    }
    rows.push(<BoxRow key="hold" k="hold" lead={<GitMergeIcon aria-hidden className="text-muted-foreground" />} label={<span data-pr-hold>{holdLine(fact)}</span>} />);
    rows.push(
      <div key="end" data-pr-box-row="end" className="flex min-h-11 flex-wrap items-center justify-end gap-2 px-3.5 py-2">
        <MergeControls workspaceId={workspaceId} name={name} fact={fact} repo={page?.merge} />
      </div>,
    );
  } else if (settled) {
    rows.push(
      <div key="end" data-pr-box-row="end" className="flex min-h-11 items-center justify-end gap-2 px-3.5 py-2">
        <Button type="button" variant="outline" data-pr-open-github className={BOX_BUTTON} render={<a href={seen.url} target="_blank" rel="noopener noreferrer" />}>
          <ExternalLinkIcon aria-hidden />
          {PR_WORDS.openOnGitHub}
        </Button>
      </div>,
    );
  }

  return (
    <section data-pr-status className="flex flex-col gap-2.5">
      <h3 className={SECTION_HEAD}>{PR_WORDS.heads.status}</h3>
      <div className={cn(CARD_SURFACE, "flex flex-col [&>*+*]:border-t [&>*+*]:border-border/50")}>{rows}</div>
    </section>
  );
}
