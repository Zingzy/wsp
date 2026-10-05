// SPDX-License-Identifier: AGPL-3.0-only
// What the model held at the thread's latest turn, as a small ring in the
// thread's top bar, first of its buttons, after T3 Code's context window meter: the
// ring fills with the share of the window, and the card it opens at once on
// hover, in the sidebar tiles' card skin, says the share, the count over the
// window and a meter, with Compact context where the thread's agent has a
// compaction of its own. The thread's view publishes its reading and that act,
// since the top bar stands outside it; a thread whose agent reports no limit
// draws an empty ring and says the count alone.
import { useEffect, useRef } from "react";
import { Minimize2Icon } from "lucide-react";
import { create } from "zustand";
import type { TurnSummary } from "../../adapt";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { CONTEXT_WORDS, contextFigure, contextPercent, contextSnapshot, contextTitle, type ContextSnapshot } from "./contextMeter.logic";

/** The thread's own compaction: `held` is why it cannot run now, in the composer's words, or null. */
export interface ContextCompact {
  readonly run: () => void;
  readonly held: string | null;
}

interface ContextReading {
  readonly snapshot: ContextSnapshot;
  readonly agentLabel: string;
  readonly compact: ContextCompact | null;
}

const useContextStore = create<{ byWorkspaceId: Record<string, ContextReading | undefined> }>(() => ({ byWorkspaceId: {} }));

/** Puts the thread on screen's reading where the top bar reads it, and takes it away as the thread leaves. `compact`
 * is null where the thread's agent has no compaction wsp can run. */
export function usePublishContext(
  workspaceId: string,
  turns: ReadonlyArray<Pick<TurnSummary, "tokens">>,
  agentLabel: string,
  compact: ContextCompact | null = null,
): void {
  const snapshot = contextSnapshot(turns);
  const used = snapshot?.used;
  const max = snapshot?.max;
  // The act reads the composer's latest state when clicked, so a new closure each render is not a new reading.
  const runRef = useRef(compact?.run);
  runRef.current = compact?.run;
  const offered = compact !== null;
  const held = compact?.held ?? null;
  useEffect(() => {
    const reading = snapshot === null ? undefined : { snapshot, agentLabel, compact: offered ? { run: () => runRef.current?.(), held } : null };
    useContextStore.setState(s => ({ byWorkspaceId: { ...s.byWorkspaceId, [workspaceId]: reading } }));
    return () => useContextStore.setState(s => ({ byWorkspaceId: { ...s.byWorkspaceId, [workspaceId]: undefined } }));
    // The reading is its numbers; a new array of the same turns is the same reading.
  }, [workspaceId, used, max, agentLabel, offered, held]);
}

const RADIUS = 9.75;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export function ContextRing({ workspaceId }: { workspaceId: string }) {
  const reading = useContextStore(s => s.byWorkspaceId[workspaceId]);
  if (reading === undefined) return null;
  const { snapshot, agentLabel, compact } = reading;
  const title = contextTitle(snapshot, agentLabel);
  const share = snapshot.share ?? 0;
  const percent = contextPercent(snapshot);
  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={0}
        closeDelay={compact === null ? 0 : 150}
        render={<button type="button" data-context-ring aria-label={title} className="inline-flex size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors duration-150 hover:bg-accent data-popup-open:bg-accent [-webkit-app-region:no-drag]" />}
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
      </PopoverTrigger>
      <PopoverPopup tooltipStyle side="bottom" align="end" sideOffset={6} data-context-card className="w-72 max-w-none text-left text-[13px] whitespace-normal">
        <div className="flex min-w-0 flex-col gap-2 py-1">
          <div className="flex items-baseline justify-between gap-3">
            <p className="whitespace-nowrap font-medium text-foreground">{CONTEXT_WORDS.head}</p>
            <p data-context-figures className="flex shrink-0 gap-3 font-mono text-xs text-muted-foreground tabular-nums">
              {percent === null ? null : <span>{percent}</span>}
              <span>{contextFigure(snapshot)}</span>
            </p>
          </div>
          {snapshot.share === null ? (
            <p className="text-muted-foreground">{CONTEXT_WORDS.noLimit(agentLabel)}</p>
          ) : (
            <div role="progressbar" aria-label={CONTEXT_WORDS.head} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(share * 100)} className="h-1 w-full overflow-hidden rounded-full bg-foreground/10">
              <div data-context-meter className="h-full rounded-full bg-foreground/55 transition-[width] duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none" style={{ width: `${share * 100}%` }} />
            </div>
          )}
          {compact === null ? null : (
            <>
              <Button type="button" size="xs" variant="outline" data-context-compact className="mt-1 w-full justify-center" disabled={compact.held !== null} onClick={compact.run}>
                <Minimize2Icon aria-hidden />
                {CONTEXT_WORDS.compact}
              </Button>
              {compact.held === null ? null : (
                <p data-context-compact-held className="text-xs text-muted-foreground">
                  {compact.held}
                </p>
              )}
            </>
          )}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
