// SPDX-License-Identifier: AGPL-3.0-only
// The agent's step list in the composer's place: Tasks with done of all at the
// head's right, then a card of the steps, each with its mark and how long it
// took, the step at work ticking.
import { ListTodoIcon } from "lucide-react";
import type { TaskStep } from "../../../adapt/view-model";
import { StepRow } from "../../../settings/add/StepRow";
import type { StepLine } from "../../../settings/add/setup";
import { Grid } from "../../../settings/grid";
import { GLYPH } from "../../../settings/layout";
import { DRAWER_WORDS } from "../ComposerDrawer";
import { Dock, DockBack } from "../Dock";
import { foldBar, useBarRoot } from "../composerBar";
import type { ComposerTasks } from "../composerTasks.logic";

const STATE: Record<TaskStep["state"], StepLine["state"]> = { done: "done", working: "working", pending: "waiting" };

const lineOf = (step: TaskStep): StepLine => ({
  id: step.key,
  name: step.text,
  state: STATE[step.state],
  ...(step.durationMs !== undefined ? { ms: step.durationMs } : step.state === "working" && step.startedAt !== undefined ? { since: step.startedAt } : {}),
});

export function TasksBar({ tasks, threadKey, workspaceId }: { tasks: ComposerTasks; threadKey: string; workspaceId: string }) {
  const barRoot = useBarRoot(threadKey, workspaceId);
  return (
    <Dock
      {...barRoot}
      shell={{ "data-composer-bar": "tasks" }}
      mark={<ListTodoIcon aria-hidden className={GLYPH} />}
      title={DRAWER_WORDS.tasks}
      aside={<span className="font-mono">{`${tasks.done}/${tasks.total}`}</span>}
      back={<DockBack word={DRAWER_WORDS.write} onClick={() => foldBar(threadKey, workspaceId)} />}
    >
      <Grid id="composer-tasks">
        {tasks.steps.map(step => (
          <StepRow key={step.key} row={lineOf(step)} agent />
        ))}
      </Grid>
    </Dock>
  );
}
