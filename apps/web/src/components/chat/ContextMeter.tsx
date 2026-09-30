// SPDX-License-Identifier: AGPL-3.0-only
// What the model held at the thread's latest turn, as a small ring in the
// thread's top bar beside Open, after T3 Code's context window meter: the
// ring fills with the share of the window, and its hover says the numbers
// and the percentage. The thread's view publishes its reading, since the
// top bar stands outside it; a thread whose agent reports no limit draws an
// empty ring and says the count alone.
import { useEffect } from "react";
import { create } from "zustand";
import type { TurnSummary } from "../../adapt";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { contextSnapshot, contextTitle, type ContextSnapshot } from "./contextMeter.logic";

interface ContextReading {
  readonly snapshot: ContextSnapshot;
  readonly agentLabel: string;
}

const useContextStore = create<{ byWorkspaceId: Record<string, ContextReading | undefined> }>(() => ({ byWorkspaceId: {} }));

/** Puts the thread on screen's reading where the top bar reads it, and takes it away as the thread leaves. */
export function usePublishContext(workspaceId: string, turns: ReadonlyArray<Pick<TurnSummary, "tokens">>, agentLabel: string): void {
  const snapshot = contextSnapshot(turns);
  const used = snapshot?.used;
  const max = snapshot?.max;
  useEffect(() => {
    const reading = snapshot === null ? undefined : { snapshot, agentLabel };
    useContextStore.setState(s => ({ byWorkspaceId: { ...s.byWorkspaceId, [workspaceId]: reading } }));
    return () => useContextStore.setState(s => ({ byWorkspaceId: { ...s.byWorkspaceId, [workspaceId]: undefined } }));
    // The reading is its numbers; a new array of the same turns is the same reading.
  }, [workspaceId, used, max, agentLabel]);
}

const RADIUS = 9.75;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export function ContextRing({ workspaceId }: { workspaceId: string }) {
  const reading = useContextStore(s => s.byWorkspaceId[workspaceId]);
  if (reading === undefined) return null;
  const { snapshot, agentLabel } = reading;
  const title = contextTitle(snapshot, agentLabel);
  const share = snapshot.share ?? 0;
  return (
    <Tooltip>
      <TooltipTrigger
        render={<button type="button" data-context-ring aria-label={title} className="inline-flex size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors duration-150 hover:bg-accent [-webkit-app-region:no-drag]" />}
      >
        <svg viewBox="0 0 24 24" aria-hidden className="size-5 -rotate-90">
          <circle cx="12" cy="12" r={RADIUS} fill="none" stroke="color-mix(in srgb, var(--foreground) 10%, transparent)" strokeWidth="3" />
          <circle
            data-context-used
            cx="12"
            cy="12"
            r={RADIUS}
            fill="none"
            stroke="color-mix(in srgb, var(--foreground) 55%, transparent)"
            strokeWidth="3"
            strokeLinecap="round"
            strokeDasharray={CIRCUMFERENCE}
            strokeDashoffset={CIRCUMFERENCE * (1 - share)}
            className="transition-[stroke-dashoffset] duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none"
          />
        </svg>
      </TooltipTrigger>
      <TooltipPopup side="bottom" align="end" className="max-w-72">
        {title}
      </TooltipPopup>
    </Tooltip>
  );
}
