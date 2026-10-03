// SPDX-License-Identifier: AGPL-3.0-only
// A machine's or a step's state as one icon in its ink with the sentence on
// its tooltip, never a word in a cell: the thread tiles' marks (the crab while
// it works, the check once done, the question while it needs the person, the
// alert once it failed) and two quiet ones of its own for a machine that is
// pending or offline. Ready draws nothing, as a resting thread does.
import { CircleAlertIcon, CircleCheckIcon, CircleDashedIcon, MessageCircleQuestionIcon, UnplugIcon, type LucideIcon } from "lucide-react";
import { Crab } from "../../components/status/Crab.js";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip.js";
import { cn } from "../../lib/utils.js";

export type MarkState = "working" | "done" | "needs-you" | "failed" | "pending" | "offline" | "waiting" | "ready";

const MARKS: Record<Exclude<MarkState, "working" | "waiting" | "ready">, { ink: string; glyph: LucideIcon }> = {
  done: { ink: "text-status-done", glyph: CircleCheckIcon },
  "needs-you": { ink: "text-status-input", glyph: MessageCircleQuestionIcon },
  failed: { ink: "text-status-failed", glyph: CircleAlertIcon },
  pending: { ink: "text-muted-foreground", glyph: CircleDashedIcon },
  offline: { ink: "text-muted-foreground", glyph: UnplugIcon },
};

/** The one word a state is read as, for a tooltip that says nothing more. */
export const MARK_WORDS: Record<MarkState, string> = {
  working: "Setting up",
  done: "Done",
  "needs-you": "Needs you",
  failed: "Failed",
  pending: "Pending",
  offline: "Offline",
  waiting: "Not started",
  ready: "Ready",
};

export function StateMark({ state, why, className }: { state: MarkState; why?: string; className?: string }) {
  if (state === "waiting" || state === "ready") return null;
  const label = why ?? MARK_WORDS[state];
  const inner =
    state === "working" ? (
      <Crab className="text-status-working" />
    ) : (
      (() => {
        const Glyph = MARKS[state].glyph;
        return <Glyph aria-hidden className={cn("size-3.5 shrink-0", MARKS[state].ink)} />;
      })()
    );
  return (
    <Tooltip>
      <TooltipTrigger render={<span data-state-mark={state} role="img" aria-label={label} className={cn("inline-flex shrink-0 items-center justify-center", className)} />}>
        {inner}
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}
