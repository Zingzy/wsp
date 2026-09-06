// SPDX-License-Identifier: AGPL-3.0-only
// What both project trips, the import and the export, compute from the wire:
// one step row per stage folded from the runtime's events, a folder's own
// name, a counted word, an agent's catalog name, and each agent's outcome in
// the words both landed lines use. No React here.
import { catalogEntry } from "@wsp/catalog";
import type { ProjectAgentOutcome, ProjectAgentResult } from "@wsp/protocol";

/** The shape every trip's progress event shares; `failed` is never a step, it is the error line. */
export interface TripEvent {
  readonly stage: string;
  readonly message: string;
  readonly elapsedMs: number;
  readonly bytes?: number;
  readonly total?: number;
}

export interface StepRow<S extends string = string> {
  readonly stage: S;
  /** The runtime's sentence for the step, or nothing before it was reached. */
  readonly message: string | null;
  readonly elapsedMs: number | null;
  /** Bytes moved of the archive's total on the transfer step, 0 to 1. */
  readonly fraction: number | null;
}

/** One row per step in the given order, each holding the last event the runtime sent for it. */
export function stepRows<S extends string>(steps: readonly S[], events: readonly TripEvent[]): StepRow<S>[] {
  const last = new Map<string, TripEvent>();
  for (const e of events) if ((steps as readonly string[]).includes(e.stage)) last.set(e.stage, e);
  return steps.map(stage => {
    const e = last.get(stage);
    if (e === undefined) return { stage, message: null, elapsedMs: null, fraction: null };
    const fraction = e.bytes !== undefined && e.total !== undefined && e.total > 0 ? e.bytes / e.total : null;
    return { stage, message: e.message, elapsedMs: e.elapsedMs, fraction };
  });
}

export const count = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

/** An agent as the catalog names it; an id the catalog does not know reads as itself. */
export const agentName = (id: string): string => catalogEntry(id)?.name ?? id;

/** The folder's own name from the path as typed. */
export const folderName = (path: string): string => path.replace(/\/+$/, "").split("/").at(-1) ?? path;

/** The outcome's words in full for a landed line, and short enough for one row's end. */
const OUTCOME_WORDS: Record<Exclude<ProjectAgentOutcome, "failed">, { short: string; full: string }> = {
  moved: { short: "moved", full: "moved" },
  "transcript-only": { short: "transcripts landed, not yet listed", full: "transcripts landed, not yet in its session list" },
  carried: { short: "carried unchanged", full: "carried unchanged" },
  nothing: { short: "nothing to bring", full: "had nothing to bring" },
};

/** What became of one agent's sessions: the outcome's words, then the indexed rollouts the trip had to skip. */
export function agentOutcome(a: ProjectAgentResult): { short: string; full: string } {
  if (a.outcome === "failed") {
    const failed = `failed: ${a.error ?? "no reason given"}`;
    return { short: failed, full: failed };
  }
  const skipped = a.skipped === undefined || a.skipped === 0 ? null : a.skipped;
  const words = OUTCOME_WORDS[a.outcome];
  return {
    short: skipped === null ? words.short : `${words.short}, ${count(skipped, "rollout")} skipped`,
    full: skipped === null ? words.full : `${words.full}, ${count(skipped, "indexed rollout")} skipped`,
  };
}

/** Every agent by name with its outcome in the short words, comma-joined for a landed line that has two lines to fit
 * in; the session counts stay with the rows and the runtime's done sentence. */
export function agentOutcomes(agents: readonly ProjectAgentResult[]): string {
  return agents.map(a => `${agentName(a.agent)} ${agentOutcome(a).short}`).join(", ");
}
