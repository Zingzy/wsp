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

export function contextSnapshot(turns: ReadonlyArray<Pick<TurnSummary, "tokens">>): ContextSnapshot | null {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const tokens = turns[index]?.tokens;
    if (tokens?.context === undefined || tokens.context < 0) continue;
    const max = tokens.window !== undefined && tokens.window > 0 ? tokens.window : null;
    return { used: tokens.context, max, share: max === null ? null : Math.min(1, tokens.context / max) };
  }
  return null;
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

/** The ring's hover line, naming the agent where the limit is its to report. */
export function contextTitle(snapshot: ContextSnapshot, agentLabel: string): string {
  return snapshot.max === null
    ? `Context: ${fmtTokens(snapshot.used)} tokens; ${agentLabel} does not report its limit`
    : `Context: ${contextPercent(snapshot)} used, ${fmtTokens(snapshot.used)} of ${fmtTokens(snapshot.max)} tokens`;
}

/** What the ring's card says beside the numbers. */
export const CONTEXT_WORDS = {
  head: "Context window",
  compact: "Compact context",
  /** The card's line where the agent reports no limit to measure the count against. */
  noLimit: (agentLabel: string): string => `${agentLabel} does not report its limit`,
} as const;
