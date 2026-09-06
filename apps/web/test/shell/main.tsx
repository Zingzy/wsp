// SPDX-License-Identifier: AGPL-3.0-only
// Served by Vite to a real browser: the app shell over a fake api with three
// workspaces (running, paused, gone) and two threads, in either theme
// (?theme=light) and with a status toast in the footer (?toast=...), so a
// test can measure the chrome's geometry, which jsdom cannot lay out.
import { createRoot } from "react-dom/client";
import type { SessionView, WorkspaceView } from "@wsp/protocol";
import { statusOf } from "../workspace-status";
import { TooltipProvider } from "../../src/components/ui/tooltip";
import type { Api } from "../../src/protocol/client";
import { useStore } from "../../src/protocol/store";
import { AppShell } from "../../src/shell/AppShell";
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
// The ticket's rows: long titles with the agent and both opener words, one working, one settled.
const sessions: SessionView[] = [
  { id: "s1", workspaceId: "ws_a", harness: "claude", status: "running", prompt: "Now reply with exactly the word pong.", startedBy: "person", startedAt: Date.now() - 48 * 60_000 },
  { id: "s2", workspaceId: "ws_a", harness: "claude", status: "completed", prompt: "Reply with exactly the word hi.", startedBy: "cli", startedAt: Date.now() - 30 * 60_000, endedAt: Date.now() - 24 * 60_000 },
];

const api: Api = {
  listWorkspaces: async () => workspaces,
  getWorkspace: async id => workspaces.find(w => w.id === id)!,
  createWorkspace: async () => workspaces[0]!,
  createFromGoldenHead: async () => workspaces[0]!,
  watchStatuses: async () => workspaces.map(w => statusOf(w)),
  nap: async id => workspaces.find(w => w.id === id)!,
  wake: async id => workspaces.find(w => w.id === id)!,
  upgrade: async id => workspaces.find(w => w.id === id)!,
  capabilities: async () => ({ liveCloneForks: true, ramPreservingPause: true, resize: true, previewUrls: true, signedUrls: true, containers: true, callbackRelay: true, snapshotListing: true }),
  startSession: async o => ({ id: "s2", workspaceId: o.workspaceId, harness: "claude", status: "running" }),
  portReach: async (_id, port) => ({ url: `https://m1-${port}.preview.example/?pt_token=e`, expiresAt: Date.now() + 3_600_000 }),
  daemonReach: async () => ({ url: "ws://127.0.0.1:1", expiresAt: 0 }),
  sessionHistory: async () => [],
  listSnapshots: async () => ({ name: "default", head: null, versions: [] }),
  snapshotStorage: async () => null,
  rollbackSnapshot: async () => ({ lineage: { name: "default", head: null, versions: [] }, existingWorkspaces: "untouched" }),
  listSessions: async () => sessions,
  subscribe: () => () => {},
  getGolden: async () => undefined,
};

const toast = params.get("toast");
useStore.setState({ conn: "live", ...(toast !== null ? { toast } : {}) });
useStore.getState().bind(api);
createRoot(document.getElementById("root")!).render(
  <TooltipProvider>
    <AppShell>
      <div />
    </AppShell>
  </TooltipProvider>,
);
