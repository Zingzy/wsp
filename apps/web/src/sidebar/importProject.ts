// SPDX-License-Identifier: AGPL-3.0-only
// What the import dialog computes from the wire: the steps an import passes,
// which events are its own, the consent it asks for and the request that
// consent becomes. No React here.
import type { ProjectImportEvent, ProjectImportResult, ProjectImportStage, ProjectPlan, ProjectSecret } from "@wsp/protocol";
import { agentOutcomes, folderName, stepRows, type StepRow } from "./projectTrip.js";

/** The steps every import passes in order; `failed` is not a step, it is the error line. */
export const IMPORT_STEPS = ["planned", "consented", "packing", "uploading", "landing", "done"] as const satisfies readonly ProjectImportStage[];
export type ImportStep = (typeof IMPORT_STEPS)[number];

export const importStepRows = (events: readonly ProjectImportEvent[]): StepRow<ImportStep>[] => stepRows(IMPORT_STEPS, events);

/** Whether an event is this import's: the runtime echoes the path as typed, the plan carries its realpath. */
export function isImportOf(e: ProjectImportEvent, workspaceId: string, source: string, plan: ProjectPlan | null): boolean {
  return e.workspaceId === workspaceId && (e.source === source || (plan !== null && e.source === plan.source));
}

/** A rewrite removes the credentials, so it starts ticked; a file that would travel as it is never does. */
export function defaultConsent(secrets: readonly ProjectSecret[]): ReadonlySet<string> {
  return new Set(secrets.filter(s => s.rewrite !== undefined).map(s => s.path));
}

/** The request the ticks become: offered files rewrite, the rest carry; everything unticked is cut and named by the runtime. */
export function consentRequest(secrets: readonly ProjectSecret[], ticked: ReadonlySet<string>): { carry: string[]; rewrite: string[] } {
  const chosen = secrets.filter(s => ticked.has(s.path));
  return {
    carry: chosen.filter(s => s.rewrite === undefined).map(s => s.path),
    rewrite: chosen.filter(s => s.rewrite !== undefined).map(s => s.path),
  };
}

const host = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/** The row's words for its tick: cut, travels as it is, or lands bare at its hosts (the URLs whole in the title) without the dropped keys. */
export function secretOffer(s: ProjectSecret, ticked: boolean): { short: string; full: string } {
  if (!ticked) return { short: "cut", full: "cut" };
  if (s.rewrite === undefined) return { short: "travels as it is", full: "travels as it is" };
  const without = s.rewrite.drop.length > 0 ? ` without ${s.rewrite.drop.join(", ")}` : "";
  const bare = (urls: readonly string[]): string => (urls.length > 0 ? ` bare at ${urls.join(", ")}` : "");
  return { short: `lands${bare([...new Set(s.rewrite.urls.map(host))])}${without}`, full: `lands${bare(s.rewrite.urls)}${without}` };
}

/** Where the folder landed, which secret-shaped files were cut on the way as the consent box promised, and what became of each agent's sessions. */
export function landedLine(result: ProjectImportResult, source: string, workspaceName: string): string {
  const cut = result.cut.length > 0 ? `; cut ${result.cut.join(", ")}` : "";
  const sessions = result.agents.length > 0 ? `; sessions: ${agentOutcomes(result.agents)}` : "";
  return `${folderName(source)} is at ${result.dest} on ${workspaceName}${cut}${sessions}.`;
}
