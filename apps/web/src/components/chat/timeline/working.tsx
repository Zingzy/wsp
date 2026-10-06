// SPDX-License-Identifier: AGPL-3.0-only
// Adapted from pingdotgg/t3code apps/web/src/components/chat/MessagesTimeline.tsx at 57a66608 (MIT).
// Differs from upstream: store hooks are props (threadKey replaces the route and thread refs, expansion state is local, checkpoint data and callbacks arrive as optional props); rows come from the adapter; attachments, subagent rows, citations, user-message decorations, artifact templates, editor menus and the load-earlier header are removed.
import { use, useEffect, useRef } from "react";
import { Button } from "../../ui/button";
import { TimelineRuleLine } from "../TimelineRuleLine";
import { TimelineRowActivityCtx, type TimelineRow } from "./context";
import { ActivityShimmerOverlay, THINKING_LABEL, LiveActivityRow, WORK_TONES } from "./workEntry";

/** What the elapsed count leads with while a prompt of the turn is open: the count is then time the person has kept
 * the turn waiting, and a thread stopped on a question is not working. */
const WAITING_ON_YOU_LEAD = "Waiting for you";

export function WorkingTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "working" }> }) {
  const { isPreparingWorktree, machineWait } = use(TimelineRowActivityCtx);
  if (machineWait !== null) {
    return (
      <TimelineRuleLine data-machine-wait className="my-1" line={machineWait.label}>
        {machineWait.elapsed && row.createdAt !== null ? (
          <>
            {" "}
            <span className="ms-1 font-mono tabular-nums">
              <WorkingTimer createdAt={row.createdAt} />
            </span>
          </>
        ) : null}
        {machineWait.onWake !== null ? (
          <Button size="xs" variant="outline" onClick={machineWait.onWake}>
            Wake
          </Button>
        ) : null}
      </TimelineRuleLine>
    );
  }
  return (
    <div className="pb-2 pt-1">
      <div className="flex h-6 min-w-0 items-baseline px-1 text-sm leading-relaxed text-muted-foreground tabular-nums">
        <span
          key={isPreparingWorktree ? "setup" : row.waitingOnYou ? "waiting" : "working"}
          className="relative shrink-0 overflow-hidden whitespace-nowrap transition-opacity duration-150 starting:opacity-0 motion-reduce:transition-none"
        >
          {isPreparingWorktree ? (
            <>
              Setting up worktree…
              <ActivityShimmerOverlay>Setting up worktree…</ActivityShimmerOverlay>
            </>
          ) : row.waitingOnYou ? (
            row.createdAt ? (
              <>
                {WAITING_ON_YOU_LEAD}{" "}
                <span className="ms-2">
                  <WorkingTimer createdAt={row.createdAt} />
                </span>
              </>
            ) : (
              WAITING_ON_YOU_LEAD
            )
          ) : row.createdAt ? (
            <>
              Working for <WorkingTimer createdAt={row.createdAt} />
            </>
          ) : (
            "Working..."
          )}
        </span>
      </div>
    </div>
  );
}

export function ThinkingTimelineRow() {
  const { isPreparingWorktree, machineWait } = use(TimelineRowActivityCtx);
  // Reserve the activity row during setup so the handoff keeps the same height; nothing thinks on a machine that is not running.
  return (
    <div className="min-h-7">
      {isPreparingWorktree || machineWait !== null ? null : <LiveActivityRow label={THINKING_LABEL} tone="thinking" glyph={WORK_TONES.thinking.Glyph} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Self-ticking labels: update their own text nodes so elapsed-time display
// does not create a React commit every second while a response is streaming.
// ---------------------------------------------------------------------------

/** Live "Working for Xs" label. */
function WorkingTimer({ createdAt }: { createdAt: string }) {
  const textRef = useRef<HTMLSpanElement>(null);
  const initialText = formatWorkingTimerNow(createdAt);

  useEffect(() => {
    const updateText = () => {
      if (textRef.current) {
        textRef.current.textContent = formatWorkingTimerNow(createdAt);
      }
    };
    updateText();
    const id = setInterval(updateText, 1000);
    return () => clearInterval(id);
  }, [createdAt]);

  return (
    <span ref={textRef} className="tabular-nums">
      {initialText}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function formatWorkingTimer(startIso: string, endIso: string): string | null {
  const startedAtMs = Date.parse(startIso);
  const endedAtMs = Date.parse(endIso);
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(endedAtMs)) {
    return null;
  }

  const elapsedSeconds = Math.max(0, Math.floor((endedAtMs - startedAtMs) / 1000));
  if (elapsedSeconds < 60) {
    return `${elapsedSeconds}s`;
  }

  const hours = Math.floor(elapsedSeconds / 3600);
  const minutes = Math.floor((elapsedSeconds % 3600) / 60);
  const seconds = elapsedSeconds % 60;

  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }

  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

function formatWorkingTimerNow(startIso: string): string {
  return formatWorkingTimer(startIso, new Date().toISOString()) ?? "0s";
}
