// SPDX-License-Identifier: AGPL-3.0-only
// Served by Vite to a real browser: the machine tab of a running workspace
// whose daemon predates the live and process ops, in either theme
// (?theme=light), so a test can lay out and photograph the unavailable rows
// and the update line. The update resolves after a moment and the hello that
// follows names the current version, as the redeployed daemon's would.
import { createRoot } from "react-dom/client";
import { DAEMON_VERSION, type EventUnion, type SnapshotLineage, type WorkspaceStatus, type WorkspaceView } from "@wsp/protocol";
import { MachineSurface } from "../../src/components/machine/MachineSurface";
import { TooltipProvider } from "../../src/components/ui/tooltip";
import { provideDaemonVersion } from "../../src/machine/daemon";
import { getLive } from "../../src/machine/live";
import type { Api } from "../../src/protocol/client";
import { useStore } from "../../src/protocol/store";
import "../../src/index.css";

document.documentElement.classList.toggle("dark", new URLSearchParams(window.location.search).get("theme") !== "light");

const workspace: WorkspaceView = { id: "ws_api", name: "api", machineId: "m_api_0123456789abcdef", phase: "running", golden: "snap_golden-v1", createdAt: "2026-08-30T09:00:00Z" };
const status: WorkspaceStatus = { ...workspace, machineState: "running", reach: { state: "reachable" }, size: { cpu: 2, memMb: 4096 }, rateUsdPerHour: 0.11 };
const lineage: SnapshotLineage = { name: "default", head: 1, versions: [{ version: 1, snapshotId: "snap_golden-v1", baseTemplate: "base", setupSha: "sha1", createdAt: "2026-09-05T11:38:00.000Z", smoke: { cmd: "true", exitCode: 0 } }] };

const listeners = new Set<(e: EventUnion) => void>();
const api: Api = {
  upgrade: async () => workspace,
  capabilities: async () => ({ liveCloneForks: true, ramPreservingPause: true, resize: true, previewUrls: true, signedUrls: true, containers: true, callbackRelay: true, snapshotListing: true }),
  portReach: async (_id, port) => ({ url: `https://m1-${port}.preview.example/?pt_token=e`, expiresAt: Date.now() + 3_600_000 }),
  daemonReach: async () => ({ url: "ws://127.0.0.1:1", expiresAt: 0 }),
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
  updateDaemon: async () => {
    await new Promise(r => setTimeout(r, 1_500));
    const live = getLive(workspace.id);
    live.feedUnavailable(null);
    provideDaemonVersion(workspace.id, DAEMON_VERSION);
    const GiB = 1024 ** 3;
    live.feedSample({ type: "sys.sample", cpu: 12, load1: 0.42, mem: { used: 1.1 * GiB, total: 4 * GiB }, disk: { used: 20 * GiB, total: 100 * GiB }, at: Date.now() });
  },
  subscribe: fn => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};

useStore.getState().bind(api);
getLive(workspace.id).feedStatus("live");
getLive(workspace.id).feedUnavailable("unknown op: sys.watch");
provideDaemonVersion(workspace.id, 1);
createRoot(document.getElementById("root")!).render(
  <TooltipProvider>
    <div className="h-full w-[22rem] border-r border-border bg-background text-foreground" data-testid="machine-tab">
      <MachineSurface workspaceId={workspace.id} />
    </div>
  </TooltipProvider>,
);
