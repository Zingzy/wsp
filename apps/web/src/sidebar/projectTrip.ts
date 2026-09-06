// SPDX-License-Identifier: AGPL-3.0-only
// What both project trips, the import and the export, compute from the wire:
// one step row per stage folded from the runtime's events, a folder's own
// name, a counted word, an agent's catalog name, each agent's outcome in the
// one set of words the web has for it, and the refusal a caught error becomes
// with the tone the status line gives it. No React here.
import { agentName } from "@wsp/catalog";
import { plural, type ProjectAgentOutcome, type ProjectAgentResult } from "@wsp/protocol";
import { errorText } from "../lib/utils.js";
import { RequestError } from "../protocol/client.js";

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

/** The protocol's rule under the name this folder's files already call it by; there is one implementation. */
export const count = plural;

/** The folder's own name from the path as typed. */
export const folderName = (path: string): string => path.replace(/\/+$/, "").split("/").at(-1) ?? path;

/** The web's one set of words for what became of an agent's sessions, short enough for a row's end. */
const OUTCOME_WORDS: Record<Exclude<ProjectAgentOutcome, "failed">, string> = {
  moved: "moved",
  "transcript-only": "transcripts landed, not yet listed",
  carried: "carried unchanged",
  nothing: "nothing to bring",
};

/** What became of one agent's sessions: the outcome's words, then the indexed rollouts the trip had to skip. */
export function agentOutcome(a: ProjectAgentResult): string {
  if (a.outcome === "failed") return `failed: ${a.error ?? "no reason given"}`;
  const skipped = a.skipped === undefined || a.skipped === 0 ? "" : `, ${count(a.skipped, "rollout")} skipped`;
  return `${OUTCOME_WORDS[a.outcome]}${skipped}`;
}

/** Every agent by name with its outcome, comma-joined for a landed line; the session counts stay with the rows and the
 * runtime's done sentence. */
export function agentOutcomes(agents: readonly ProjectAgentResult[]): string {
  return agents.map(a => `${agentName(a.agent)} ${agentOutcome(a)}`).join(", ");
}

export interface Refusal {
  readonly message: string;
  /** The destination already exists; the one follow-up is to replace it. */
  readonly exists: boolean;
}

export type StatusTone = "quiet" | "caution" | "error";

/** A caught error as the trip's refusal: the runtime's `exists` kind is the one with a follow-up. */
export const refusalOf = (e: unknown): Refusal => ({ message: errorText(e), exists: e instanceof RequestError && e.kind === "exists" });

/** A refusal that asks for a replace is a caution, any other an error; none is quiet. */
export const refusalTone = (refusal: Refusal | null): StatusTone => (refusal === null ? "quiet" : refusal.exists ? "caution" : "error");
