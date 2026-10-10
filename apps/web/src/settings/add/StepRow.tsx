// SPDX-License-Identifier: AGPL-3.0-only
// One row of a list of steps, before and while they run: the state mark (a
// muted empty circle for a step not started, a muted minus for one the person
// set aside, the crab for an agent's step at work), the name with its quiet
// note, and the time it took in the mono at the right. A row that needs the
// person opens under itself, inside the card, with what happened and the acts,
// in the refusal slot's two inks; a step that ran opens on a click to its last
// lines of output, its chevron turning. An item under a step (one sign-in, one
// skill that did not land) steps in by the mark's width.
import { ChevronRightIcon, CircleIcon, CircleMinusIcon } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import { COPY_KEYS_WORD, fmtDuration, fmtElapsed } from "@wsp/protocol";
import { Crab } from "../../components/status/Crab.js";
import { StateMark } from "../../components/status/StateMark.js";
import { Button } from "../../components/ui/button.js";
import { cn } from "../../lib/utils.js";
import { FACT } from "../format.js";
import { CARD_INSET, LINE_FLOOR, NOTE, SETTING_TITLE } from "../layout.js";
import type { StepLine } from "./setup.js";

/** Every running step's node on the page, rewritten off one interval while any is mounted. */
const ticking = new Set<() => void>();
let clock: ReturnType<typeof setInterval> | undefined;

/** A running step's time since `since`, in whole seconds, written to its own node once a second so no row draws
 * again for the clock. */
function Ticking({ since }: { since: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const write = () => {
      if (ref.current !== null) ref.current.textContent = fmtElapsed(Date.now() - since);
    };
    write();
    ticking.add(write);
    clock ??= setInterval(() => {
      for (const fn of ticking) fn();
    }, 1000);
    return () => {
      ticking.delete(write);
      if (ticking.size === 0 && clock !== undefined) {
        clearInterval(clock);
        clock = undefined;
      }
    };
  }, [since]);
  return <span ref={ref}>{fmtElapsed(Date.now() - since)}</span>;
}

/** Where a row's words start: the mark and its gap. */
const TEXT_EDGE = "pl-[calc(var(--settings-inset,20px)+28px)]";

/** A row that opens on its output: whether it is open, and the click that turns it, absent on a row in the same list
 * that has none, which keeps the chevron's room so every time stands on one edge. */
export interface StepToggle {
  open: boolean;
  onToggle?: () => void;
}

/** `agent` says the steps are an agent's own, whose step at work is the crab; a setup step's is the spinner. */
export function StepRow({ row, why, acts, toggle, agent = false, children }: { row: StepLine; why?: string; acts?: ReactNode; toggle?: StepToggle; agent?: boolean; children?: ReactNode }) {
  const quiet = row.state === "waiting";
  const line = (
    <>
      <span className="flex size-4 items-center justify-center">
        {quiet ? (
          <CircleIcon data-state-mark="waiting" role="img" aria-label="Not started" className="size-3.5 text-muted-foreground/60" />
        ) : row.state === "skipped" ? (
          <CircleMinusIcon data-state-mark="skipped" role="img" aria-label="Skipped" className="size-3.5 text-muted-foreground" />
        ) : agent && row.state === "working" ? (
          <span data-state-mark="working" role="img" aria-label="Working" className="inline-flex text-status-working">
            <Crab />
          </span>
        ) : (
          <StateMark state={row.state} {...(why === undefined ? {} : { why })} />
        )}
      </span>
      <span data-step-words className="flex min-w-0 flex-col">
        <span className={cn(SETTING_TITLE, "min-w-0 break-words", quiet && "font-normal text-muted-foreground")}>{row.name}</span>
        {row.note === undefined ? null : <span className={NOTE}>{row.note}</span>}
      </span>
      <span className="flex min-w-0 items-center justify-end gap-2">
        <span data-step-time className={cn(FACT, "min-w-0 text-right font-mono")}>
          {row.since !== undefined ? <Ticking since={row.since} /> : row.ms === undefined ? "" : fmtDuration(row.ms)}
        </span>
        {toggle === undefined ? null : toggle.onToggle === undefined ? <span aria-hidden className="size-3.5 shrink-0" /> : <ChevronRightIcon aria-hidden className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform duration-150", toggle.open && "rotate-90")} />}
      </span>
    </>
  );
  const grid = cn("grid grid-cols-[16px_minmax(0,1fr)_auto] items-center gap-x-3 py-3", CARD_INSET, LINE_FLOOR, row.sub === true && "pl-[calc(var(--settings-inset,20px)+28px)]");
  return (
    <div data-step-row={row.id} data-state={row.state} {...(toggle?.onToggle === undefined ? {} : { "data-open": toggle.open })} className="flex flex-col">
      {toggle?.onToggle === undefined ? (
        <div className={grid}>{line}</div>
      ) : (
        <button type="button" data-k="step-toggle" aria-expanded={toggle.open} onClick={toggle.onToggle} className={cn(grid, "w-full cursor-pointer text-left transition-colors duration-150 hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset")}>
          {line}
        </button>
      )}
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

/** The act a server set aside for want of a yes to copying its keys offers: the yes, held while it asks. */
export function CopyKeysAct({ onCopy, busy = false }: { onCopy: () => void; busy?: boolean }) {
  return (
    <Button size="xs" variant="outline" data-k="copy-keys" held={busy} onClick={onCopy}>
      {COPY_KEYS_WORD}
    </Button>
  );
}

/** Skip on a row that waits on the person or did not land: the host sets it aside and Settings finishes it later.
 * `bare` is the text alone, its box its text's edge and only its ink stepping on hover, for a line that wraps: where
 * it drops under the code it stands on the code's left edge. */
export function SkipAct({ word, onSkip, busy = false, bare = false }: { word: string; onSkip: () => void; busy?: boolean; bare?: boolean }) {
  return (
    <Button size="xs" variant="ghost" data-k="skip" held={busy} onClick={onSkip} {...(bare ? { className: "px-0 [:hover,[data-pressed]]:bg-transparent" } : {})}>
      {word}
    </Button>
  );
}
