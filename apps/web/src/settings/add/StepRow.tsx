// SPDX-License-Identifier: AGPL-3.0-only
// One row of a list of steps, before and while they run: the state mark, the
// name with its quiet note, and the time it took in the mono at the right. A
// row that needs the person opens under itself, inside the card, with what
// happened and the acts, in the refusal slot's two inks. An item under a step
// (one sign-in, one skill that did not land) steps in by the mark's width.
import type { ReactNode } from "react";
import { StateMark } from "../../components/status/StateMark.js";
import { Button } from "../../components/ui/button.js";
import { cn } from "../../lib/utils.js";
import { FACT } from "../format.js";
import { CARD_INSET, LINE_FLOOR, NOTE, SETTING_TITLE } from "../layout.js";
import type { StepLine } from "./setup.js";

/** A step's time in the mono: tenths under a second, seconds under a minute, then minutes and seconds. */
export function fmtStepMs(ms: number): string {
  if (ms < 950) return `${(ms / 1000).toFixed(1)} s`;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

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
        <span className={cn(FACT, "min-w-0 text-right")}>{row.ms === undefined ? "" : fmtStepMs(row.ms)}</span>
      </div>
      {row.said === undefined && children === undefined && acts === undefined ? null : (
        <div className={cn("flex flex-col gap-3 pb-4 pr-(--settings-inset,20px)", TEXT_EDGE, row.sub === true && "pl-[calc(var(--settings-inset,20px)+56px)]")}>
          {row.said === undefined || row.said === "" ? null : (
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

/** The act a step that did not land offers: Retry, which runs again whatever is missing, held while it asks. */
export function RetryActs({ onRetry, busy = false }: { onRetry: () => void; busy?: boolean }) {
  return (
    <Button size="xs" variant="outline" data-k="retry" held={busy} onClick={onRetry}>
      Retry
    </Button>
  );
}
