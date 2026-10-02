// SPDX-License-Identifier: AGPL-3.0-only
// The Commits tab: day heads, then one plain rail with a 6 px dot per commit, the merge glyph in a merge's place with
// the branch it brought in as a chip and the row dimmed, since its lines are the base's. The author's face stands in
// its own column, then the subject, the line counts and the SHA; the time is on the row's hover.
import { GitMergeIcon } from "lucide-react";
import { useState } from "react";
import type { PullRequestPage } from "@wsp/protocol";
import { DiffStatLabel } from "../components/chat/DiffStatLabel.js";
import { formatRelativeTimeLabel } from "../lib/timestampFormat.js";
import { cn } from "../lib/utils.js";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip.js";
import { commitDays } from "./commits.logic.js";
import { CutNote, Face } from "./parts.js";
import { PR_WORDS } from "./words.js";

export function Commits({ commits, cut = false }: { commits: PullRequestPage["commits"]; cut?: boolean }) {
  const [open, setOpen] = useState<string | null>(null);
  if (commits.length === 0) return <p className="text-[13px] text-muted-foreground">{PR_WORDS.noCommits}</p>;
  return (
    <div data-pr-commits className="flex flex-col gap-4">
      {commitDays(commits).map(({ day, rows }) => (
        <section key={day} data-pr-day={day} className="flex flex-col gap-4">
          <h3 className="text-[13px] text-muted-foreground">{day}</h3>
          <ol className="relative flex flex-col gap-0.5 before:absolute before:top-2 before:bottom-2 before:left-[19.5px] before:w-px before:bg-border before:content-['']">
            {rows.map(row => (
              <li key={row.oid} data-pr-commit={row.oid} data-merge={row.merge || undefined}>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <button
                        type="button"
                        aria-expanded={row.body === "" ? undefined : open === row.oid}
                        onClick={() => setOpen(at => (row.body === "" || at === row.oid ? null : row.oid))}
                        className={cn("grid min-h-9 w-full grid-cols-[28px_18px_minmax(0,1fr)_84px_56px] items-center gap-2.5 rounded-[7px] px-1.5 text-left transition-colors duration-150 hover:bg-foreground/[0.04]", row.body !== "" && "cursor-pointer")}
                      />
                    }
                  >
                    <span aria-hidden className="relative z-[1] grid h-9 w-7 place-items-center">
                      {row.merge ? (
                        <GitMergeIcon data-pr-commit-merge className="size-[13px] rounded-[3px] bg-background text-muted-foreground shadow-[0_0_0_3px_var(--background)]" />
                      ) : (
                        <i className="block size-1.5 rounded-full bg-muted-foreground" />
                      )}
                    </span>
                    <Face login={row.author} size={18} />
                    <span className={cn("truncate text-[13.5px]", row.merge && "text-muted-foreground")}>
                      {row.from === undefined ? null : <span data-pr-commit-from className="mr-2 rounded border border-border px-[5px] py-px align-[1px] font-mono text-[11px] text-muted-foreground">{row.from}</span>}
                      {row.subject}
                    </span>
                    <span data-pr-commit-lines className="flex justify-end font-mono text-xs opacity-85">
                      {row.lines === undefined ? null : <DiffStatLabel additions={row.lines.additions} deletions={row.lines.deletions} layout="inline" whole className="gap-2" />}
                    </span>
                    <code className="text-right font-mono text-xs text-muted-foreground">{row.sha}</code>
                  </TooltipTrigger>
                  <TooltipPopup side="top" align="end">
                    <span data-pr-commit-ago>{formatRelativeTimeLabel(row.at)}</span>
                  </TooltipPopup>
                </Tooltip>
                {open === row.oid ? <p data-pr-commit-body className="pt-1 pr-1.5 pb-2 pl-[74px] text-[13px] leading-5 whitespace-pre-line text-muted-foreground">{row.body}</p> : null}
              </li>
            ))}
          </ol>
        </section>
      ))}
      {cut ? <CutNote words={PR_WORDS.cut.commits} /> : null}
    </div>
  );
}
