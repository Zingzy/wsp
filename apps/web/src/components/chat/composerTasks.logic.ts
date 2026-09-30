// SPDX-License-Identifier: AGPL-3.0-only
// When the composer's top edge carries the agent's step list, and what it says:
// only while the turn that wrote the list runs, and never while the agent asks
// the person something, since then the question is the one thing to read.
import type { PermissionPrompt, TaskStep, TurnPlan, TurnSummary } from "../../adapt/view-model";

export interface ComposerTasks {
  /** The step the turn is on: the one working, else the first still to do. */
  readonly step: string;
  readonly done: number;
  readonly total: number;
  readonly steps: ReadonlyArray<TaskStep>;
}

export function composerTasks(o: { latestTurn: TurnSummary | null; running: boolean; plan: TurnPlan | null; asking: boolean }): ComposerTasks | null {
  const { latestTurn, plan } = o;
  if (!o.running || latestTurn === null || latestTurn.state !== "running" || o.asking) return null;
  if (plan === null || plan.turnId !== latestTurn.turnId) return null;
  const current = plan.steps.find(step => step.state === "working") ?? plan.steps.find(step => step.state === "pending");
  if (current === undefined) return null;
  return { step: current.text, done: plan.steps.filter(step => step.state === "done").length, total: plan.steps.length, steps: plan.steps };
}

/** Whether the thread stands on a question to the person: a prompt of its own nobody has answered, or another
 * thread's that its own running call waits on. */
export function asksThePerson(prompts: ReadonlyArray<PermissionPrompt>, waitingOnAnother: boolean): boolean {
  return waitingOnAnother || prompts.some(prompt => prompt.outcome === null);
}
