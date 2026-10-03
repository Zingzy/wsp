// SPDX-License-Identifier: AGPL-3.0-only
// One row of a list of steps, before and while they run: the state mark, the
// name with its quiet note, and the time it took in the mono at the right. A
// row that needs the person opens under itself, inside the card, with what
// happened and the acts, in the refusal slot's two inks. An item under a step
// (one sign-in, one skill that did not land) steps in by the mark's width.
import type { ReactNode } from "react";
import { Button } from "../../components/ui/button.js";
import { cn } from "../../lib/utils.js";
import { FACT } from "../../settings/format.js";
import { CARD_INSET, LINE_FLOOR, NOTE, SETTING_TITLE } from "../../settings/layout.js";
import type { StepLine } from "./fixtures.js";
import { StateMark } from "./StateMark.js";

export const fmtMs = (ms: number): string => (ms < 1000 ? `${(ms / 1000).toFixed(1)} s` : ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.floor(ms / 60_000)}:${String(Math.round((ms % 60_000) / 1000)).padStart(2, "0")}`);

/** Where a row's words start: the mark and its gap. */
const TEXT_EDGE = "pl-[calc(var(--settings-inset,20px)+28px)]";

export function StepRow({ row, why, acts, children }: { row: StepLine; why?: string; acts?: ReactNode; children?: ReactNode }) {
  const quiet = row.state === "waiting";
  return (
    <div data-step-row={row.id} data-state={row.state} className="flex flex-col">
      <div className={cn("grid grid-cols-[16px_minmax(0,1fr)_auto] items-center gap-x-3 py-3", CARD_INSET, LINE_FLOOR, row.sub === true && "pl-[calc(var(--settings-inset,20px)+28px)]")}>
        <span className="flex size-4 items-center justify-center">
          <StateMark state={row.state} {...(why === undefined ? {} : { why })} />
        </span>
        <span className="flex min-w-0 flex-col">
          <span className={cn(SETTING_TITLE, "min-w-0 break-words", quiet && "font-normal text-muted-foreground")}>{row.name}</span>
          {row.note === undefined ? null : <span className={NOTE}>{row.note}</span>}
        </span>
        <span className={cn(FACT, "min-w-0 text-right")}>{row.ms === undefined ? "" : fmtMs(row.ms)}</span>
      </div>
      {row.said === undefined && children === undefined ? null : (
        <div className={cn("flex flex-col gap-3 pb-4 pr-(--settings-inset,20px)", TEXT_EDGE, row.sub === true && "pl-[calc(var(--settings-inset,20px)+56px)]")}>
          {row.said === undefined ? null : (
            <p data-k="step-refusal" className="text-[13px] leading-[18px] text-destructive-foreground">
              {row.said}
              {row.fix === undefined ? null : <span className="text-foreground"> {row.fix}</span>}
            </p>
          )}
          {children}
          {acts === undefined ? null : <div className="flex flex-wrap items-center gap-2">{acts}</div>}
        </div>
      )}
    </div>
  );
}

/** The two acts a failed step offers, and the one a blocked one does. */
export function RetryActs({ skip = true }: { skip?: boolean }) {
  return (
    <>
      <Button size="xs" variant="outline">
        Retry
      </Button>
      {skip ? (
        <Button size="xs" variant="ghost">
          Skip
        </Button>
      ) : null}
    </>
  );
}
