// SPDX-License-Identifier: AGPL-3.0-only
// What the export dialog computes from the wire and the store: the step rows
// an export passes, which events are its own, the agent rows the workspace's
// threads give it and the request their ticks become, where a picked parent
// folder lands the project, and the landed line. No React here.
import type { ProjectExportEvent, ProjectExportResult, ProjectExportStage, SessionView } from "@wsp/protocol";
import { agentOutcomes, count, folderName, stepRows, type StepRow } from "./projectTrip.js";

/** The steps every export passes in order; `failed` is not a step, it is the error line. */
export const EXPORT_STEPS = ["packing", "downloading", "landing", "done"] as const satisfies readonly ProjectExportStage[];
export type ExportStep = (typeof EXPORT_STEPS)[number];

export const exportStepRows = (events: readonly ProjectExportEvent[]): StepRow<ExportStep>[] => stepRows(EXPORT_STEPS, events);

/** Whether an event is this export's: the runtime echoes the destination as sent. */
export function isExportOf(e: ProjectExportEvent, workspaceId: string, dest: string): boolean {
  return e.workspaceId === workspaceId && e.dest === dest;
}

/** One row per agent that ran a thread on the workspace, by harness id, in first-seen order. */
export function agentRows(sessions: readonly SessionView[] | undefined): string[] {
  return [...new Set((sessions ?? []).map(s => s.harness))];
}

/** The request the ticks become: nothing while every row is ticked, so every agent with sessions comes home; else the ticked ids. */
export function agentsRequest(rows: readonly string[], ticked: ReadonlySet<string>): string[] | undefined {
  return rows.every(r => ticked.has(r)) ? undefined : rows.filter(r => ticked.has(r));
}

/** A folder picker can only name a folder that exists, so the project lands inside it under its own name. */
export function pickedDest(picked: string, source: string): string {
  return `${picked.replace(/\/+$/, "")}/${folderName(source)}`;
}

/** Where the folder landed on this Mac, the caches left behind and what became of each agent's sessions. */
export function exportLandedLine(result: ProjectExportResult, source: string): string {
  const caches = result.excluded.length === 0 ? "" : `; ${count(result.excluded.length, "cache")} left behind`;
  const sessions = result.agents.length === 0 ? "no agent sessions for it on the machine" : `sessions: ${agentOutcomes(result.agents)}`;
  return `${folderName(source)} is at ${result.dest} on this Mac${caches}; ${sessions}.`;
}
