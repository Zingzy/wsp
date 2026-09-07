// SPDX-License-Identifier: AGPL-3.0-only
// Served by Vite to a real browser: the machine tab of a workspace forked from
// a project golden, with its project loaded and three project goldens across
// two versions, in either theme (?theme=light), so a test can lay out and
// photograph what jsdom cannot.
import { createRoot } from "react-dom/client";
import type { EventUnion, ProjectGolden, SnapshotLineage, WorkspaceStatus, WorkspaceView } from "@wsp/protocol";
import { MachineSurface } from "../../src/components/machine/MachineSurface";
import type { Api } from "../../src/protocol/client";
import { useStore } from "../../src/protocol/store";
import "../../src/index.css";

document.documentElement.classList.toggle("dark", new URLSearchParams(window.location.search).get("theme") !== "light");

const project = { name: "spoo", dest: "/root/work/spoo", importedAt: "2026-09-06T10:01:00.000Z" };
const workspace: WorkspaceView = { id: "ws_api", name: "spoo-fork", machineId: "m_api_0123456789abcdef", phase: "running", golden: "snap_project-spoo-2", createdAt: "2026-09-06T12:00:00Z", project };
const status: WorkspaceStatus = { ...workspace, machineState: "running", reach: { state: "reachable" }, size: { cpu: 2, memMb: 4096 }, rateUsdPerHour: 0.11 };
const version = (n: number) => ({ version: n, snapshotId: `snap_golden-v${n}`, baseTemplate: "base", setupSha: `sha${n}`, createdAt: `2026-08-${10 + n}T00:00:00.000Z`, smoke: { cmd: "true", exitCode: 0 } });
const lineage: SnapshotLineage = { name: "default", head: 12, versions: [version(11), version(12)] };
const golden = (snapshotId: string, root: number, createdAt: string, workspaceName: string, name = project.name): ProjectGolden => ({
  snapshotId,
  project: { ...project, name, dest: `/root/work/${name}` },
  golden: `snap_golden-v${root}`,
  version: root,
  workspaceId: "ws_src",
  workspaceName,
  createdAt,
});
const goldens: ProjectGolden[] = [
  golden("snap_project-spoo-1", 12, "2026-09-06T10:06:00.000Z", "spoo"),
  golden("snap_project-spoo-2", 12, "2026-09-06T11:30:00.000Z", "spoo"),
  golden("snap_project-wsp-1", 11, "2026-09-05T18:00:00.000Z", "wsp-main", "wsp"),
];

const listeners = new Set<(e: EventUnion) => void>();
const api: Api = {
  upgrade: async () => workspace,
  capabilities: async () => ({ liveCloneForks: true, ramPreservingPause: true, resize: true, previewUrls: true, signedUrls: true, containers: true, callbackRelay: true, snapshotListing: true, templates: false, sizes: [] }),
  portReach: async (_id, port) => ({ url: `https://m1-${port}.preview.example/?pt_token=e`, expiresAt: Date.now() + 3_600_000 }),
  daemonReach: async () => ({ url: "ws://127.0.0.1:1", expiresAt: 0 }),
  startSession: async o => ({ id: "s1", workspaceId: o.workspaceId, harness: "claude", status: "running" }),
  sessionHistory: async () => [],
  listSnapshots: async () => lineage,
  listProjectGoldens: async () => goldens,
  snapshotWorkspace: async () => goldens[1]!,
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
