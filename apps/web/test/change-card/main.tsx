// SPDX-License-Identifier: AGPL-3.0-only
// Served by Vite to a real browser: a reply's change card in a folder another
// thread worked in, read off a transcript through deriveSession as the chat
// reads it, in either theme (?theme=light). ?state= picks the card: own (the
// files of the thread's own edits over the rest of the folder's), none (no
// files from its edits), folder (an agent that reports none of its edits), or
// narrowed (the Changes pane opened on the own list, at the right panel's width).
import { createRef } from "react";
import { createRoot } from "react-dom/client";
import type { LegendListRef } from "@legendapp/list/react";
import type { SessionEvent, WorkspaceView } from "@wsp/protocol";
import { deriveSession } from "../../src/components/chat/adapt";
import { MessagesTimeline } from "../../src/components/chat/MessagesTimeline";
import { DiffWorkerPoolProvider } from "../../src/components/DiffWorkerPoolProvider";
import { DiffSurface } from "../../src/diffs/DiffSurface";
import { onlyOf, useDiffStore } from "../../src/diffs/store";
import { provideDaemonHello, provideDaemonWire } from "../../src/files/wire";
import { useStore } from "../../src/protocol/store";
import { PANEL_WIDTH } from "../diff-panel/width";
import "../../src/index.css";
import "../../src/themes/index";

const params = new URLSearchParams(window.location.search);
const theme = params.get("theme") === "light" ? "light" : "dark";
const state = params.get("state") ?? "own";
document.documentElement.classList.toggle("dark", theme === "dark");

const own = { path: "slates/login-flow.md", kind: "added", additions: 42, deletions: 0 };
const rest = [
  { path: ".playwright-cli/state.json", kind: "added", additions: 18, deletions: 0 },
  { path: ".wrangler/cache/pages.json", kind: "modified", additions: 3, deletions: 1 },
  { path: "output/playwright/login.png", kind: "added", additions: 0, deletions: 0 },
  { path: "scripts/login.ts", kind: "modified", additions: 2, deletions: 9 },
];
const card = state === "none" ? { files: [], others: rest } : state === "folder" ? { files: [own, ...rest] } : { files: [own], others: rest };

const scoped = { workspaceId: "ws_card", sessionId: "sess_card", turnId: "turn_card", threadId: "thread_card" } as const;
const at = Date.parse("2026-10-06T01:12:00Z");
const said = "Wrote the slate for the login flow under slates/.";
const events: SessionEvent[] = [
  { type: "session.start", ...scoped, at, prompt: "Write the slate for the login flow" },
  { type: "session.delta", ...scoped, at: at + 1, kind: "text", text: said },
  { type: "session.done", ...scoped, at: at + 2, result: { status: "completed", durationMs: 41_000, text: said } },
  { type: "session.end", ...scoped, at: at + 3, exitCode: 0, sawResult: true },
  { type: "session.changes", ...scoped, at: at + 4, from: "a".repeat(40), to: "b".repeat(40), moved: [], shared: true, ...card },
];
const model = deriveSession(events);
const changes = model.turns[0]!.changes!;
const reply = model.timeline.findLast(e => e.kind === "message")!;
const summary = { turnId: scoped.turnId, files: changes.files, ...(changes.others !== undefined ? { others: changes.others } : { folder: true as const }) };

const patchOf = (path: string, lines: number): string =>
  [`diff --git a/${path} b/${path}`, "new file mode 100644", "--- /dev/null", `+++ b/${path}`, `@@ -0,0 +1,${lines} @@`, ...Array.from({ length: lines }, (_, n) => `+line ${n + 1}`), ""].join("\n");

if (state === "narrowed") {
  const workspace: WorkspaceView = { id: scoped.workspaceId, name: "slate", machineId: "m_card", project: { id: "pr_card", name: "slate", path: "/work/slate", computer: "default" }, phase: "running", golden: "snap_g", createdAt: "2026-10-06T00:00:00Z" };
  useStore.setState({ workspaces: [workspace], statuses: {}, places: [] });
  provideDaemonHello(scoped.workspaceId, { root: "/work/slate" });
  const range = [own, ...rest].map(f => ({ ...f, patch: patchOf(f.path, Math.max(1, f.additions)) }));
  provideDaemonWire(scoped.workspaceId, {
    request: async (op: string) =>
      op === "git.turn" ? { base: null, truncated: false, moved: [], files: range } : op === "git.status" ? { branch: { oid: "abc", head: "main", ahead: 0, behind: 0 }, entries: [], root: "/work/slate" } : {},
    onEvent: () => () => {},
  } as unknown as Parameters<typeof provideDaemonWire>[1]);
  useDiffStore.setState({ turnByWorkspaceId: { [scoped.workspaceId]: { turnId: scoped.turnId, cwd: "/work/slate", from: changes.from, to: changes.to, only: onlyOf(changes)! } } });
}

function Pane() {
  return (
    <DiffWorkerPoolProvider theme={theme}>
      <div className="ml-auto h-full border-l border-border/60" style={{ width: PANEL_WIDTH }}>
        <DiffSurface workspaceId={scoped.workspaceId} theme={theme} />
      </div>
    </DiffWorkerPoolProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <div className="flex h-full flex-col bg-background text-foreground" data-change-card-state={state}>
    {state === "narrowed" ? (
      <Pane />
    ) : (
      <MessagesTimeline
        isWorking={false}
        activeTurnStartedAt={null}
        listRef={createRef<LegendListRef | null>()}
        turns={model.turns}
        timelineEntries={model.timeline}
        turnDiffSummaryByAssistantMessageId={new Map([[reply.id, summary]])}
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
    )}
  </div>,
);
