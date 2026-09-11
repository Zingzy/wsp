// SPDX-License-Identifier: AGPL-3.0-only
// Served by Vite to a real browser: the machine tab of a workspace the runtime
// has metered for two days, in either theme (?theme=light), so a test can lay
// out and photograph the usage chart over its ranges; ?empty=1 serves a
// workspace with no cost yet. The newest tick lands on the wire after a beat,
// as it does when the tab opens on a running workspace.
import { createRoot } from "react-dom/client";
import { appendCostPoint, type EventUnion, type SnapshotLineage, type WorkspaceCostEvent, type WorkspaceStatus, type WorkspaceView } from "@wsp/protocol";
import { MachineSurface } from "../../src/components/machine/MachineSurface";
import { TooltipProvider } from "../../src/components/ui/tooltip";
import type { Api } from "../../src/protocol/client";
import { useStore } from "../../src/protocol/store";
import "../../src/index.css";
import { caps } from "../caps.js";

const query = new URLSearchParams(window.location.search);
document.documentElement.classList.toggle("dark", query.get("theme") !== "light");
const empty = query.get("empty") === "1";

const NOW = Date.UTC(2026, 8, 6, 6, 24);
const workspace: WorkspaceView = { id: "ws_api", name: "api", machineId: "m_api_0123456789abcdef", phase: "napping", golden: "snap_golden-v1", createdAt: new Date(NOW - 50 * 3_600_000).toISOString() };
const status: WorkspaceStatus = { ...workspace, machineState: "paused", reach: { state: "napping" }, size: { cpu: 4, memMb: 8192 }, rateUsdPerHour: 0.22 };
const lineage: SnapshotLineage = { name: "default", head: 1, versions: [{ version: 1, snapshotId: "snap_golden-v1", baseTemplate: "base", setupSha: "sha1", createdAt: "2026-09-04T11:38:00.000Z", smoke: { cmd: "true", exitCode: 0 } }] };

/** Two days of five-second ticks folded as the runtime folds them: awake stretches at two sizes around naps. */
function metered(): WorkspaceCostEvent[] {
  const start = NOW - 50 * 3_600_000;
  const rateAt = (h: number): number => (h < 6 ? 0.11 : h < 16 ? 0 : h < 24 ? 0.11 : h < 27 ? 0 : h < 32 ? 0.22 : h < 41 ? 0 : h < 46.5 ? 0.22 : 0);
  let points: WorkspaceCostEvent[] = [];
  let accrued = 0;
  let awakeMs = 0;
  for (let t = start; t <= NOW; t += 300_000) {
    const rate = rateAt((t - start) / 3_600_000);
    points = appendCostPoint(points, { type: "workspace.cost", workspaceId: workspace.id, phase: rate > 0 ? "running" : "napping", rateUsdPerHour: rate, awakeMs, accruedUsd: accrued, at: new Date(t).toISOString() });
    accrued += (rate * 300_000) / 3_600_000;
    if (rate > 0) awakeMs += 300_000;
  }
  return points;
}
const history = empty ? [] : metered();

const listeners = new Set<(e: EventUnion) => void>();
const api: Api = {
  upgrade: async () => workspace,
  capabilities: async () => (caps()),
  portReach: async (_id, port) => ({ url: `https://m1-${port}.preview.example/?pt_token=e`, expiresAt: Date.now() + 3_600_000 }),
  daemonReach: async () => ({ url: "ws://127.0.0.1:1", expiresAt: 0 }),
  startSession: async o => ({ id: "s1", workspaceId: o.workspaceId, harness: "claude", status: "running" }),
  sessionHistory: async () => [],
  listSnapshots: async () => lineage,
  snapshotStorage: async () => null,
  costHistory: async () => history,
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
const newest = history[history.length - 1];
if (newest !== undefined) setTimeout(() => listeners.forEach(fn => fn(newest)), 300);
createRoot(document.getElementById("root")!).render(
  <TooltipProvider>
    <div className="h-full w-[22rem] border-r border-border bg-background text-foreground" data-testid="machine-tab">
      <MachineSurface workspaceId={workspace.id} />
    </div>
  </TooltipProvider>,
);
