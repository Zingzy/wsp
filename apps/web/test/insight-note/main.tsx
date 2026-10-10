// SPDX-License-Identifier: AGPL-3.0-only
// Served by Vite to a real browser: a reply written in Claude Code's Explanatory output style, its insight blocks in
// the exact bytes 2.1.296 writes, read through deriveSession as the chat reads it, in either theme (?theme=light).
import { createRef } from "react";
import { createRoot } from "react-dom/client";
import type { LegendListRef } from "@legendapp/list/react";
import type { SessionEvent } from "@wsp/protocol";
import { deriveSession } from "../../src/components/chat/adapt";
import { MessagesTimeline } from "../../src/components/chat/MessagesTimeline";
import "../../src/index.css";
import "../../src/themes/index";

const theme = new URLSearchParams(window.location.search).get("theme") === "light" ? "light" : "dark";
document.documentElement.classList.toggle("dark", theme === "dark");

const opener = "`★ Insight " + "─".repeat(37) + "`";
const closer = "`" + "─".repeat(49) + "`";
const said = [
  "Reading the retry loop before changing it.",
  "",
  opener,
  "- The loop backs off by doubling `delayMs`, so the fifth try waits 16 seconds.",
  "- A `429` carries `Retry-After`, which should win over the doubling.",
  closer,
  "",
  "I changed `fetchWithRetry` in `src/net/retry.ts` to read the header first and fall back to the doubling.",
  "",
  opener,
  "Reading the header before the doubling keeps the client polite to a server that says when to come back, and the cap still holds a bad header to 30 seconds.",
  closer,
].join("\n");

const scoped = { workspaceId: "ws_insight", sessionId: "sess_insight", turnId: "turn_insight", threadId: "thread_insight" } as const;
const at = Date.parse("2026-10-10T09:00:00Z");
const events: SessionEvent[] = [
  { type: "session.start", ...scoped, at, prompt: "Make the retry loop honour Retry-After" },
  { type: "session.delta", ...scoped, at: at + 1, kind: "text", text: said },
  { type: "session.done", ...scoped, at: at + 2, result: { status: "completed", durationMs: 12_000, text: said } },
  { type: "session.end", ...scoped, at: at + 3, exitCode: 0, sawResult: true },
];
const model = deriveSession(events);

createRoot(document.getElementById("root")!).render(
  <div className="flex h-full flex-col bg-background text-foreground">
    <MessagesTimeline
      isWorking={false}
      activeTurnStartedAt={null}
      listRef={createRef<LegendListRef | null>()}
      turns={model.turns}
      timelineEntries={model.timeline}
      turnDiffSummaryByAssistantMessageId={new Map()}
      threadKey={scoped.threadId}
      onOpenTurnDiff={() => {}}
      rewindableMessageIds={new Set<string>()}
      onRewind={() => {}}
      onImageExpand={() => {}}
      markdownCwd={undefined}
      resolvedTheme={theme}
      timestampFormat="locale"
      workspaceRoot={undefined}
      anchorMessageId={null}
      onAnchorReady={() => {}}
      contentInsetEndAdjustment={0}
      liveFollowEnabled={true}
      onIsAtEndChange={() => {}}
      onManualNavigation={() => {}}
    />
  </div>,
);
