// SPDX-License-Identifier: AGPL-3.0-only
// Served by Vite to a real browser: two machine tabs side by side, so a test
// can lay out and photograph what a slot says while it waits and what it says
// on a kind that will never answer. The left one is a machine over ssh, whose
// kind reads no metrics at all; the right one is this computer, whose module
// answers late here, so the rows are photographed at pending and again once
// the sample lands. The sample is landed by the test rather than a timer, so
// the pending state holds still however slow the box is.
import { createRoot } from "react-dom/client";
import type { EventUnion, SysSample, WorkspaceStatus, WorkspaceView } from "@wsp/protocol";
import { MachineSurface } from "../../src/components/machine/MachineSurface";
import { getLive } from "../../src/machine/live";
import type { Api } from "../../src/protocol/client";
import { useStore } from "../../src/protocol/store";
import "../../src/index.css";

document.documentElement.classList.toggle("dark", new URLSearchParams(window.location.search).get("theme") !== "light");

const box: WorkspaceView = { id: "ws_box", name: "build-box", machineId: "ssh:dev@box", phase: "running", golden: "", createdAt: "2026-09-08T09:00:00Z", kind: "ssh" };
const mac: WorkspaceView = { id: "ws_mac", name: "zingzy-mac", machineId: "local", phase: "running", golden: "", createdAt: "2026-09-08T09:00:00Z", kind: "local" };
const statusOf = (w: WorkspaceView): WorkspaceStatus => ({ ...w, machineState: "running", reach: { state: w.kind === "ssh" ? "unsupported" : "reachable" }, size: { cpu: 10, memMb: 16384 }, rateUsdPerHour: 0 });

const GiB = 1024 ** 3;
const sample: SysSample = { type: "sys.sample", cpu: 33.3, load1: 0.42, mem: { used: 6 * GiB, total: 16 * GiB }, disk: { used: 200 * GiB, total: 500 * GiB }, at: 1_757_000_000_000 };

const listeners = new Set<(e: EventUnion) => void>();
const api: Api = {
  upgrade: async () => mac,
  capabilities: async () => ({ liveCloneForks: false, ramPreservingPause: false, resize: false, previewUrls: false, signedUrls: false, containers: false, callbackRelay: false, snapshotListing: false, templates: false, kept: false, sizes: [] }),
  portReach: async () => ({ url: "https://example.invalid", expiresAt: 0 }),
  daemonReach: async () => ({ url: "http://127.0.0.1:1", expiresAt: Number.MAX_SAFE_INTEGER }),
  startSession: async o => ({ id: "s1", workspaceId: o.workspaceId, harness: "claude", status: "running" }),
  sessionHistory: async () => [],
  listSnapshots: async () => ({ name: "default", head: 0, versions: [] }),
  snapshotStorage: async () => null,
  rollbackSnapshot: async () => ({ lineage: { name: "default", head: 0, versions: [] }, existingWorkspaces: "untouched" }),
  listWorkspaces: async () => [box, mac],
  getWorkspace: async id => (id === box.id ? box : mac),
  createWorkspace: async () => mac,
  createFromGoldenHead: async () => mac,
  watchStatuses: async () => [statusOf(box), statusOf(mac)],
  nap: async () => mac,
  wake: async () => mac,
  listSessions: async () => [],
  getGolden: async () => undefined,
  subscribe: fn => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};

// This computer's link is up and its module has answered nothing yet: the state every slot must leave within one
// probe window. The test lands the sample when it has read the pending rows.
getLive(mac.id).feedStatus("live");
(window as unknown as { landSample: () => void }).landSample = () => getLive(mac.id).feedSample(sample);

useStore.getState().bind(api);
createRoot(document.getElementById("root")!).render(
  <div className="flex h-full bg-background text-foreground">
    <div className="h-full w-[22rem] border-r border-border" data-testid="ssh-tab">
      <MachineSurface workspaceId={box.id} />
    </div>
    <div className="h-full w-[22rem] border-r border-border" data-testid="local-tab">
      <MachineSurface workspaceId={mac.id} />
    </div>
  </div>,
);
