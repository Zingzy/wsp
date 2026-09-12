// SPDX-License-Identifier: AGPL-3.0-only
// Served by Vite to a real browser: the import dialog for a running workspace
// over a fake api, in either theme (?theme=light), with the folder already
// read (?secrets=0 for a plan with nothing secret-shaped, ?agents=0 for one
// with no agent sessions), as the desktop shell shows it. Import plays the
// runtime's events a beat apart (?beat=<ms>, 150 by default) and then
// resolves, with the sessions tar's second upload and landing after the
// project's when any agent travels, as the runtime does it, so a test can lay
// out and photograph the summary, the consent rows, the slot mid-upload and the
// landed dialog. With ?long=1 the folder
// sits at a 120-character path and four agents' sessions travelled, one of
// them failing, so the landed line needs a third line.
import { createRoot } from "react-dom/client";
import type { EventUnion, ProjectAgentResult, ProjectImportEvent, ProjectPlan, WorkspaceView } from "@wsp/protocol";
import { TooltipProvider } from "../../src/components/ui/tooltip";
import type { Api } from "../../src/protocol/client";
import { useStore } from "../../src/protocol/store";
import { ImportProjectDialog } from "../../src/sidebar/ImportProjectDialog";
import { fakeHostFolders } from "../host-folders-fixture";
import "../../src/index.css";
import { caps } from "../caps.js";
import { noDaemonApi } from "../fake-daemon-api.js";

const params = new URLSearchParams(window.location.search);
document.documentElement.classList.toggle("dark", params.get("theme") !== "light");
// The desktop shell's bridge, so the picker button is laid out; nothing here opens a system dialog. With ?tab=1
// there is no bridge, which is a browser tab: the folder browser over the host's own folders stands there instead.
const TAB = params.get("tab") === "1";
if (!TAB) window.wsp = { pickFolder: async () => undefined };

const LONG = params.get("long") === "1";
const BEAT = Number(params.get("beat") ?? "150");
const SOURCE = LONG ? "/Users/me/code/clients/northwind-traders/platform/services/billing-reconciliation/workers/nightly-settlements-batch/spoo" : "/Users/me/code/spoo";
const agents: ProjectAgentResult[] = LONG
  ? [
      { agent: "claude", files: 14, bytes: 1_204_000, outcome: "moved", sessions: 6 },
      { agent: "codex", files: 3, bytes: 88_000, outcome: "transcript-only", sessions: 2, skipped: 1 },
      { agent: "gemini", files: 0, bytes: 0, outcome: "nothing" },
      { agent: "opencode", files: 0, bytes: 0, outcome: "failed", error: "state.db is locked by another process on the machine" },
    ]
  : [];
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
  agents:
    params.get("agents") === "0"
      ? []
      : [
          { agent: "claude", name: "Claude Code", sessions: 46, bytes: 9_400_000, carry: "moves" },
          { agent: "codex", name: "Codex", sessions: 2, bytes: 88_000, carry: "transcript-only" },
          { agent: "opencode", name: "OpenCode", sessions: 0, bytes: 0, carry: "moves", error: "state.db is locked by another process" },
        ],
};

const listeners = new Set<(e: EventUnion) => void>();
const emit = (over: Partial<ProjectImportEvent>): void => {
  const e: EventUnion = { type: "project.import", workspaceId: workspace.id, source: SOURCE, dest: SOURCE, stage: "planned", message: "", elapsedMs: 0, ...over };
  listeners.forEach(fn => fn(e));
};
const beat = (): Promise<void> => new Promise(r => setTimeout(r, BEAT));

const api: Api = {
  listWorkspaces: async () => [workspace],
  getWorkspace: async () => workspace,
  createWorkspace: async () => workspace,
  createFromGoldenHead: async () => workspace,
  watchStatuses: async () => [],
  nap: async () => workspace,
  wake: async () => workspace,
  upgrade: async () => workspace,
  capabilities: async () => (caps()),
  startSession: async o => ({ id: "s1", workspaceId: o.workspaceId, harness: "claude", status: "running" }),
  portReach: async (_id, port) => ({ url: `https://m1-${port}.preview.example/?pt_token=e`, expiresAt: Date.now() + 3_600_000 }),
  daemon: noDaemonApi,
  sessionHistory: async () => [],
  listSnapshots: async () => ({ name: "default", head: null, versions: [] }),
  snapshotStorage: async () => null,
  rollbackSnapshot: async () => ({ lineage: { name: "default", head: null, versions: [] }, existingWorkspaces: "untouched" }),
  listSessions: async () => [],
  getGolden: async () => undefined,
  hostFolders: fakeHostFolders(),
  planProject: async () => plan,
  importProject: async o => {
    const cut = plan.secrets.filter(s => !(o.carry ?? []).includes(s.path) && !(o.rewrite ?? []).includes(s.path)).map(s => s.path);
    const travelling = plan.agents.filter(a => a.error === undefined && (o.agents ?? []).includes(a.agent));
    const sessions = plan.agents.length === 0 ? "" : travelling.length === 0 ? " No agent sessions travel." : ` Sessions travel for ${travelling.map(a => `${a.name} (${a.sessions} sessions)`).join(", ")}.`;
    emit({ stage: "planned", message: "1204 files, 38 MB and the repository; 3 secret-shaped files; 4 caches left behind.", elapsedMs: 180 });
    await beat();
    emit({ stage: "consented", message: `Rewriting .git/config to https://github.com/zingzy/spoo.git without http.extraheader; cut ${cut.join(", ")}.${sessions}`, elapsedMs: 190 });
    await beat();
    emit({ stage: "packing", message: "Packing 1202 files.", elapsedMs: 210 });
    await beat();
    emit({ stage: "uploading", message: "Uploading 31 MB.", elapsedMs: 2_400, bytes: 0, total: 32_505_856 });
    await beat();
    emit({ stage: "uploading", message: "Part 1 of 2, 16 MB of 31 MB.", elapsedMs: 4_600, bytes: 16_252_928, total: 32_505_856 });
    await beat();
    emit({ stage: "uploading", message: "Part 2 of 2, 31 MB of 31 MB.", elapsedMs: 6_900, bytes: 32_505_856, total: 32_505_856 });
    await beat();
    emit({ stage: "landing", message: `Landing at ${SOURCE}.`, elapsedMs: 7_100 });
    await beat();
    if (travelling.length > 0) {
      emit({ stage: "uploading", message: "Uploading 48 session files and the rows to merge, 1 MB.", elapsedMs: 7_300, bytes: 0, total: 1_258_291 });
      await beat();
      emit({ stage: "uploading", message: "Part 1 of 1, 1 MB of 1 MB.", elapsedMs: 7_900, bytes: 1_258_291, total: 1_258_291 });
      await beat();
      emit({ stage: "landing", message: `Landing sessions: ${travelling.map(a => `${a.name} moved`).join(", ")}.`, elapsedMs: 8_400 });
      await beat();
    }
    emit({ stage: "done", message: `1202 files, 38 MB, landed at ${SOURCE}.`, elapsedMs: 9_800 });
    return { dest: SOURCE, files: 1_202, bytes: 38.0 * 1024 * 1024, parts: 1, cut, rewritten: [".git/config"], agents };
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
