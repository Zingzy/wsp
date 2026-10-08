// SPDX-License-Identifier: AGPL-3.0-only
// The plan an agent keeps in its calls (TodoWrite, the task list, ExitPlanMode), read into one book per turn.

import type { PlanStep } from "@wsp/protocol";
import { rec, str } from "./fields.js";

/** The turn's plan as its calls so far built it. */
export interface PlanBook {
  /** The ids of the calls read as the plan, whose results are bookkeeping and draw nothing either. */
  calls: Set<string>;
  /** The list TaskCreate and TaskUpdate keep, in the order its tasks were made, each by the id the CLI gave it. */
  tasks: { id?: string; text: string; state: PlanStep["state"] }[];
  /** A TaskCreate's task by its call, until the call's result names the id the CLI gave it. */
  unnamed: Map<string, number>;
}

export const newPlanBook = (): PlanBook => ({ calls: new Set(), tasks: [], unnamed: new Map() });

const stepState = (status: unknown): PlanStep["state"] => (status === "completed" ? "done" : status === "in_progress" ? "working" : "pending");

/** A call the agent keeps its plan in, read into the book: TodoWrite's list whole each time the agent rewrites it,
 * 2.1.283's task list one TaskCreate or TaskUpdate at a time, and the Markdown ExitPlanMode proposes. Undefined for
 * any other call; null for a plan call with nothing new to show, a TaskList or a TaskGet. */
export function readPlanCall(name: string | undefined, input: unknown, id: string | undefined, book: PlanBook): { steps: PlanStep[] } | { text: string } | null | undefined {
  const fields = rec(input);
  const listed = (): { steps: PlanStep[] } => ({ steps: book.tasks.map(({ text, state }) => ({ text, state })) });
  switch (name) {
    case "TodoWrite": {
      if (!Array.isArray(fields?.todos)) return undefined;
      const todos = fields.todos.map(rec).filter((t): t is Record<string, unknown> => t !== undefined);
      return { steps: todos.map(t => ({ text: str(t.content) ?? "", state: stepState(t.status) })) };
    }
    case "ExitPlanMode": {
      const plan = str(fields?.plan);
      return plan === undefined ? undefined : { text: plan };
    }
    case "TaskCreate":
      if (id !== undefined) book.unnamed.set(id, book.tasks.length);
      book.tasks.push({ text: str(fields?.subject) ?? "", state: "pending" });
      return listed();
    case "TaskUpdate": {
      const at = book.tasks.findIndex(t => t.id !== undefined && t.id === str(fields?.taskId));
      if (at === -1) return null;
      if (fields?.status === "deleted") book.tasks.splice(at, 1);
      else book.tasks[at] = { ...book.tasks[at]!, ...(fields?.status !== undefined ? { state: stepState(fields.status) } : {}), ...(str(fields?.subject) !== undefined ? { text: str(fields?.subject)! } : {}) };
      return listed();
    }
    case "TaskList":
    case "TaskGet":
      return null;
    default:
      return undefined;
  }
}
