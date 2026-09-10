// SPDX-License-Identifier: AGPL-3.0-only
// Served by Vite to a real browser: the machine tab of a workspace the host is
// still asking the provider to resume, in either theme (?theme=light), so a
// test can lay out and photograph what jsdom cannot. The status carries the
// row's own sentence for the ask it is on, and the phase slot carries the stop,
// which is the whole of what a person can do about a provider that answers
// nothing. With ?gave-up the same tab is the one the asking left behind: the
// machine is paused, the sentence names the road, and the rebuild stands beside
// a wake that can be tried again.
import { createRoot } from "react-dom/client";
import { wakeGaveUpLine, WAKE_ASKS_AGAIN, WAKE_ASK_EVERY_MS, type EventUnion, type SnapshotLineage, type WorkspaceStatus, type WorkspaceView } from "@wsp/protocol";
import { MachineSurface } from "../../src/components/machine/MachineSurface";
import type { Api } from "../../src/protocol/client";
import { useStore } from "../../src/protocol/store";
import "../../src/index.css";

const params = new URLSearchParams(window.location.search);
document.documentElement.classList.toggle("dark", params.get("theme") !== "light");

/** The words the host's asking left on the record once it ran out, as the runtime writes them. */
const GAVE_UP = wakeGaveUpLine(WAKE_ASKS_AGAIN + 1, WAKE_ASKS_AGAIN * WAKE_ASK_EVERY_MS);
const gaveUp = params.has("gave-up");
const workspace: WorkspaceView = {
  id: "ws_b1",
  name: "b1",
  machineId: "sbx_9f2c41",
  phase: gaveUp ? "napping" : "waking",
  golden: "snap_golden-v12",
  createdAt: "2026-09-07T09:00:00Z",
  ...(gaveUp ? { wakeRefused: GAVE_UP } : {}),
};
const status: WorkspaceStatus = {
  ...workspace,
  machineState: "paused",
  reach: { state: "napping" },
  size: { cpu: 2, memMb: 4096 },
  rateUsdPerHour: 0.11,
  ...(gaveUp ? { reason: GAVE_UP } : { wakeAsk: { ask: 3, of: WAKE_ASKS_AGAIN } }),
};
const lineage: SnapshotLineage = { name: "default", head: 12, versions: [{ version: 12, snapshotId: "snap_golden-v12", baseTemplate: "base", setupSha: "sha12", createdAt: "2026-08-22T00:00:00.000Z", smoke: { cmd: "true", exitCode: 0 } }] };

const listeners = new Set<(e: EventUnion) => void>();
const api: Api = {
  upgrade: async () => workspace,
  capabilities: async () => ({ liveCloneForks: true, ramPreservingPause: true, resize: true, previewUrls: true, signedUrls: true, containers: false, callbackRelay: true, snapshotListing: true, templates: true, kept: false, sizes: [] }),
  portReach: async (_id, port) => ({ url: `https://m1-${port}.preview.example/?pt_token=e`, expiresAt: Date.now() + 3_600_000 }),
  daemonReach: async () => ({ url: "http://127.0.0.1:1", expiresAt: Number.MAX_SAFE_INTEGER }),
  startSession: async o => ({ id: "s1", workspaceId: o.workspaceId, harness: "claude", status: "running" }),
  sessionHistory: async () => [],
  listSnapshots: async () => lineage,
  snapshotStorage: async () => null,
  rollbackSnapshot: async version => ({ lineage: { ...lineage, head: version }, existingWorkspaces: "untouched" }),
  listWorkspaces: async () => [workspace],
  getWorkspace: async () => workspace,
  createWorkspace: async () => workspace,
  createFromGoldenHead: async () => workspace,
  watchStatuses: async () => [status],
  nap: async () => workspace,
  wake: async () => workspace,
  stopWake: async () => ({ ...workspace, phase: "napping" as const }),
  rebuild: async () => ({ ...workspace, phase: "running" as const, machineId: "sbx_new", wakeRefused: undefined }),
  listSessions: async () => [],
  getGolden: async () => undefined,
  subscribe: fn => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};

useStore.getState().bind(api);
createRoot(document.getElementById("root")!).render(
  <div className="h-full w-[22rem] border-r border-border bg-background text-foreground" data-testid="machine-tab">
    <MachineSurface workspaceId={workspace.id} />
  </div>,
);
