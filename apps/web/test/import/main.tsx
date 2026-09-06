// SPDX-License-Identifier: AGPL-3.0-only
// Served by Vite to a real browser: the import dialog for a running workspace
// over a fake api, in either theme (?theme=light), with the folder already
// read (?secrets=0 for a plan with nothing secret-shaped), as the desktop
// shell shows it. Import plays the runtime's six events a beat apart and then
// resolves, so a test can lay out and photograph the summary, the consent box
// and the finished steps.
import { createRoot } from "react-dom/client";
import type { EventUnion, ProjectImportEvent, ProjectPlan, WorkspaceView } from "@wsp/protocol";
import { TooltipProvider } from "../../src/components/ui/tooltip";
import type { Api } from "../../src/protocol/client";
import { useStore } from "../../src/protocol/store";
import { ImportProjectDialog } from "../../src/sidebar/ImportProjectDialog";
import "../../src/index.css";

const params = new URLSearchParams(window.location.search);
document.documentElement.classList.toggle("dark", params.get("theme") !== "light");
// The desktop shell's bridge, so the picker button is laid out; nothing here opens a system dialog.
window.wsp = { pickFolder: async () => undefined };

const SOURCE = "/Users/me/code/spoo";
const workspace: WorkspaceView = { id: "ws_api", name: "api", machineId: "m_api", phase: "running", golden: "snap_g", createdAt: "2026-09-05T11:00:00Z" };
const plan: ProjectPlan = {
  source: SOURCE,
  repo: true,
  files: 1_204,
  bytes: 38.2 * 1024 * 1024,
  secrets:
    params.get("secrets") === "0"
      ? []
      : [
          { path: ".env", bytes: 812, signals: ["name", "keys"] },
          { path: "config/service-account.json", bytes: 2_310, signals: ["keys"] },
          { path: ".git/config", bytes: 338, signals: ["url"], rewrite: { urls: ["https://github.com/zingzy/spoo.git"], drop: ["http.extraheader"] } },
        ],
  excluded: ["node_modules", "dist", ".venv", "coverage"],
  skipped: [{ path: "public/uploads", note: "points outside the folder; not followed" }],
};

const listeners = new Set<(e: EventUnion) => void>();
const emit = (over: Partial<ProjectImportEvent>): void => {
  const e: EventUnion = { type: "project.import", workspaceId: workspace.id, source: SOURCE, dest: SOURCE, stage: "planned", message: "", elapsedMs: 0, ...over };
  listeners.forEach(fn => fn(e));
};
const beat = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

const api: Api = {
  listWorkspaces: async () => [workspace],
  getWorkspace: async () => workspace,
  createWorkspace: async () => workspace,
  createFromGoldenHead: async () => workspace,
  watchStatuses: async () => [],
  nap: async () => workspace,
  wake: async () => workspace,
  upgrade: async () => workspace,
  capabilities: async () => ({ liveCloneForks: true, ramPreservingPause: true, resize: true, previewUrls: true, signedUrls: true, containers: true, callbackRelay: true, snapshotListing: true }),
  startSession: async o => ({ id: "s1", workspaceId: o.workspaceId, harness: "claude", status: "running" }),
  portReach: async (_id, port) => ({ url: `https://m1-${port}.preview.example/?pt_token=e`, expiresAt: Date.now() + 3_600_000 }),
  daemonReach: async () => ({ url: "ws://127.0.0.1:1", expiresAt: 0 }),
  sessionHistory: async () => [],
  listSnapshots: async () => ({ name: "default", head: null, versions: [] }),
  snapshotStorage: async () => null,
  rollbackSnapshot: async () => ({ lineage: { name: "default", head: null, versions: [] }, existingWorkspaces: "untouched" }),
  listSessions: async () => [],
  getGolden: async () => undefined,
  planProject: async () => plan,
  importProject: async o => {
    const cut = plan.secrets.filter(s => !(o.carry ?? []).includes(s.path) && !(o.rewrite ?? []).includes(s.path)).map(s => s.path);
    emit({ stage: "planned", message: "1204 files, 38.2 MB and the repository; 3 secret-shaped files; 4 caches left behind.", elapsedMs: 180 });
    await beat(150);
    emit({ stage: "consented", message: `Rewriting .git/config to https://github.com/zingzy/spoo.git without http.extraheader; cut ${cut.join(", ")}.`, elapsedMs: 190 });
    await beat(150);
    emit({ stage: "packing", message: "Packing 1202 files.", elapsedMs: 210 });
    await beat(150);
    emit({ stage: "uploading", message: "Uploading 31.0 MB.", elapsedMs: 2_400, bytes: 0, total: 32_505_856 });
    await beat(150);
    emit({ stage: "uploading", message: "Part 1 of 1, 31.0 MB of 31.0 MB.", elapsedMs: 6_900, bytes: 32_505_856, total: 32_505_856 });
    await beat(150);
    emit({ stage: "landing", message: `Landing at ${SOURCE}.`, elapsedMs: 7_100 });
    await beat(150);
    emit({ stage: "done", message: `1202 files, 38.0 MB, landed at ${SOURCE}.`, elapsedMs: 9_800 });
    return { dest: SOURCE, files: 1_202, bytes: 38.0 * 1024 * 1024, parts: 1, cut, rewritten: [".git/config"] };
  },
  subscribe: fn => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};

useStore.setState({ conn: "live", workspaces: [workspace] });
useStore.getState().bind(api);
createRoot(document.getElementById("root")!).render(
  <TooltipProvider>
    <div className="h-full bg-background text-foreground">
      <ImportProjectDialog workspace={workspace} initialSource={SOURCE} onClose={() => {}} />
    </div>
  </TooltipProvider>,
);
