// Adapted from pingdotgg/t3code apps/web/src/lib/contextWindow.ts at c9a0e8a1 (MIT).
// Differs from upstream: the reading comes off the thread's turns, the latest
// whose tokens say what the model held, rather than off activity rows; the
// words go through the protocol's fmtTokens; nothing of compaction is offered,
// since wsp has no road to compact a thread.
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

/** The meter's hover line, naming the agent where the limit is its to report. */
export function contextTitle(snapshot: ContextSnapshot, agentLabel: string): string {
  return snapshot.max === null
    ? `Context: ${fmtTokens(snapshot.used)} tokens; ${agentLabel} does not report its limit`
    : `Context: ${fmtTokens(snapshot.used)} of ${fmtTokens(snapshot.max)} tokens`;
}
