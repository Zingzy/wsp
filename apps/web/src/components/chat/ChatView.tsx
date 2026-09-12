// SPDX-License-Identifier: AGPL-3.0-only
// The chat thread for one workspace: the transplanted timeline over the
// adapter's entries, the empty-thread headline before the first turn, and the
// settled footer with the last turn's duration and cost. The composer is a
// render-prop slot filled by whoever mounts the view. A new-thread request
// for this workspace clears the thread, whether it arrived before or after
// the view mounted; a view pinned to an older thread unpins first, since the
// new thread opens as the workspace's latest. A send from a thread that never
// started runs as that thread's first turn, so the pin stays where it is.
import { useCallback, useEffect, useMemo, useRef, type ReactNode } from "react";
import type { LegendListRef } from "@legendapp/list/react";
import { turnSettledParts } from "@wsp/protocol";
import { useStatus, useStore, useWorkspace, useWorkspaceState } from "../../protocol/store";
import { useRightPanelStore } from "../../rightPanelStore";
import { cn } from "../../lib/utils";
import { DEFAULT_TIMESTAMP_FORMAT, pausedLine, turnWait, type TimestampFormat, type TurnSummary } from "./adapt";
import { useWhereWord } from "../../sidebar/workspaceRows";
import { TimelineRuleLine } from "./TimelineRuleLine";
import { MessagesTimeline, type MachineWait } from "./MessagesTimeline";
import { useNewThreadRequests } from "./newThreadRequests";
import { useChatThread, type ChatThreadHandle } from "./useChatThread";

const noopImageExpand = () => {};

function resolveDocumentTheme(): "light" | "dark" {
  return typeof document !== "undefined" && document.documentElement.classList.contains("dark") ? "dark" : "light";
}

export function ChatView({
  workspaceId,
  threadId = null,
  timestampFormat = DEFAULT_TIMESTAMP_FORMAT,
  children,
}: {
  workspaceId: string;
  threadId?: string | null;
  timestampFormat?: TimestampFormat;
  children?: ((thread: ChatThreadHandle) => ReactNode) | undefined;
}) {
  const workspace = useWorkspace(workspaceId);
  const wake = useStore(s => s.wake);
  const select = useStore(s => s.select);
  const thread = useChatThread(workspaceId, threadId);
  const openFile = useRightPanelStore(s => s.openFile);
  const api = useStore(s => s.api);
  const listRef = useRef<LegendListRef | null>(null);
  const { view } = thread;
  const empty = view.entries.length === 0 && !view.running;
  const cwd = view.cwd ?? undefined;
  const onOpenFile = useCallback((path: string, line?: number) => openFile(workspaceId, path, line), [openFile, workspaceId]);
  // The prompt row's own options: the answer travels straight to the runtime and the row closes on the event the
  // runtime records, never on the reply here, so two clients watching one prompt end up saying the same thing.
  const onAnswerPermission = useCallback(
    (sessionId: string, askId: string, optionId: string) => {
      void api?.answerPermission?.(sessionId, askId, optionId);
    },
    [api],
  );
  // A Working thread on a workspace that is not running is a contradiction: the row says what it waits for instead,
  // naming the workspace and, while it wakes, where it runs, since that is what the send is waiting on.
  const state = useWorkspaceState(workspaceId);
  const status = useStatus(workspaceId);
  const where = useWhereWord(workspaceId);
  const runs = useMemo(() => ({ name: workspace?.name ?? workspaceId, where }), [workspace, workspaceId, where]);
  const machineWait = useMemo<MachineWait | null>(() => {
    if (state === null || !view.running) return null;
    const wait = turnWait(state, runs);
    if (wait === null) return null;
    return { label: wait.label, elapsed: wait.elapsed, onWake: wait.wake ? () => void wake(workspaceId) : null };
  }, [state, view.running, wake, workspaceId, runs]);
  // Nothing is running and the workspace is paused: the last thing that happened to this thread is the nap, and the
  // next send is what wakes it. One line under the transcript in the timeline's own rule grammar, never a dialog.
  const paused = state === "paused" && !view.running ? pausedLine(status?.reason) : null;
  const { startNewThread, hydrated } = thread;
  useEffect(() => {
    // The latest view takes the request once its transcript is in, so it knows which thread it leaves behind.
    const consume = () => {
      const requests = useNewThreadRequests.getState();
      if (!requests.pending.has(workspaceId)) return;
      if (threadId !== null) select(workspaceId);
      else if (hydrated && requests.take(workspaceId)) startNewThread();
    };
    consume();
    return useNewThreadRequests.subscribe(consume);
  }, [hydrated, select, startNewThread, threadId, workspaceId]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <div className="relative min-h-0 flex-1">
        {!thread.hydrated ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">loading transcript</div>
        ) : empty ? (
          <EmptyThread workspaceName={workspace?.name ?? workspaceId} />
        ) : (
          <MessagesTimeline
            isWorking={view.running}
            machineWait={machineWait}
            activeTurnStartedAt={view.activeTurnStartedAt}
            listRef={listRef}
            timelineEntries={view.entries}
            turns={view.turns}
            threadKey={threadId === null ? workspaceId : `${workspaceId}/${threadId}`}
            onImageExpand={noopImageExpand}
            onAnswerPermission={onAnswerPermission}
            onOpenFile={onOpenFile}
            markdownCwd={cwd}
            workspaceRoot={cwd}
            resolvedTheme={resolveDocumentTheme()}
            timestampFormat={timestampFormat}
          />
        )}
      </div>
      {thread.hydrated && view.settled !== null ? <SettledFooter turn={view.settled} /> : null}
      {thread.hydrated && paused !== null ? (
        <div className="mx-auto w-full max-w-5xl px-4 pb-1">
          <TimelineRuleLine data-workspace-paused line={paused} />
        </div>
      ) : null}
      {children?.(thread)}
    </div>
  );
}

function EmptyThread({ workspaceName }: { workspaceName: string }) {
  return (
    <div className="flex h-full items-center justify-center px-6">
      <h1 className="mx-auto w-full max-w-5xl text-center font-normal text-2xl text-foreground tracking-tight sm:text-3xl">
        What should we build in{" "}
        <span className="inline-block max-w-64 truncate border-foreground/60 border-b border-dotted align-baseline">{workspaceName}</span>?
      </h1>
    </div>
  );
}

const TURN_STATUS: Record<TurnSummary["state"], string> = {
  running: "running",
  completed: "completed",
  interrupted: "interrupted",
  error: "failed",
};

/** Duration and cost of the turn that just settled; its error, when it has one, is already a row in the thread. */
function SettledFooter({ turn }: { turn: TurnSummary }) {
  const failed = turn.state !== "completed";
  const parts = turnSettledParts(turn);
  return (
    <div
      data-testid="settled-footer"
      className={cn(
        "mx-auto flex w-full max-w-3xl items-center gap-2 px-4 py-2 text-xs tabular-nums sm:px-6",
        failed ? "text-destructive" : "text-muted-foreground",
      )}
    >
      <span>{TURN_STATUS[turn.state]}</span>
      {parts.map(part => (
        <span key={part}>
          <span aria-hidden className="pe-2">·</span>
          {part}
        </span>
      ))}
    </div>
  );
}
