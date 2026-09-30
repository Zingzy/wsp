// SPDX-License-Identifier: AGPL-3.0-only
// The agent's step list as one row attached to the composer's top edge while
// its turn runs, as T3 Code's ComposerTasksBadge: the word, the step it is on,
// done out of all, and a segment per step for a list of 2 to 10. A click opens
// the whole list above it, each step with its mark and how long it took.
import { memo, useState } from "react";
import { ChevronDownIcon, ListTodoIcon } from "lucide-react";
import { fmtDuration } from "@wsp/protocol";
import type { TaskStep } from "../../adapt/view-model";
import { cn } from "../../lib/utils";
import type { ComposerTasks as Tasks } from "./composerTasks.logic";

const MAX_SEGMENTS = 10;

function Segments({ steps }: { steps: ReadonlyArray<TaskStep> }) {
  if (steps.length < 2 || steps.length > MAX_SEGMENTS) return null;
  return (
    <span aria-hidden data-composer-task-segments className="flex w-20 shrink-0 items-center gap-0.5">
      {steps.map(step => (
        <span
          key={step.key}
          className={cn(
            "h-[3px] min-w-0 flex-1 rounded-full",
            step.state === "done" ? "bg-success" : step.state === "working" ? "bg-primary" : "bg-muted-foreground/25",
          )}
        />
      ))}
    </span>
  );
}

const MARK: Record<TaskStep["state"], string> = { done: "✓", working: "●", pending: "○" };

export const ComposerTasks = memo(function ComposerTasks({ tasks }: { tasks: Tasks }) {
  const [open, setOpen] = useState(false);
  const label = `Tasks: ${tasks.done} of ${tasks.total} done. Current task: ${tasks.step}`;
  return (
    <div
      data-composer-tasks
      data-composer-banner-surface="attached"
      className="relative z-0 mx-auto -mb-6 w-[calc(100%-2*var(--chat-composer-drawer-inset))] rounded-t-[14px] border border-b-0 border-(--chat-composer-outline) bg-[color-mix(in_srgb,var(--chat-composer-glass-surface)_var(--chat-composer-glass-opacity),transparent)] px-1 pt-1 pb-6 text-xs leading-4 off-mac:glass-backdrop"
    >
      {open ? (
        <ul aria-label={`Task list. ${tasks.done} of ${tasks.total} done.`} data-composer-tasks-list className="max-h-56 overflow-y-auto px-2 pt-1 pb-1.5">
          {tasks.steps.map(step => (
            <li key={step.key} data-composer-task={step.state} className="flex min-h-6 items-center gap-2">
              <span
                aria-hidden
                className={cn(
                  "w-3 shrink-0 text-center font-mono",
                  step.state === "done" ? "text-success" : step.state === "working" ? "text-primary" : "text-muted-foreground/40",
                )}
              >
                {MARK[step.state]}
              </span>
              <span className={cn("min-w-0 flex-1 truncate", step.state === "working" ? "text-foreground" : "text-muted-foreground")}>{step.text}</span>
              <span data-composer-task-duration className="w-12 shrink-0 text-end font-mono tabular-nums text-muted-foreground/60">
                {step.durationMs !== undefined ? fmtDuration(step.durationMs) : step.state === "working" ? "now" : null}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      <button
        type="button"
        aria-expanded={open}
        aria-label={label}
        data-composer-tasks-row
        onClick={() => setOpen(o => !o)}
        onPointerDown={event => event.preventDefault()}
        className="flex h-7 w-full min-w-0 items-center gap-2 rounded-lg px-2 text-start transition-colors duration-150 hover:bg-accent"
      >
        <ListTodoIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="shrink-0 text-muted-foreground">Tasks</span>
        <span data-composer-task-current className="min-w-0 flex-1 truncate text-foreground/80">
          {tasks.step}
        </span>
        <span data-composer-task-progress className="shrink-0 font-mono tabular-nums text-muted-foreground">
          {tasks.done}/{tasks.total}
        </span>
        <Segments steps={tasks.steps} />
        <ChevronDownIcon aria-hidden className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform duration-150", !open && "rotate-180")} />
      </button>
    </div>
  );
});
