// SPDX-License-Identifier: AGPL-3.0-only
// Served by Vite to a real browser: the machine tab of a workspace still
// forked from v11 while the golden's head is v12, with rows v12 retired, in
// either theme (?theme=light), so a test can lay out and photograph the offer
// and the retired list that jsdom cannot.
import { createRoot } from "react-dom/client";
import type { EventUnion, SnapshotLineage, WorkspaceStatus, WorkspaceView } from "@wsp/protocol";
import { MachineSurface } from "../../src/components/machine/MachineSurface";
import type { Api } from "../../src/protocol/client";
import { useStore } from "../../src/protocol/store";
import "../../src/index.css";
import { caps } from "../caps.js";

document.documentElement.classList.toggle("dark", new URLSearchParams(window.location.search).get("theme") !== "light");

const workspace: WorkspaceView = { id: "ws_api", name: "api", machineId: "m_api_0123456789abcdef", phase: "running", golden: "snap_golden-v11", createdAt: "2026-08-30T09:00:00Z" };
const status: WorkspaceStatus = { ...workspace, machineState: "running", reach: { state: "reachable" }, size: { cpu: 2, memMb: 4096 }, rateUsdPerHour: 0.11 };
const version = (n: number) => ({ version: n, snapshotId: `snap_golden-v${n}`, baseTemplate: "base", setupSha: `sha${n}`, createdAt: `2026-08-${10 + n}T00:00:00.000Z`, smoke: { cmd: "true", exitCode: 0 } });
const lineage: SnapshotLineage = {
  name: "default",
  head: 12,
  versions: [
    { ...version(11), retired: [{ id: "tools/brew/yq", name: "yq" }, { id: "shell/zshrc", name: "~/.zshrc" }, { id: "tools/brew/zingzy/tap/diskbloom", name: "diskbloom" }] },
    version(12),
  ],
};

const listeners = new Set<(e: EventUnion) => void>();
const api: Api = {
  upgrade: async () => workspace,
  updateImage: async () => ({ workspace: { ...workspace, golden: "snap_golden-v12" }, moved: true, kept: [".zshrc"] }),
  capabilities: async () => (caps()),
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
