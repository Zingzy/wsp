// SPDX-License-Identifier: AGPL-3.0-only
// Served by Vite to a real browser: the machine tab of a local workspace, this
// computer itself, in either theme (?theme=light), so a test can lay out and
// photograph what jsdom cannot. The runtime prices it at zero, its status
// carries this computer's own shape, and it forks from no image, so the tab
// has no spend to chart and one lineage row.
import { createRoot } from "react-dom/client";
import type { EventUnion, SnapshotLineage, WorkspaceStatus, WorkspaceView } from "@wsp/protocol";
import { MachineSurface } from "../../src/components/machine/MachineSurface";
import type { Api } from "../../src/protocol/client";
import { useStore } from "../../src/protocol/store";
import "../../src/index.css";

document.documentElement.classList.toggle("dark", new URLSearchParams(window.location.search).get("theme") !== "light");

const workspace: WorkspaceView = { id: "ws_mac", name: "zingzy-mac", machineId: "local", phase: "running", golden: "", createdAt: "2026-09-08T09:00:00Z", kind: "local" };
const status: WorkspaceStatus = { ...workspace, machineState: "running", reach: { state: "reachable" }, size: { cpu: 10, memMb: 16384 }, rateUsdPerHour: 0 };
// A sealed golden the host still holds: the local tab must show none of it, whatever the host knows about images.
const lineage: SnapshotLineage = { name: "default", head: 12, versions: [{ version: 12, snapshotId: "snap_golden-v12", baseTemplate: "base", setupSha: "sha12", createdAt: "2026-08-22T00:00:00.000Z", smoke: { cmd: "true", exitCode: 0 } }] };

const listeners = new Set<(e: EventUnion) => void>();
const api: Api = {
  upgrade: async () => workspace,
  capabilities: async () => ({ liveCloneForks: true, ramPreservingPause: true, resize: true, previewUrls: true, signedUrls: true, containers: true, callbackRelay: true, snapshotListing: true, templates: false, sizes: [] }),
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
