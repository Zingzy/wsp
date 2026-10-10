// SPDX-License-Identifier: AGPL-3.0-only
// The records the notices list is drawn over: two computers, three project folders, five threads, and eight
// notices of the kinds the host raises today plus the finish the build adds, each worded by the app's own words.
import { askingLine, planAlertLine, setupNeedsYouLine, type PlaceView, type SessionView, type WorkspaceView } from "@wsp/protocol";
import { HOST_NOTICE_WORDS } from "../../src/notices/hostNotices";
import { notCopied, type Notice } from "../../src/notices/store";

const ago = (minutes: number): number => Date.now() - minutes * 60_000;

export const PLACES: PlaceView[] = [
  { id: "here", kind: "computer", name: "zingzy-mbp", label: "zingzy's MacBook Pro", default: true, present: true, mac: "macbook", takesForks: false } as PlaceView,
  { id: "p_hetzner", kind: "computer", name: "hetzner", default: false, present: true, takesForks: true } as PlaceView,
];

const record = (id: string, project: { id: string; name: string; path: string }, place?: string): WorkspaceView => ({
  id,
  name: project.name,
  machineId: place === undefined ? "local" : `m_${id}`,
  project: { ...project, computer: "default" },
  phase: "running",
  golden: "",
  createdAt: "2026-10-01T09:00:00Z",
  ...(place === undefined ? { kind: "local" as const } : { place }),
});

const WSP_MAC = { id: "pr_wsp", name: "wsp", path: "/Users/zingzy/wsp" };
const WSP_BOX = { id: "pr_wsp_box", name: "wsp", path: "/root/wsp" };
const LANDING = { id: "pr_landing", name: "spoo-landing", path: "/root/spoo-landing" };

export const WORKSPACES: WorkspaceView[] = [record("ws_mac", WSP_MAC), record("ws_box", WSP_BOX, "p_hetzner"), record("ws_landing", LANDING, "p_hetzner")];

const thread = (id: string, workspaceId: string, harness: string, prompt: string, status: SessionView["status"], started: number, ended?: number, asking?: string): SessionView =>
  ({ id, threadId: id, workspaceId, harness, prompt, status, startedBy: "person", startedAt: ago(started), ...(ended === undefined ? {} : { endedAt: ago(ended) }), ...(asking === undefined ? {} : { asking }) }) as SessionView;

const ASK = { toolName: "Bash", input: JSON.stringify({ command: "pnpm install --frozen-lockfile" }), detail: "Install the workspace" };

export const SESSIONS: SessionView[] = [
  thread("t_build", "ws_box", "claude", "Build: box thread in the project", "running", 9, undefined, askingLine(ASK)),
  thread("t_coord", "ws_mac", "claude", "Coordinator: the launch map", "running", 50),
  thread("t_usage", "ws_mac", "codex", "Usage page: one ink per account", "completed", 18, 6),
  thread("t_probe", "ws_landing", "claude", "Probe: send latency on the relay", "failed", 31, 25),
  thread("t_hero", "ws_landing", "claude", "Shrink the hero image under 200 KB", "running", 3),
  thread("t_docs", "ws_mac", "claude", "Rewrite the install page for the new CLI", "completed", 40, 33),
];

/** The thread open in the centre, which no notice is about: a notice for the thread on screen is never raised. */
export const OPEN_THREAD = { workspaceId: "ws_mac", threadId: "t_docs" };

/** A notice as the store keeps it, with the thread it is about: the field the build adds so a row names its thread. */
export type ListNotice = Notice & { readonly thread?: { readonly workspaceId: string; readonly threadId: string }; readonly placeId?: string; readonly source?: "usage" };

const open = { word: HOST_NOTICE_WORDS.open, run: () => {} };

/** Newest first, as the store keeps them; the first four arrived since the list was last opened. */
export const NOTICES: ListNotice[] = [
  { id: "n7", kind: "waiting", text: askingLine(ASK), where: "wsp", at: ago(2), action: open, key: "ask:ws_box:t_build:a1", thread: { workspaceId: "ws_box", threadId: "t_build" } },
  { id: "n6", kind: "note", text: "All six builds are green; #2016 is ready to land.", where: "wsp", at: ago(4), action: open, thread: { workspaceId: "ws_mac", threadId: "t_coord" } },
  { id: "n4", kind: "done", text: HOST_NOTICE_WORDS.threadFinished("Usage page: one ink per account"), where: "wsp", at: ago(6), action: open, thread: { workspaceId: "ws_mac", threadId: "t_usage" } },
  { id: "n5", kind: "waiting", text: setupNeedsYouLine("hetzner", "sign in to Claude Code"), where: "hetzner", at: ago(12), action: open, key: "sign-in:p_hetzner/claude", placeId: "p_hetzner" },
  { id: "n3", kind: "error", text: "Stopped before it replied: exit 1", where: "spoo-landing", at: ago(25), action: open, thread: { workspaceId: "ws_landing", threadId: "t_probe" } },
  { id: "n2", kind: "note", text: planAlertLine("Claude Max", { kind: "low", window: "week", step: 90 }), at: ago(48), action: open, source: "usage" },
  { id: "n1", kind: "done", text: HOST_NOTICE_WORDS.imageSealed(4), at: ago(130) },
  { id: "n0", kind: "error", text: notCopied("Document is not focused."), at: ago(185) },
];

export const UNREAD = 4;
/** When the list was last opened: the four notices after it are the new ones. */
export const SEEN_BEFORE = ago(20);

/** The notice that lands while the page is up, for the toast standing under the bell. */
export const ARRIVING: ListNotice = { id: "n8", kind: "error", text: "Stopped before it replied: the machine ran out of memory", where: "spoo-landing", at: Date.now(), action: open, thread: { workspaceId: "ws_landing", threadId: "t_hero" } };
