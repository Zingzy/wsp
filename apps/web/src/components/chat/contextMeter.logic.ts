// Adapted from pingdotgg/t3code apps/web/src/lib/contextWindow.ts at c9a0e8a1 (MIT).
// Differs from upstream: the reading comes off the thread's turns, the latest
// whose tokens say what the model held, rather than off activity rows; the
// words go through the protocol's fmtTokens; compaction is the agent's own,
// sent as the message its adapter declares, and not a call of the host's.
import { fmtTokens } from "@wsp/protocol";
import type { TurnSummary } from "../../adapt";

/** What the model held at the thread's latest turn that said, out of the most it holds where its agent reports that. */
export interface ContextSnapshot {
  readonly used: number;
  readonly max: number | null;
  /** The meter's fill from 0 to 1; null where there is no limit to measure against. */
  readonly share: number | null;
}


/** What the model held at the newest turn that said, its result's figure or, on a turn still running or ended with
 * none, its last call's; out of the newest window an agent named, since a running turn names none before its end. */
export function contextSnapshot(turns: ReadonlyArray<Pick<TurnSummary, "tokens" | "held">>): ContextSnapshot | null {
  let used: number | undefined;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index]!;
    if (used === undefined) {
      const context = turn.tokens?.context ?? turn.held?.context;
      if (context === undefined || context < 0) continue;
      used = context;
    }
    const window = turn.tokens?.window ?? turn.held?.window;
    if (window !== undefined && window > 0) return { used, max: window, share: Math.min(1, used / window) };
  }
  return used === undefined ? null : { used, max: null, share: null };
}

/** Why a thread that ran a turn shows no reading, or why the limit is missing from one; null where nothing is
 * missing, and for a thread that never ran a turn, which has nothing to measure. An agent that counted a finished
 * turn and named no figure for it does not report one. */
export function contextMissing(turns: ReadonlyArray<Pick<TurnSummary, "tokens" | "held" | "state">>, agentLabel: string): string | null {
  if (turns.length === 0) return null;
  const counted = turns.filter(t => t.state !== "running" && t.tokens !== null);
  const snapshot = contextSnapshot(turns);
  if (snapshot === null) return counted.length > 0 ? CONTEXT_WORDS.noFigure(agentLabel) : turns.at(-1)!.state === "error" ? CONTEXT_WORDS.failedEarly : CONTEXT_WORDS.notYet;
  if (snapshot.max !== null) return null;
  return counted.some(t => t.tokens?.context !== undefined) ? CONTEXT_WORDS.noLimit(agentLabel) : CONTEXT_WORDS.limitAtEnd;
}

/** The figure beside the meter: what was held over the limit, or what was held alone. */
export function contextFigure(snapshot: ContextSnapshot): string {
  return snapshot.max === null ? fmtTokens(snapshot.used) : `${fmtTokens(snapshot.used)} / ${fmtTokens(snapshot.max)}`;
}

/** The share as a percentage, one decimal under ten as T3 Code says it; null where there is no limit. */
export function contextPercent(snapshot: ContextSnapshot): string | null {
  if (snapshot.share === null) return null;
  const value = snapshot.share * 100;
  return value < 10 ? `${value.toFixed(1).replace(/\.0$/, "")}%` : `${Math.round(value)}%`;
}

/** The ring's hover line: the reading, with why a part of it is missing where one is. */
export function contextTitle(snapshot: ContextSnapshot | null, missing: string | null): string {
  if (snapshot === null) return `Context: ${missing ?? CONTEXT_WORDS.notYet}`;
  return snapshot.max === null
    ? `Context: ${fmtTokens(snapshot.used)} tokens. ${missing ?? CONTEXT_WORDS.limitAtEnd}`
    : `Context: ${contextPercent(snapshot)} used, ${fmtTokens(snapshot.used)} of ${fmtTokens(snapshot.max)} tokens`;
}

/** What the ring's card says beside the numbers. */
export const CONTEXT_WORDS = {
  head: "Context window",
  compact: "Compact context",
  /** The card's line where the agent reports no limit to measure the count against. */
  noLimit: (agentLabel: string): string => `${agentLabel} does not report its limit`,
  /** The card's line where the agent counts its turns and names no figure for what it holds. */
  noFigure: (agentLabel: string): string => `${agentLabel} does not report how much context it holds`,
  /** The card's line on a thread whose agent has said nothing yet of what it holds. */
  notYet: "Shows once the agent reports what it holds",
  /** The card's line on a thread whose latest turn failed before its agent said anything of what it holds. */
  failedEarly: "The agent reported nothing before the turn failed",
  /** The card's line where the count is in and no turn has named its limit yet. */
  limitAtEnd: "The limit shows once a turn finishes",
} as const;
