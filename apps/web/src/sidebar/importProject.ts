// SPDX-License-Identifier: AGPL-3.0-only
// What the import dialog computes from the wire: which events are its own, an
// agent row's words and the landed line. The consent for the secret-shaped
// files and the agents with sessions, the request it becomes and the progress
// line the events fold into are the protocol's, shared with the command line.
// No React here.
import type { ProjectAgent, ProjectImportEvent, ProjectImportResult, ProjectPlan } from "@wsp/protocol";
import { agentOutcomes, count, folderName } from "./projectTrip.js";

export { agentsRequest, canTravel, consentRequest, defaultAgents, defaultConsent, importProgress, secretOffer } from "@wsp/protocol";

/** Whether an event is this import's: the runtime echoes the path as typed, the plan carries its realpath. */
export function isImportOf(e: ProjectImportEvent, workspaceId: string, source: string, plan: ProjectPlan | null): boolean {
  return e.workspaceId === workspaceId && (e.source === source || (plan !== null && e.source === plan.source));
}

/** The row's muted words: the sessions it holds, or why its store could not be read. */
export const agentState = (a: ProjectAgent): string => a.error ?? count(a.sessions, "session");

/** Where the folder landed, how many secret-shaped files were left out on the way and where their list is, and what became of each agent's sessions. */
export function landedLine(result: ProjectImportResult, source: string, workspaceName: string): string {
  const cut = result.cut.length > 0 ? `; ${count(result.cut.length, "file")} left out, listed above` : "";
  const sessions = result.agents.length > 0 ? `; sessions: ${agentOutcomes(result.agents)}` : "";
  return `${folderName(source)} is at ${result.dest} on ${workspaceName}${cut}${sessions}.`;
}
