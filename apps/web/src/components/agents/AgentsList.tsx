// SPDX-License-Identifier: AGPL-3.0-only
// Agents, Skills and Servers: one component drawn twice. On a computer's page
// the rows stand in a card with the segment's act under it; in a task's panel
// they divide by hairlines with no card shell. Its root is the container
// every row and line lays itself out by. Before the first report three bars
// hold the list at a row's height; a read over a report dims it in place.
// Under the rows, only where it has any, a head-less card of lines: each
// reader that could not answer and each recipe row that is not there.
import { RefreshCwIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { offlineFor, type AgentsReport } from "@wsp/protocol";
import { cn } from "../../lib/utils.js";
import { FACT } from "../../settings/format.js";
import { CARD_SURFACE } from "../../settings/rows.js";
import { Button } from "../ui/button.js";
import { SegmentedControl } from "../ui/segmented-control.js";
import { Skeleton } from "../ui/skeleton.js";
import { Spinner } from "../ui/spinner.js";
import { AGENTS_LIST_WORDS, AGENTS_SEGMENTS, editImageAct, heldReason, pausedReport, refusedLines, segmentCounts, segmentRows, type AgentsSegment, type RefusedLine, type RowAct, type RowsContext } from "./agentsRows.js";
import { ActButton, ChipRow, OpenLine } from "./ChipRow.js";

export type AgentsShell = "page" | "panel";

export interface AgentsListProps {
  readonly shell: AgentsShell;
  readonly report: AgentsReport | null;
  readonly reading: boolean;
  /** The host's sentence for a read it refused, drawn only while no report stands. */
  readonly error?: string | null;
  /** What the empty lines name: the computer or the task. */
  readonly on: string;
  readonly ctx: RowsContext;
  /** Read again; absent where nothing is read, as on a cloud's page. */
  readonly onRefresh?: () => void;
  readonly now: number;
  /** Lines under the rows beside the report's own refusals: the recipe's rows that are not there. */
  readonly misses?: readonly RefusedLine[];
  /** What the panel's head carries at its right beside the glyph: the link to the computer's page. */
  readonly headLink?: ReactNode;
}

const PAGE_ROWS = cn(CARD_SURFACE, "flex flex-col divide-y divide-border");

function underAct(segment: AgentsSegment, ctx: RowsContext): RowAct | null {
  if (ctx.where === "provider" && segment !== "agents") return null;
  if ((ctx.where === "fork" || ctx.where === "provider") && segment === "agents") return editImageAct(ctx);
  const hold = heldReason(ctx);
  return { id: `under-${segment}`, label: AGENTS_LIST_WORDS.under[segment], ...(hold === undefined ? {} : { hover: hold }) };
}

export function AgentsList({ shell, report, reading, error = null, on, ctx, onRefresh, now, misses = [], headLink }: AgentsListProps) {
  const [segment, setSegment] = useState<AgentsSegment>("agents");
  const paused = pausedReport(report);
  const held = ctx.heldWhy ?? (paused ? AGENTS_LIST_WORDS.paused : null);
  const rowsCtx: RowsContext = held === null ? ctx : { ...ctx, heldWhy: held };
  const counts = report === null ? null : segmentCounts(report);
  const rows = report === null ? [] : segmentRows(report, segment, rowsCtx);
  const lines: RefusedLine[] = [...(report === null ? [] : refusedLines(report.refused)), ...misses, ...(report === null && error !== null ? [{ id: "read-refused", label: error }] : [])];
  const under = report === null ? null : underAct(segment, rowsCtx);
  const page = shell === "page";
  const readAgo = report === null ? undefined : AGENTS_LIST_WORDS.readAgo(offlineFor(now - Date.parse(report.readAt)));

  const head = (
    <div data-agents-head className={cn("flex items-center justify-between gap-3", !page && "px-4 pt-4 pb-3")}>
      <SegmentedControl
        value={segment}
        onChange={setSegment}
        segments={AGENTS_SEGMENTS.map(value => ({
          value,
          label: (
            <span className="flex items-center gap-1.5">
              {AGENTS_LIST_WORDS.segments[value]}
              {counts === null ? null : " "}
              {counts === null ? null : (
                <span data-segment-count className={FACT}>
                  {counts[value]}
                </span>
              )}
            </span>
          ),
        }))}
      />
      <span className="flex items-center gap-2">
        {headLink}
        {paused ? (
          <span data-k="agents-paused" className={FACT}>
            {AGENTS_LIST_WORDS.paused}
          </span>
        ) : null}
        {onRefresh === undefined ? null : reading ? (
          <span className="flex size-6 items-center justify-center">
            <Spinner className="size-3.5 text-muted-foreground" />
          </span>
        ) : (
          <span className="inline-flex" title={held ?? readAgo}>
            <Button data-k="agents-read-again" aria-label={AGENTS_LIST_WORDS.readAgain} size="icon-xs" variant="ghost" held={held !== null} onClick={onRefresh}>
              <RefreshCwIcon className="size-3.5" />
            </Button>
          </span>
        )}
      </span>
    </div>
  );

  const body =
    report === null ? (
      reading || error === null ? (
        [0, 1, 2].map(at => <Skeleton key={at} data-k="agents-skeleton" className="h-24 rounded-none @max-2xl:h-20" />)
      ) : null
    ) : rows.length === 0 ? (
      <p data-k="agents-empty" className={cn("flex h-11 items-center text-sm text-muted-foreground @max-2xl:h-14", page ? "px-5 @max-2xl:px-4" : "px-4")}>
        {AGENTS_LIST_WORDS.empty[segment](on)}
      </p>
    ) : (
      // A report read before the computer went quiet, or before the task paused, stands dimmed: it is not current.
      rows.map(row => <ChipRow key={row.id} row={row} dim={reading || held !== null} now={now} />)
    );

  return (
    <section data-agents-list data-shell={shell} aria-label={AGENTS_LIST_WORDS.section} className={cn("@container flex flex-col", page && "gap-3")}>
      {head}
      {body === null ? null : (
        <div data-agents-rows aria-busy={reading} className={page ? PAGE_ROWS : "flex flex-col divide-y divide-border border-y border-border"}>
          {body}
        </div>
      )}
      {under === null ? null : (
        <div data-agents-under className={cn("flex gap-2", !page && "px-4 py-3")}>
          <ActButton act={under} />
        </div>
      )}
      {lines.length === 0 ? null : (
        <div data-agents-refused className={page ? PAGE_ROWS : "flex flex-col divide-y divide-border border-y border-border"}>
          {lines.map(line => (
            <OpenLine key={line.id} line={line} fact className={page ? "px-5 @max-2xl:px-4" : "px-4"} />
          ))}
        </div>
      )}
    </section>
  );
}
