// SPDX-License-Identifier: AGPL-3.0-only
// What the model held at the thread's latest turn, in the composer's footer:
// the design's one meter grammar, a 56 by 4 track at foreground 10% with its
// fill at 55%, and the figure beside it. Where the agent reports no limit
// there is nothing to fill, so the figure stands alone; the strip under the
// one-line composer drops the track when it is too narrow to hold the folder too.
import type { TurnSummary } from "../../adapt";
import { cn } from "../../lib/utils";
import { contextFigure, contextSnapshot, contextTitle } from "./contextMeter.logic";

export function ContextMeter({ turns, agentLabel, tight = false }: { turns: ReadonlyArray<Pick<TurnSummary, "tokens">>; agentLabel: string; tight?: boolean }) {
  const snapshot = contextSnapshot(turns);
  if (snapshot === null) return null;
  return (
    <span data-context-meter title={contextTitle(snapshot, agentLabel)} className="inline-flex shrink-0 items-center gap-2">
      {snapshot.share !== null ? (
        <span data-context-track aria-hidden className={cn("block h-1 w-14 overflow-hidden rounded-full bg-[color-mix(in_srgb,var(--foreground)_10%,transparent)]", tight && "@max-lg/strip:hidden")}>
          <span
            data-context-fill
            className="block h-full rounded-full bg-[color-mix(in_srgb,var(--foreground)_55%,transparent)] transition-[width] duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none"
            style={{ width: `${Math.round(snapshot.share * 1000) / 10}%` }}
          />
        </span>
      ) : null}
      <span data-context-figure className="font-mono text-[12px] text-muted-foreground tabular-nums">
        {contextFigure(snapshot)}
      </span>
    </span>
  );
}
