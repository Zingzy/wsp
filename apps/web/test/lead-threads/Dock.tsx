// SPDX-License-Identifier: AGPL-3.0-only
// The bar in the composer's place: one piece for everything that stands where a person types when there is
// something else to show there. It is the question panel's own frame (#1619, PromptDock): the composer's glass shell,
// a head with the mark, the title and one quiet line under it with a fact at the right, settings cards in the body,
// and the dialog's foot with a quiet state at the left and the acts at the right. Three uses here: a subagent's page
// (who it is, its lead and the way back, its status and time, Stop, and the message box held until its lead can
// relay one), the agent's task list opened from the composer's drawer, and the question, which is PromptDock itself.
// The build pulls this frame out of PromptDock so all three are one component.
import { agentName } from "@wsp/catalog";
import { fmtDuration } from "@wsp/protocol";
import { ArrowUpLeftIcon, ListTodoIcon } from "lucide-react";
import type { ReactNode } from "react";
import type { SidebarThreadSnapshot } from "../../src/adapt/index";
import { ComposerSurface } from "../../src/components/chat/ComposerSurface";
import { HarnessMark } from "../../src/components/chat/HarnessMark";
import { WorkingTimer } from "../../src/components/chat/timeline/working";
import { Button } from "../../src/components/ui/button";
import { cn } from "../../src/lib/utils";
import { useSidebarProjects, useStore } from "../../src/protocol/store";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../src/components/ui/tooltip";
import { STEP_BODY, STEP_HEAD, StepFoot } from "../../src/settings/add/StepDialog";
import { StepRow } from "../../src/settings/add/StepRow";
import type { StepLine } from "../../src/settings/add/setup";
import { Grid } from "../../src/settings/grid";
import { GLYPH, NOTE } from "../../src/settings/layout";
import { CHILD_FACTS } from "./fixtures";

/** PromptDock's own title and foot, read off it: the build exports them with the frame. */
const TITLE_CLASS = "text-base leading-6 font-semibold text-foreground";
const DOCK_FOOT = "pt-0 pb-5";

/** A count as the shipped task drawer writes it ("2/6"): the mono at the drawer's 12 px, muted. The drawer's rows and
 * the heads of the bars they open both write theirs in it, so a count reads the same one press apart. */
export const DRAWER_FACT = "font-mono text-xs tabular-nums text-muted-foreground";

export const DOCK_WORDS = {
  back: "Back to lead",
  backTo: (title: string) => `Back to ${title}`,
  workedFor: (ran: string | null) => (ran === null ? "Done" : `Worked for ${ran}`),
  failedWhy: (why: string) => (why === "" ? "Failed" : `Failed: ${why}`),
  stoppedAfter: (ran: string | null) => (ran === null ? "Stopped" : `Stopped after ${ran}`),
  working: "Working",
  workingFor: "Working for",
  done: "Done",
  stopped: "Stopped",
  failed: "Failed",
  tasks: "Tasks",
  tasksDone: (done: number, all: number) => `${done}/${all}`,
  write: "Write a message",
} as const;

/** The frame: the composer's shell, the head, the body's cards and the foot. */
export function Dock({ k, mark, title, aside, note, foot, acts, children }: { k: string; mark: ReactNode; title: string; aside?: ReactNode; note?: ReactNode; foot?: ReactNode; acts?: ReactNode; children?: ReactNode }) {
  return (
    <div className="px-3 pb-3 sm:px-4 sm:pb-4">
      <ComposerSurface.Shell data-dock={k}>
        <ComposerSurface.Host>
          <ComposerSurface.Main>
            <div className="flex min-w-0 flex-col" aria-label={title}>
              <div data-slot="dialog-header" className={STEP_HEAD}>
                <div className="flex min-w-0 flex-col gap-1">
                  <h2 data-dock-title className={cn(TITLE_CLASS, "flex min-w-0 items-center gap-2")}>
                    {mark}
                    <span className="min-w-0 break-words">{title}</span>
                  </h2>
                  {note === undefined ? null : (
                    <p data-dock-note className={cn(NOTE, "flex min-w-0 flex-wrap items-center gap-x-3")}>
                      {note}
                    </p>
                  )}
                </div>
                {aside === undefined ? null : <span className="flex shrink-0 items-center pt-0.5">{aside}</span>}
              </div>
              {children === undefined ? null : (
                <div data-slot="dialog-panel" className={STEP_BODY}>
                  {children}
                </div>
              )}
              <StepFoot data-dock-foot className={DOCK_FOOT} left={foot ?? null}>
                {acts}
              </StepFoot>
            </div>
          </ComposerSurface.Main>
        </ComposerSurface.Host>
      </ComposerSurface.Shell>
    </div>
  );
}

/** A subagent's page bar, after T3 Code's ProviderSubagentBar, on our composer's own grid: one row inside the
 * composer's shell, host and surface, at its height and padding, since nobody can write to a subagent and none of the
 * composer's strips belong to it. Where the composer's words stand, its state in the placeholder's type and ink: what
 * it is doing while it runs ("Working for", the timeline's own WorkingTimer, written straight to the page once a
 * second so a running subagent never draws the chat again), and once it ended how long it worked (its result is its
 * last message, right above), why it failed, or when it was stopped, clipped with the whole of it on hover; under
 * 640 px, where there is no hover, it wraps. The row keeps the composer's 48 px floor, which the composer gets from its
 * 32 px send button and this row's xs keycap does not give it. Where the model picker stands, the agent's
 * mark in its colour and the model in the picker's own box, a label and not a menu. Where the send button stands, the
 * way back to its lead as the language's inline act, the outline xs keycap with its glyph. Under 640 px the model is
 * its mark and the way back its arrow, their words on hover. Stop is on its row in the tree, on hover. A screen
 * reader hears the state once each time it changes. */
export function SubagentBar({ subagent }: { subagent: SidebarThreadSnapshot }) {
  const facts = CHILD_FACTS[subagent.threadId ?? subagent.id] ?? {};
  const fleet = useSidebarProjects();
  const lead = facts.subagentOf === undefined ? undefined : fleet.flatMap(project => project.threads).find(thread => (thread.threadId ?? thread.id) === facts.subagentOf);
  const running = subagent.status === "running";
  const ran = subagent.startedAt !== null && subagent.endedAt !== null ? fmtDuration(Date.parse(subagent.endedAt) - Date.parse(subagent.startedAt)) : null;
  const word = running ? DOCK_WORDS.working : subagent.status === "failed" ? DOCK_WORDS.failed : subagent.status === "interrupted" ? DOCK_WORDS.stopped : DOCK_WORDS.done;
  const ended =
    subagent.status === "failed"
      ? DOCK_WORDS.failedWhy(facts.why ?? "")
      : subagent.status === "interrupted"
        ? DOCK_WORDS.stoppedAfter(ran)
        : DOCK_WORDS.workedFor(ran);
  const model = facts.model ?? agentName(subagent.harness);
  const back = (): void => {
    if (lead?.threadId != null) useStore.getState().select(lead.workspaceId, lead.threadId);
  };
  const state = (
    <span
      data-subagent-state
      className="min-w-0 leading-relaxed break-words text-placeholder tabular-nums [font-family:var(--font-composer,var(--font-sans))] [font-size:var(--font-size-prompt,0.875rem)] max-sm:line-clamp-3 sm:truncate"
    >
      {running ? (
        <>
          {DOCK_WORDS.workingFor} <WorkingTimer createdAt={subagent.startedAt ?? new Date().toISOString()} />
        </>
      ) : (
        ended
      )}
    </span>
  );
  return (
    <div className="relative w-full px-3 pt-1.5 pb-4 sm:px-5 sm:pt-2 sm:pb-5" data-subagent-composer>
      <ComposerSurface.Shell>
        <ComposerSurface.Host>
          <div className="mx-auto w-full min-w-0 max-w-3xl">
            <ComposerSurface.Main>
              <div className="overflow-hidden rounded-[20px]">
                <div data-subagent-bar className="grid min-h-12 grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-1 py-2 ps-4 pe-2 sm:ps-5">
                  {running ? (
                    state
                  ) : (
                    <Tooltip>
                      <TooltipTrigger render={<span className="flex min-w-0" />}>{state}</TooltipTrigger>
                      <TooltipPopup side="top" className="max-w-96 whitespace-normal">
                        {ended}
                      </TooltipPopup>
                    </Tooltip>
                  )}
                  <span role="status" className="sr-only">
                    {word}
                  </span>
                  <Tooltip>
                    <TooltipTrigger
                      render={<span data-composer-picker="model" data-subagent-model className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-[var(--control-radius)] px-2 text-[13px] font-normal text-muted-foreground" />}
                    >
                      <span className="inline-flex text-foreground">
                        <HarnessMark harness={subagent.harness} label={agentName(subagent.harness)} className="size-4" />
                      </span>
                      <span className="max-sm:hidden">{model}</span>
                    </TooltipTrigger>
                    <TooltipPopup side="top">{`${agentName(subagent.harness)}, ${model}`}</TooltipPopup>
                  </Tooltip>
                  <span className="flex shrink-0 items-center justify-self-end">
                    {lead === undefined ? null : (
                      <Tooltip>
                        <TooltipTrigger render={<Button type="button" size="xs" variant="outline" data-subagent-back aria-label={DOCK_WORDS.backTo(lead.title)} onClick={back} />}>
                          <ArrowUpLeftIcon aria-hidden />
                          <span className="max-sm:hidden">{DOCK_WORDS.back}</span>
                        </TooltipTrigger>
                        <TooltipPopup side="top">{DOCK_WORDS.backTo(lead.title)}</TooltipPopup>
                      </Tooltip>
                    )}
                  </span>
                </div>
              </div>
            </ComposerSurface.Main>
          </div>
        </ComposerSurface.Host>
      </ComposerSurface.Shell>
    </div>
  );
}

/** The agent's task list, opened from the composer's drawer: each step with its mark and the time it took, and the
 * way back to the composer in the foot, as the question panel's Write a message instead. */
export function TaskDock({ steps, onWrite }: { steps: ReadonlyArray<StepLine>; onWrite: () => void }) {
  const done = steps.filter(step => step.state === "done").length;
  return (
    <Dock
      k="tasks"
      mark={<ListTodoIcon aria-hidden className={cn(GLYPH, "shrink-0")} />}
      title={DOCK_WORDS.tasks}
      aside={<span className={DRAWER_FACT}>{DOCK_WORDS.tasksDone(done, steps.length)}</span>}
      foot={
        <Button size="xs" variant="ghost" data-dock-write className="px-0 [:hover,[data-pressed]]:bg-transparent" onClick={onWrite}>
          {DOCK_WORDS.write}
        </Button>
      }
    >
      <Grid id="tasks">
        {steps.map(step => (
          <StepRow key={step.id} row={step} />
        ))}
      </Grid>
    </Dock>
  );
}
