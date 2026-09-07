// SPDX-License-Identifier: AGPL-3.0-only
// Served by Vite to a real browser: the app shell over a fake api with three
// workspaces (running, paused, gone) and two threads, in either theme
// (?theme=light), with a status toast in the footer (?toast=...) and with the
// runtime replacing the first machine's helper (?helper=1) or the first
// machine's link dropped after a near-full memory sample (?oom=1), so a test
// can measure the chrome's geometry, which jsdom cannot lay out. With
// ?ws=<id> the centre holds that workspace's thread and composer, so the
// refusal line above the box can be measured for the running, paused and gone
// workspaces; ?ws=ws_a&linger=1 replays a turn that replied but whose process
// has not exited.
import { createRoot } from "react-dom/client";
import { DAEMON_UPDATING, type SessionEvent, type SessionView, type WorkspaceView } from "@wsp/protocol";
import { statusOf } from "../workspace-status";
import { TooltipProvider } from "../../src/components/ui/tooltip";
import type { Api } from "../../src/protocol/client";
import { getLive } from "../../src/machine/live";
import { useStore } from "../../src/protocol/store";
import { AppShell } from "../../src/shell/AppShell";
import { WorkspaceThread } from "../../src/shell/WorkspaceThread";
import "../../src/index.css";

const params = new URLSearchParams(window.location.search);
document.documentElement.classList.toggle("dark", params.get("theme") !== "light");

const view = (id: string, name: string, phase: WorkspaceView["phase"] = "running"): WorkspaceView => ({
  id,
  name,
  machineId: `m_${id}`,
  phase,
  golden: "snap_g",
  createdAt: "2026-09-05T11:00:00Z",
});
const workspaces = [view("ws_a", "api"), view("ws_b", "web", "napping"), { ...view("ws_c", "old", "gone"), gone: "machine m_ws_c is gone at the provider: Not found" }];
// The ticket's rows: long titles with the agent and both opener words. ws_a mixes a working thread with an idle
// one; ws_b has only idle ones, the shape that used to draw no Idle header at all.
const sessions: SessionView[] = [
  { id: "s1", workspaceId: "ws_a", harness: "claude", status: "running", prompt: "Now reply with exactly the word pong.", startedBy: "person", startedAt: Date.now() - 48 * 60_000 },
  { id: "s2", workspaceId: "ws_a", harness: "claude", status: "completed", prompt: "Reply with exactly the word hi.", startedBy: "cli", startedAt: Date.now() - 30 * 60_000, endedAt: Date.now() - 24 * 60_000 },
  { id: "s3", workspaceId: "ws_b", harness: "claude", status: "completed", prompt: "Bump the lockfile and run the gate.", startedBy: "cli", startedAt: Date.now() - 90 * 60_000, endedAt: Date.now() - 80 * 60_000 },
  { id: "s4", workspaceId: "ws_b", harness: "claude", status: "interrupted", prompt: "Drop the old preview shim.", startedBy: "person", startedAt: Date.now() - 120 * 60_000, endedAt: Date.now() - 110 * 60_000 },
];

const linger = { workspaceId: "ws_a", sessionId: "s1", turnId: "turn_1", threadId: "thr_linger" };
const lingering: SessionEvent[] = [
  { type: "session.start", ...linger, prompt: "Start the dev server in the background and reply when it is up." },
  { type: "session.delta", ...linger, kind: "text", text: "Server is live at :3000." },
  { type: "session.done", ...linger, result: { status: "completed", durationMs: 900, costUsd: 0.001 } },
];

const api: Api = {
  listWorkspaces: async () => workspaces,
  getWorkspace: async id => workspaces.find(w => w.id === id)!,
  createWorkspace: async () => workspaces[0]!,
  createFromGoldenHead: async () => workspaces[0]!,
  watchStatuses: async () =>
    workspaces.map(w =>
      statusOf(w, w.id !== "ws_a" ? {} : params.get("helper") === "1" ? { daemonNote: DAEMON_UPDATING } : params.get("oom") === "1" ? { reach: { state: "unreachable" } } : {}),
    ),
  forget: async () => {},
  nap: async id => workspaces.find(w => w.id === id)!,
  wake: async id => workspaces.find(w => w.id === id)!,
  upgrade: async id => workspaces.find(w => w.id === id)!,
  capabilities: async () => ({ liveCloneForks: true, ramPreservingPause: true, resize: true, previewUrls: true, signedUrls: true, containers: true, callbackRelay: true, snapshotListing: true, sizes: [] }),
  startSession: async o => ({ id: "s2", workspaceId: o.workspaceId, harness: "claude", status: "running" }),
  portReach: async (_id, port) => ({ url: `https://m1-${port}.preview.example/?pt_token=e`, expiresAt: Date.now() + 3_600_000 }),
  daemonReach: async () => ({ url: "ws://127.0.0.1:1", expiresAt: 0 }),
  sessionHistory: async id => (id === "ws_a" && params.get("linger") === "1" ? lingering : []),
  listSnapshots: async () => ({ name: "default", head: null, versions: [] }),
  snapshotStorage: async () => null,
  rollbackSnapshot: async () => ({ lineage: { name: "default", head: null, versions: [] }, existingWorkspaces: "untouched" }),
  listSessions: async () => sessions,
  subscribe: () => () => {},
  getGolden: async () => undefined,
};

const toast = params.get("toast");
const shown = params.get("ws");
useStore.setState({ conn: "live", ...(toast !== null ? { toast } : {}), ...(shown !== null ? { selectedId: shown } : {}) });
useStore.getState().bind(api);
if (params.get("oom") === "1") {
  const GiB = 1024 ** 3;
  getLive("ws_a").feedStatus("live");
  getLive("ws_a").feedSample({ type: "sys.sample", cpu: 99, load1: 6.4, mem: { used: 3.59 * GiB, total: 3.94 * GiB }, disk: { used: 1, total: 10 }, at: 1 });
  getLive("ws_a").feedStatus("connecting");
}
createRoot(document.getElementById("root")!).render(
  <TooltipProvider>
    <AppShell>{shown === null ? <div /> : <WorkspaceThread workspaceId={shown} />}</AppShell>
  </TooltipProvider>,
);
