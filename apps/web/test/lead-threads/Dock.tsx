// SPDX-License-Identifier: AGPL-3.0-only
// The bar in the composer's place: one piece for everything that stands where a person types when there is
// something else to show there. It is the question panel's own frame (#1619, PromptDock): the composer's glass shell,
// a head with the mark, the title and one quiet line under it with a fact at the right, settings cards in the body,
// and the dialog's foot with a quiet state at the left and the acts at the right. Three uses here: a subagent's page
// (who it is, its lead and the way back, its status and time, Stop, and the message box held until its lead can
// relay one), the agent's task list opened from the composer's drawer, and the question, which is PromptDock itself.
// The build pulls this frame out of PromptDock so all three are one component.
import { agentName } from "@wsp/catalog";
import { ListTodoIcon } from "lucide-react";
import type { ReactNode } from "react";
import type { SidebarThreadSnapshot } from "../../src/adapt/index";
import { ComposerSurface } from "../../src/components/chat/ComposerSurface";
import { HarnessMark } from "../../src/components/chat/HarnessMark";
import { restingAge } from "../../src/components/status/restingAge";
import { ThreadStatus } from "../../src/components/status/ThreadStatus";
import { ThreadLink } from "../../src/components/ThreadLink";
import { Button } from "../../src/components/ui/button";
import { Input } from "../../src/components/ui/input";
import { cn } from "../../src/lib/utils";
import { useStore } from "../../src/protocol/store";
import { STEP_BODY, STEP_HEAD, StepFoot } from "../../src/settings/add/StepDialog";
import { StepRow } from "../../src/settings/add/StepRow";
import type { StepLine } from "../../src/settings/add/setup";
import { FACT } from "../../src/settings/format";
import { Grid } from "../../src/settings/grid";
import { GLYPH, NOTE } from "../../src/settings/layout";
import { Row } from "../../src/settings/rows";
import { CHILD_FACTS } from "./fixtures";
import { STOPPED } from "./LeadThreads";

/** PromptDock's own title and foot, read off it: the build exports them with the frame. */
const TITLE_CLASS = "text-base leading-6 font-semibold text-foreground";
const DOCK_FOOT = "pt-0 pb-5";

export const DOCK_WORDS = {
  subagentOf: "Subagent of",
  agent: "Agent",
  asked: "Asked",
  said: "Said",
  message: "Message this subagent",
  noMessage: "A message reaches a subagent through its lead, and wsp cannot relay one yet.",
  stop: "Stop",
  tasks: "Tasks",
  tasksDone: (done: number, all: number) => `${done} of ${all} done`,
  write: "Write a message instead",
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

/** A subagent's page bar: its task and status with the time it has run, its lead as the way back and its model,
 * what it was asked and what it said, the message box held with the reason, and Stop while it runs. */
export function SubagentDock({ subagent, lead }: { subagent: SidebarThreadSnapshot; lead: SidebarThreadSnapshot | undefined }) {
  const facts = CHILD_FACTS[subagent.threadId ?? subagent.id] ?? {};
  const running = subagent.status === "running";
  const stop = (): void => void useStore.getState().api?.interruptSession?.(subagent.sessionId);
  return (
    <Dock
      k="subagent"
      mark={<HarnessMark harness={subagent.harness} label={agentName(subagent.harness)} className={cn(GLYPH, "shrink-0")} />}
      title={subagent.title}
      aside={<ThreadStatus thread={subagent} age={restingAge(subagent)} crab {...(subagent.status === "interrupted" ? { kind: STOPPED } : {})} className="text-xs" />}
      note={
        <>
          {lead === undefined ? null : (
            <span className="inline-flex min-w-0 items-center gap-1">
              {DOCK_WORDS.subagentOf}
              <ThreadLink data-dock-lead thread={lead} className="min-w-0 truncate text-foreground" />
            </span>
          )}
          {facts.model === undefined ? null : <span>{facts.model}</span>}
        </>
      }
      foot={<span className={NOTE}>{DOCK_WORDS.noMessage}</span>}
      acts={
        running ? (
          <Button variant="outline" data-dock-stop className="[:hover,[data-pressed]]:text-destructive-foreground" onClick={stop}>
            {DOCK_WORDS.stop}
          </Button>
        ) : null
      }
    >
      <Grid id="subagent-facts">
        {facts.prompt === undefined ? null : <Row id="asked" title={DOCK_WORDS.asked} description={facts.prompt} />}
        {facts.summary === undefined ? null : <Row id="said" title={DOCK_WORDS.said} description={facts.summary} />}
      </Grid>
      <Input nativeInput disabled size="lg" placeholder={DOCK_WORDS.message} aria-label={DOCK_WORDS.message} data-dock-message />
    </Dock>
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
      aside={<span className={FACT}>{DOCK_WORDS.tasksDone(done, steps.length)}</span>}
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
