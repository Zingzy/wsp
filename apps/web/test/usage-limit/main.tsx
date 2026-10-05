// SPDX-License-Identifier: AGPL-3.0-only
// Served by Vite to a real browser: the app shell over a fake host with one
// thread on this computer whose latest turn an agent's usage limit stopped,
// one state per ?screen=, in either theme (?theme=light). hit is the turn
// right after the limit with the reset known, unknown the same with no reset
// named, armed is Resume at reset pressed, and resumed the turn going on after
// the reset. Every screen is the product's own components over the wire's
// shapes, so a screenshot of one is what the app would draw for that record.
// Resume at reset and Cancel work on the page: they move the row and the
// store reads it again. A small switcher floats at the top right for a person
// walking the states; ?bar=0 hides it for a shot.
import { createRoot } from "react-dom/client";
import { DEFAULT_PREFERENCES, type HarnessCatalog, type PlaceView, type ProjectView, type SessionEvent, type SessionView, type WorkspaceView } from "@wsp/protocol";
import { TooltipProvider } from "../../src/components/ui/tooltip";
import type { Api, ProtocolEvent } from "../../src/protocol/client";
import { useStore } from "../../src/protocol/store";
import { useRightPanelStore } from "../../src/rightPanelStore";
import { AppShell } from "../../src/shell/AppShell";
import { WorkspaceThread } from "../../src/shell/WorkspaceThread";
import { applyTheme } from "../../src/settings/theme";
import { statusOf } from "../workspace-status";
import { caps } from "../caps.js";
import { noDaemonApi } from "../fake-daemon-api.js";
import "../../src/index.css";
import "../../src/themes/index";

const params = new URLSearchParams(window.location.search);
const theme: "light" | "dark" = params.get("theme") === "light" ? "light" : "dark";
const picks = { lightTheme: params.get("lightTheme") ?? DEFAULT_PREFERENCES.lightTheme, darkTheme: params.get("darkTheme") ?? DEFAULT_PREFERENCES.darkTheme };
applyTheme({ theme, ...picks }, theme === "dark");
const SCREENS = ["hit", "unknown", "armed", "resumed"] as const;
type Screen = (typeof SCREENS)[number];
const screen: Screen = (SCREENS as readonly string[]).includes(params.get("screen") ?? "") ? (params.get("screen") as Screen) : "hit";

const HERE: PlaceView = { id: "here", kind: "computer", name: "zingzy-mbp", label: "zingzy's MacBook Pro", mac: "macbook", default: true, present: true, shape: { cpu: 10, memMb: 16384 }, takesForks: false, agentVersions: { claude: "2.1.286", codex: "0.47.0" } };
const PROJECT: ProjectView = { id: "pr_wsp", name: "wsp", computer: "here", source: { kind: "folder", path: "/Users/zingzy/wsp" }, path: "/Users/zingzy/wsp", remote: "github.com/Zingzy/wsp", defaultBranch: "main", memoryKey: "pr_wsp", memoryDir: "/m" } as ProjectView;
const MAC: WorkspaceView = { id: "ws_m", name: "wsp", kind: "local", machineId: "local", project: { id: PROJECT.id, name: PROJECT.name, path: PROJECT.path, computer: "here" }, phase: "running", golden: "", createdAt: "2026-10-06T09:00:00Z", place: "here" } as WorkspaceView;
const workspaces = [MAC];

const MIN = 60_000;
const ago = (m: number): number => Date.now() - m * MIN;
/** The reset the agent named: two hours out while the turn stands stopped, four minutes back once it went on. */
const RESET = screen === "resumed" ? ago(4) : Date.now() + 134 * MIN;
const HIT = screen === "resumed" ? ago(19) : ago(3);
const STARTED = HIT - 17 * MIN;
const agent = screen === "unknown" ? "codex" : "claude";
const model = agent === "codex" ? "gpt-5.5" : "claude-opus-5-5";
const scope = { workspaceId: MAC.id, sessionId: "s_lim", turnId: "turn_lim", threadId: "thr_lim" };
const SLASH = ["compact", "context", "cost", "init", "review", "model", "permissions", "help"];
const limit = screen === "unknown" ? {} : { resetsAt: RESET };
const RAW = agent === "codex" ? "You've hit your usage limit. Upgrade to Pro (https://openai.com/chatgpt/pricing) or try again at 1:13 PM." : "You've hit your limit · resets 1pm";

const PROMPT = "Fix the flaky tile test in the sidebar suite, then run the whole web suite and tell me what else is red.";
const history: SessionEvent[] = [
  { type: "session.start", ...scope, agent, model, cwd: "/Users/zingzy/wsp", prompt: PROMPT, at: STARTED, harness: { slashCommands: SLASH } },
  {
    type: "session.delta",
    ...scope,
    kind: "text",
    at: STARTED + 2 * MIN,
    text: "The flaky one is `a waiting tile keeps the foreground ink`: it reads the tile's class before the status store has settled, so under load the first paint still has the muted ink. I'll wait on the status slot instead of the title and move on to the suite.",
  },
  { type: "session.done", ...scope, at: HIT, result: { status: "failed", error: RAW, limit, durationMs: HIT - STARTED, costUsd: 0.42 } },
  { type: "session.end", ...scope, at: HIT, exitCode: 1, sawResult: true },
  ...(screen === "resumed"
    ? ([
        { type: "session.start", ...scope, sessionId: "s_lim2", turnId: "turn_lim2", agent, model, cwd: "/Users/zingzy/wsp", at: RESET, afterLimit: RESET, harness: { slashCommands: SLASH } },
        { type: "session.delta", ...scope, sessionId: "s_lim2", turnId: "turn_lim2", kind: "text", at: RESET + MIN, text: "Back on it. The tile test now waits on the status slot; running the web suite." },
      ] as SessionEvent[])
    : []),
];

const sessionRow = (over: Partial<SessionView>): SessionView => ({ id: "s_lim", threadId: "thr_lim", workspaceId: MAC.id, harness: agent, status: "failed", prompt: PROMPT, harnessTitle: "Flaky tile test, then the web suite", startedBy: "person", startedAt: STARTED, endedAt: HIT, model, limit, ...over }) as SessionView;
const lead: SessionView =
  screen === "resumed"
    ? sessionRow({ id: "s_lim2", status: "running", startedAt: RESET, endedAt: undefined, limit: undefined })
    : screen === "armed"
      ? sessionRow({ resumeAt: RESET })
      : sessionRow({});
const others: SessionView[] = [
  { id: "s_work", threadId: "thr_work", workspaceId: MAC.id, harness: "codex", status: "running", prompt: "Review 1705: the usage limit strip", harnessTitle: "Review 1705: the usage limit strip", startedBy: "cli", startedAt: ago(41) } as SessionView,
  { id: "s_done", threadId: "thr_done", workspaceId: MAC.id, harness: "claude", status: "completed", prompt: "Probe: send latency on the relay", harnessTitle: "Probe: send latency", startedBy: "person", startedAt: ago(70), endedAt: ago(52) } as SessionView,
  { id: "s_read", threadId: "thr_read", workspaceId: MAC.id, harness: "claude", status: "completed", prompt: "Questions with visual options", harnessTitle: "Questions with visual options", startedBy: "person", startedAt: ago(150), endedAt: ago(140), readAt: ago(130) } as SessionView,
];
const sessions: SessionView[] = [lead, ...others];

const ACCESS_MODES = [
  { value: "default", label: "Default", description: "Asks in the chat about each action that needs permission" },
  { value: "acceptEdits", label: "Accept edits", description: "Edits files without asking; asks about commands that need permission" },
  { value: "bypassPermissions", label: "Bypass", description: "Runs every action without asking" },
];
const catalogs: HarnessCatalog[] = [
  {
    harness: "claude",
    label: "Claude Code",
    source: "harness",
    version: "2.1.286",
    models: [{ value: "claude-opus-5-5", label: "Opus 5.5", isDefault: true, contextWindows: [] }],
    efforts: [{ value: "high", label: "High", isDefault: true }],
    contextWindows: [],
    permissionModes: ACCESS_MODES,
    steers: true,
    renames: true,
    images: true,
    movesAccess: true,
    access: { ask: "default", "auto-edit": "acceptEdits", full: "bypassPermissions" },
    bypassMode: "bypassPermissions",
    screenCommands: [{ name: "permissions", control: "access" }, { name: "model", control: "model" }, { name: "help", control: "docs" }],
  },
  { harness: "codex", label: "Codex", source: "table", version: "0.47.0", models: [{ value: "gpt-5.5", label: "GPT-5.5", isDefault: true }], efforts: [], contextWindows: [], permissionModes: [], steers: false, renames: false, images: false },
];

const watching = new Set<(event: ProtocolEvent) => void>();
const api: Api = {
  listWorkspaces: async () => workspaces,
  getWorkspace: async () => MAC,
  createWorkspace: async () => MAC,
  watchStatuses: async () => workspaces.map(w => statusOf(w, { kind: "local", size: { cpu: 10, memMb: 16384 }, rateUsdPerHour: 0, facts: { os: "macOS 26.1", uptimeMs: 3 * 86_400_000, folder: "/Users/zingzy/wsp" } })),
  forget: async () => {},
  nap: async () => MAC,
  wake: async () => MAC,
  capabilities: async () => caps(),
  startSession: async () => ({ id: "s_lim", workspaceId: MAC.id, harness: agent, status: "running" }),
  portReach: async (_id, port) => ({ url: `http://127.0.0.1:${port}`, expiresAt: Date.now() + 3_600_000 }),
  daemon: noDaemonApi,
  sessionHistory: async () => history,
  // The press moves the row, as the host would, and the store reads the rows again: the strip and the tile follow.
  resumeAtReset: async (sessionId, on) => {
    const at = sessions.findIndex(row => row.id === sessionId);
    if (at < 0) return;
    const row = { ...sessions[at]! };
    if (on) row.resumeAt = RESET;
    else delete row.resumeAt;
    sessions[at] = row;
    void useStore.getState().reloadSessions(MAC.id);
  },
  setSessionAccess: async () => "set",
  listSnapshots: async () => ({ name: "default", head: null, versions: [] }),
  snapshotStorage: async () => null,
  rollbackSnapshot: async () => ({ lineage: { name: "default", head: null, versions: [] }, existingWorkspaces: "untouched" }),
  listSessions: async () => [...sessions],
  renameSession: async () => ({ outcome: "renamed" }),
  renameWorkspace: async () => MAC,
  setWorkspaceLook: async () => MAC,
  listHarnesses: async () => catalogs,
  subscribe: fn => {
    watching.add(fn);
    return () => watching.delete(fn);
  },
  getGolden: async () => undefined,
  listProjectGoldens: async () => [],
  snapshotWorkspace: async id => ({ snapshotId: "snap_taken", projects: [], golden: "", workspaceId: id, workspaceName: "wsp", createdAt: new Date().toISOString() }),
} as Api;

useStore.setState({
  conn: "live",
  selectedId: MAC.id,
  places: [HERE],
  placesRead: true,
  projects: [PROJECT],
  projectsRead: true,
  preferences: { ...DEFAULT_PREFERENCES, theme, ...picks, labs: false, projectLook: { pr_wsp: { icon: "terminal" as const, hue: "amber" as const } } },
});
useStore.getState().bind(api);
useStore.getState().select(MAC.id, "thr_lim");
useRightPanelStore.setState({ byWorkspaceId: {} });
useRightPanelStore.getState().close(MAC.id);

/** The floating switcher: one link per state and one per theme, in the popover's own tier, gone with ?bar=0. */
function Switcher() {
  if (params.get("bar") === "0") return null;
  const to = (next: Partial<Record<"screen" | "theme", string>>): string => {
    const q = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) if (v !== undefined) q.set(k, v);
    return `?${q.toString()}`;
  };
  const link = (href: string, word: string, on: boolean) => (
    <a key={word} href={href} data-switch={word} className={on ? "text-foreground" : "text-muted-foreground hover:text-foreground"}>
      {word}
    </a>
  );
  return (
    <nav data-screen-switcher className="fixed top-14 right-4 z-50 flex items-center gap-3 rounded-lg border border-border bg-popover px-3 py-1.5 font-mono text-[11px] tabular-nums shadow-[var(--popover-shadow)]">
      {SCREENS.map(name => link(to({ screen: name }), name, name === screen))}
      <span aria-hidden className="h-3 w-px bg-border" />
      {(["dark", "light"] as const).map(name => link(to({ theme: name }), name, name === theme))}
    </nav>
  );
}

createRoot(document.getElementById("root")!).render(
  <TooltipProvider>
    <AppShell>
      <div className="flex min-h-0 flex-1 flex-col" data-terminal-beside>
        <WorkspaceThread workspaceId={MAC.id} threadId="thr_lim" />
      </div>
    </AppShell>
    <Switcher />
  </TooltipProvider>,
);
