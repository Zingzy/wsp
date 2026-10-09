// SPDX-License-Identifier: AGPL-3.0-only
// Served by Vite to a real browser: the app shell over a fake host with one
// busy lead on this computer, its turn running through a list of six steps,
// stopped on a question to the person, with two messages waiting for the turn
// to end. One state per ?screen=, in either theme (?theme=light): question is
// the question panel in the composer's place, drawer the question folded to
// the drawer's first row over the tasks and the messages, folded the same
// with no message waiting, and tasks and queue those rows' bars open. Every
// screen is the product's own components over the wire's shapes. A small
// switcher floats at the top right; ?bar=0 hides it for a shot.
import { createRoot } from "react-dom/client";
import { DEFAULT_PREFERENCES, QUESTION_TOOL, askingLine, questionOptions, type HarnessCatalog, type PlaceView, type ProjectView, type SessionEvent, type SessionView, type WorkspaceView } from "@wsp/protocol";
import { useComposerBarStore } from "../../src/components/chat/composerBar";
import { useComposerDraftStore } from "../../src/components/chat/composerDraftStore";
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
import { ACCESS_MODES } from "../fixtures/access-modes";
import "../../src/index.css";
import "../../src/themes/index";

const params = new URLSearchParams(window.location.search);
const theme: "light" | "dark" = params.get("theme") === "light" ? "light" : "dark";
const picks = { lightTheme: params.get("lightTheme") ?? DEFAULT_PREFERENCES.lightTheme, darkTheme: params.get("darkTheme") ?? DEFAULT_PREFERENCES.darkTheme };
applyTheme({ theme, ...picks }, theme === "dark");
const SCREENS = ["question", "drawer", "folded", "tasks", "queue"] as const;
type Screen = (typeof SCREENS)[number];
const screen: Screen = (SCREENS as readonly string[]).includes(params.get("screen") ?? "") ? (params.get("screen") as Screen) : "drawer";

const HERE: PlaceView = { id: "here", kind: "computer", name: "zingzy-mbp", label: "zingzy's MacBook Pro", mac: "macbook", default: true, present: true, shape: { cpu: 10, memMb: 16384 }, takesForks: false, agentVersions: { claude: "2.1.286", codex: "0.47.0" } };
const PROJECT: ProjectView = { id: "pr_wsp", name: "wsp", computer: "here", source: { kind: "folder", path: "/Users/dev/wsp" }, path: "/Users/dev/wsp", remote: "github.com/acme/lab", defaultBranch: "main", memoryKey: "pr_wsp", memoryDir: "/m" } as ProjectView;
const MAC: WorkspaceView = { id: "ws_m", name: "wsp", kind: "local", machineId: "local", project: { id: PROJECT.id, name: PROJECT.name, path: PROJECT.path, computer: "here" }, phase: "running", golden: "", createdAt: "2026-10-09T09:00:00Z", place: "here" } as WorkspaceView;
const workspaces = [MAC];

const SEC = 1_000;
const MIN = 60 * SEC;
const ago = (ms: number): number => Date.now() - ms;
const THREAD = "thr_lead";
const scope = { workspaceId: MAC.id, sessionId: "s_lead", turnId: "turn_lead", threadId: THREAD };
const SLASH = ["compact", "context", "cost", "init", "review", "model", "permissions", "help"];
const PROMPT = "Run the marathon: a builder per open ticket, a reviewer per pull request, and land what passes.";
const STARTED = ago(9 * MIN);

const STEPS = ["Read the open tickets on the map", "Start a builder per ticket", "Start a reviewer per pull request", "Run fix rounds until each review passes", "Merge what passed into main", "Report what needs the person"];
/** The list as the agent rewrites it: the first step took 1m 14s, the second 31s, the third has run 12s. */
const plan = (at: number, done: number): SessionEvent => ({ type: "session.plan", ...scope, at, steps: STEPS.map((text, n) => ({ text, state: n < done ? "done" : n === done ? "working" : "pending" })) });
const NEXT = {
  question: "Which ticket should the next free builder take?",
  header: "Next",
  multiSelect: false,
  options: [
    { label: "Lead threads (#1830)", description: "The design the owner is judging now." },
    { label: "Whole-page restyles (#1866)", description: "Typing is slow on long threads." },
    { label: "Box thread (#1615)", description: "Step 2 of the box thread in the project folder." },
  ],
};
const input = JSON.stringify({ questions: [NEXT] });
const asked = { toolName: QUESTION_TOOL, toolUseId: "toolu_next", input, options: questionOptions(QUESTION_TOOL, input) };

const history: SessionEvent[] = [
  { type: "session.start", ...scope, agent: "claude", model: "claude-opus-5-5", cwd: "/Users/dev/wsp", prompt: PROMPT, at: STARTED, harness: { slashCommands: SLASH } },
  plan(ago(117 * SEC), 0),
  plan(ago(43 * SEC), 1),
  plan(ago(12 * SEC), 2),
  {
    type: "session.delta",
    ...scope,
    kind: "text",
    at: ago(11 * SEC),
    text: "Eight threads are out. 1805's builder hung on the CSP gate, so I stopped it and started it again; 1827 failed on the desktop smoke and I'll read its log next. Two builds are waiting for a slot on your MacBook.\n\nI'll take each report as it lands.",
  },
  { type: "session.permission", ...scope, at: ago(10 * SEC), askId: "ask_next", ...asked },
];

const lead: SessionView = { id: "s_lead", threadId: THREAD, workspaceId: MAC.id, harness: "claude", status: "running", prompt: PROMPT, harnessTitle: "Coordinator: the marathon", startedBy: "person", startedAt: STARTED, model: "claude-opus-5-5", asking: askingLine(asked) } as SessionView;
const others: SessionView[] = [
  { id: "s_work", threadId: "thr_work", workspaceId: MAC.id, harness: "codex", status: "running", prompt: "Review 1822: the worktree carries", harnessTitle: "Review 1822: the worktree carries", startedBy: "agent", parentThreadId: THREAD, startedAt: ago(41 * MIN) } as SessionView,
  { id: "s_done", threadId: "thr_done", workspaceId: MAC.id, harness: "claude", status: "completed", prompt: "Probe: send latency on the relay", harnessTitle: "Probe: send latency", startedBy: "person", startedAt: ago(70 * MIN), endedAt: ago(52 * MIN) } as SessionView,
];
const sessions: SessionView[] = [lead, ...others];

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
    steers: false,
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
  watchStatuses: async () => workspaces.map(w => statusOf(w, { kind: "local", size: { cpu: 10, memMb: 16384 }, rateUsdPerHour: 0, facts: { os: "macOS 26.1", uptimeMs: 3 * 86_400_000, folder: "/Users/dev/wsp" } })),
  forget: async () => {},
  nap: async () => MAC,
  wake: async () => MAC,
  capabilities: async () => caps(),
  startSession: async () => ({ id: "s_lead", workspaceId: MAC.id, harness: "claude", status: "running" }),
  portReach: async (_id, port) => ({ url: `http://127.0.0.1:${port}`, expiresAt: Date.now() + 3_600_000 }),
  daemon: noDaemonApi,
  sessionHistory: async () => history,
  answerPermission: async () => "answered",
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
// What the person did in this window before the shot: folded the question, wrote two messages, opened a bar.
useComposerDraftStore.setState({ drafts: {}, queues: {}, held: {} });
if (screen !== "question") useComposerBarStore.setState({ folded: { [THREAD]: "ask_next" } });
if (screen === "drawer" || screen === "queue") {
  useComposerDraftStore.getState().enqueue(THREAD, "When 1811 lands, rebase 1866 onto it before its review.");
  useComposerDraftStore.getState().enqueue(THREAD, "Skip 1830's build until the owner locks the design.");
}
if (screen === "tasks" || screen === "queue") useComposerBarStore.getState().openBar(THREAD, screen);
useStore.getState().bind(api);
useStore.getState().select(MAC.id, THREAD);
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
        <WorkspaceThread workspaceId={MAC.id} threadId={THREAD} />
      </div>
    </AppShell>
    <Switcher />
  </TooltipProvider>,
);
