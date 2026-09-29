// SPDX-License-Identifier: AGPL-3.0-only
// The agent's step list for one turn, in the list grammar: the section caps
// with the count done beside them, then one row per step. A step's state is
// its ink and weight, never a colour.
import { memo } from "react";
import { CircleCheckIcon } from "lucide-react";
import type { PlanStep } from "@wsp/protocol";
import { cn } from "../../lib/utils";

export const TodoCard = memo(function TodoCard({ steps }: { steps: ReadonlyArray<PlanStep> }) {
  const done = steps.filter(step => step.state === "done").length;
  return (
    <div className="flex flex-col gap-0.5" data-todo-card>
      <div className="flex h-6 items-center gap-3" data-todo-header>
        <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-muted-foreground">Steps</span>
        <span className="font-mono text-xs tabular-nums text-muted-foreground">
          {done} of {steps.length} done
        </span>
      </div>
      {steps.map((step, index) => (
        <div
          key={index}
          data-todo-step={step.state}
          className={cn(
            "flex min-h-5 items-start gap-2 text-sm leading-5",
            step.state === "working" ? "font-medium text-foreground" : "text-muted-foreground",
          )}
        >
          <span className="flex h-5 w-3 shrink-0 items-center">{step.state === "done" ? <CircleCheckIcon className="size-3" /> : null}</span>
          <span className="min-w-0">{step.text}</span>
        </div>
      ))}
    </div>
  );
});
