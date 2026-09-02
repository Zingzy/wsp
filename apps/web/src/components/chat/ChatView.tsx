// SPDX-License-Identifier: AGPL-3.0-only
// The chat thread for one workspace: the transplanted timeline over the
// adapter's entries, the empty-thread headline before the first turn, and the
// settled footer with the last turn's duration and cost. The composer is a
// slot (children) so the tab can keep its own until the new one lands.
import { useRef, type ReactNode } from "react";
import type { LegendListRef } from "@legendapp/list/react";
import type { TurnResult } from "@wsp/protocol";
import { useWorkspace } from "../../protocol/store";
import { cn } from "../../lib/utils";
import { DEFAULT_TIMESTAMP_FORMAT, formatDuration, type TimestampFormat } from "./adapt";
import { MessagesTimeline } from "./MessagesTimeline";
import { useChatThread, type ChatThreadHandle } from "./useChatThread";

const noopImageExpand = () => {};

function resolveDocumentTheme(): "light" | "dark" {
  return typeof document !== "undefined" && document.documentElement.classList.contains("dark") ? "dark" : "light";
}

export function ChatView({
  workspaceId,
  timestampFormat = DEFAULT_TIMESTAMP_FORMAT,
  children,
}: {
  workspaceId: string;
  timestampFormat?: TimestampFormat;
  children?: ((thread: ChatThreadHandle) => ReactNode) | undefined;
}) {
  const workspace = useWorkspace(workspaceId);
  const thread = useChatThread(workspaceId);
  const listRef = useRef<LegendListRef | null>(null);
  const { view } = thread;
  const isWorking = view.runningTurnId !== null;
  const empty = view.entries.length === 0 && !isWorking;
  const cwd = view.cwd ?? undefined;

  return (
    <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <div className="relative min-h-0 flex-1">
        {!thread.hydrated ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">loading transcript</div>
        ) : empty ? (
          <EmptyThread workspaceName={workspace?.name ?? workspaceId} />
        ) : (
          <MessagesTimeline
            isWorking={isWorking}
            activeTurnStartedAt={view.activeTurnStartedAt}
            listRef={listRef}
            timelineEntries={view.entries}
            latestTurn={view.latestTurn}
            runningTurnId={view.runningTurnId}
            threadKey={workspaceId}
            onImageExpand={noopImageExpand}
            markdownCwd={cwd}
            workspaceRoot={cwd}
            resolvedTheme={resolveDocumentTheme()}
            timestampFormat={timestampFormat}
          />
        )}
      </div>
      {thread.hydrated && view.settled !== null && !isWorking ? <SettledFooter result={view.settled} /> : null}
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

function formatCost(usd: number): string {
  return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

/** Duration and cost of the turn that just settled, the way a finished run reads at the foot of the thread. */
function SettledFooter({ result }: { result: TurnResult }) {
  const failed = result.status !== "completed";
  const parts: string[] = [];
  if (typeof result.durationMs === "number") parts.push(`Worked for ${formatDuration(result.durationMs)}`);
  if (typeof result.costUsd === "number") parts.push(formatCost(result.costUsd));
  return (
    <div
      data-testid="settled-footer"
      className={cn(
        "mx-auto flex w-full max-w-3xl flex-col gap-0.5 px-4 py-2 text-xs tabular-nums sm:px-6",
        failed ? "text-destructive" : "text-muted-foreground",
      )}
    >
      <div className="flex items-center gap-2">
        <span>{result.status}</span>
        {parts.map(part => (
          <span key={part}>
            <span aria-hidden className="pe-2">·</span>
            {part}
          </span>
        ))}
      </div>
      {result.error ? <div className="whitespace-pre-wrap break-words">{result.error}</div> : null}
    </div>
  );
}
