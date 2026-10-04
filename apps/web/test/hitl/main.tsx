// SPDX-License-Identifier: AGPL-3.0-only
// Served by Vite to a real browser: the app shell over a fake host with one
// thread on this computer stopped on a prompt, the prompt drawn where the
// composer stands, one kind of prompt per ?screen=, in either theme
// (?theme=light). Every screen is the product's own components over the
// wire's shapes, so a screenshot of one is what the app would draw for that
// record. ?keys=down,down,space sends those keys to the dock after it mounts,
// ?typed=words types into its open field, ?write=1 presses Write a message
// instead, and ?hover=tile rests the pointer on the waiting tile.
import { createRoot } from "react-dom/client";
import { askingLine as askingLineOf, DEFAULT_PREFERENCES, type HarnessCatalog, type PlaceView, type ProjectView, type SessionEvent, type SessionView, type WorkspaceView } from "@wsp/protocol";
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
const screen = params.get("screen") ?? "single";

const HERE: PlaceView = { id: "here", kind: "computer", name: "zingzy-mbp", label: "zingzy's MacBook Pro", mac: "macbook", default: true, present: true, shape: { cpu: 10, memMb: 16384 }, takesForks: false, agentVersions: { claude: "2.1.286", codex: "0.47.0" } };
const PROJECT: ProjectView = { id: "pr_wsp", name: "wsp", computer: "here", source: { kind: "folder", path: "/Users/zingzy/wsp" }, path: "/Users/zingzy/wsp", remote: "github.com/Zingzy/wsp", defaultBranch: "main", memoryKey: "pr_wsp", memoryDir: "/m" } as ProjectView;
const MAC: WorkspaceView = { id: "ws_m", name: "wsp", kind: "local", machineId: "local", project: { id: PROJECT.id, name: PROJECT.name, path: PROJECT.path, computer: "here" }, phase: "running", golden: "", createdAt: "2026-10-03T09:00:00Z", place: "here" } as WorkspaceView;
const workspaces = [MAC];

const ago = (m: number): number => Date.now() - m * 60_000;
const scope = { workspaceId: MAC.id, sessionId: "s_ask", turnId: "turn_ask", threadId: "thr_ask" };
const SLASH = ["compact", "context", "cost", "init", "review", "model", "permissions", "help"];

/** The question tool's input, as Claude Code sends it: a header, the sentence, the choices with a sentence each. */
const SPIDER = {
  question: "Which Spider-Man is the real one?",
  header: "Spider-Man",
  multiSelect: false,
  options: [
    { label: "Tobey Maguire", description: "Raimi trilogy. Bully Maguire, pizza time, the train scene." },
    { label: "Andrew Garfield", description: "Amazing Spider-Man. Best quips, best suit, the catch in No Way Home." },
    { label: "Tom Holland", description: "MCU. Stark tech, Ned, the kid who is in over his head." },
    { label: "Miles Morales", description: "Spider-Verse. Leap of faith, and the animation broke everyone's brain." },
  ],
};
const POWERS = {
  question: "Which powers should the mascot keep?",
  header: "Powers",
  multiSelect: true,
  options: [
    { label: "Spider-sense", description: "Catches the bug before it lands." },
    { label: "Web-shooters", description: "Gets out of the room fast." },
    { label: "Stick to a wall", description: "Slow, boring, and you do not die." },
    { label: "Super strength", description: "Lifts the whole monorepo." },
  ],
};
/** A question with nothing to pick from: the harness asked for words alone. */
const NAME = { question: "What should the mascot be called?", header: "Name", multiSelect: false, options: [] as { label: string; description: string }[] };
const LOOK = {
  question: "If the mascot were a spider, which look?",
  header: "Look",
  multiSelect: false,
  options: [
    { label: "Classic", description: "The old-school ASCII spider. Simple, works at any size." },
    { label: "Pixel", description: "Sits beside the crab and the dither without a second design language." },
    { label: "Line art", description: "One stroke, one colour, scales to a favicon." },
  ],
};
/** A question's input and the options the adapter mints for it: one per choice, each an answer, keyed q<i>:o<j>. */
const question = (questions: { options: { label: string }[] }[]) => ({
  toolName: "AskUserQuestion",
  input: JSON.stringify({ questions }),
  detail: "",
  toolUseId: "toolu_q",
  options: questions.flatMap((q, i) => q.options.map((o, j) => ({ id: `q${i}:o${j}`, label: o.label, effect: "answer" as const }))),
});
const consentOptions = [
  { id: "allow", label: "Allow", effect: "allow" as const },
  { id: "mode:acceptEdits", label: "Allow, then Accept edits", effect: "mode" as const, mode: "acceptEdits" },
  { id: "deny", label: "Deny", effect: "deny" as const },
];
const codexOptions = [
  { id: "allow", label: "Allow", effect: "allow" as const },
  { id: "deny", label: "Deny", effect: "deny" as const },
];
const EDIT_OLD = `  const recede = !active && (status === RESTING || status.id === "working");
  const card = tileCardLines({`;
const EDIT_NEW = `  // A row that waits on the person keeps the foreground ink, whatever else it is doing.
  const recede = !active && thread.asking === null && (status === RESTING || status.id === "working");
  const card = tileCardLines({`;
const PROMPTS: Record<string, { toolName: string; input: string; detail?: string; toolUseId?: string; options: { id: string; label: string; effect: "allow" | "deny" | "mode" | "answer"; mode?: string }[] }> = {
  single: question([SPIDER]),
  multi: question([POWERS]),
  form: question([SPIDER, POWERS, LOOK]),
  "text-only": question([NAME]),
  bash: {
    toolName: "Bash",
    toolUseId: "toolu_b",
    input: JSON.stringify({ command: "pnpm exec vitest run --minWorkers=1 --maxWorkers=2 apps/web/test/thread-rows.test.tsx apps/web/test/needs-you.test.tsx", description: "Run the sidebar tests" }),
    detail: "pnpm exec vitest run",
    options: consentOptions,
  },
  edit: { toolName: "Edit", toolUseId: "toolu_e", input: JSON.stringify({ file_path: "/Users/zingzy/wsp/apps/web/src/sidebar/ThreadTile.tsx", old_string: EDIT_OLD, new_string: EDIT_NEW }), detail: "ThreadTile.tsx", options: consentOptions },
  write: { toolName: "Write", toolUseId: "toolu_w", input: JSON.stringify({ file_path: "/Users/zingzy/wsp/apps/web/test/needs-you.test.tsx", content: 'import { describe, expect, it } from "vitest";\n\ndescribe("a waiting tile", () => {\n  it("keeps the foreground ink", () => {\n    expect(true).toBe(true);\n  });\n});\n' }), detail: "needs-you.test.tsx", options: consentOptions },
  mcp: { toolName: "mcp__github__create_issue", toolUseId: "toolu_m", input: JSON.stringify({ owner: "Zingzy", repo: "wsp-map", title: "Prompts where the composer stands", labels: ["design"] }), options: consentOptions },
  fetch: { toolName: "WebFetch", toolUseId: "toolu_f", input: JSON.stringify({ url: "https://code.claude.com/docs/en/agent-sdk/permissions", prompt: "List the PermissionUpdate destinations" }), options: consentOptions },
  codex: { toolName: "command_execution", toolUseId: "exec-267f4a9f", input: JSON.stringify({ command: "/bin/zsh -lc 'touch hi.txt'", cwd: "/Users/zingzy/wsp" }), detail: "Allow me to create hi.txt in the current folder?", options: codexOptions },
};
const promptFor = (name: string) => PROMPTS[name] ?? PROMPTS["single"]!;
const KIND: Record<string, string> = { other: "single", "other-multi": "multi", deny: "bash", answered: "single", collapsed: "single", tile: "single", threads: "single", "form-step2": "form" };
const kind = KIND[screen] ?? screen;
const prompt = promptFor(kind);
/** The prompt is closed: on answered the agent is back at work with the composer returned, on threads the turn is over. */
const settled = screen === "answered" || screen === "threads";
const over = screen === "threads";

const history: SessionEvent[] = [
  { type: "session.start", ...scope, agent: "claude", model: "claude-opus-5-5", cwd: "/Users/zingzy/wsp", prompt: "Build a quiz about the mascot with visual options, and ask me the questions one round at a time.", harness: { slashCommands: SLASH } },
  {
    type: "session.delta",
    ...scope,
    kind: "text",
    text: "A spider fits better than you'd think. A thread runs across your sidebar like one strand of a web, and the person running many agents is the one who gets pulled in ten directions at once and shows up for all of them.\n\nHere's the next round.",
  },
  { type: "session.permission", ...scope, askId: "ask_1", ...prompt, options: prompt.options },
  ...(settled
    ? ([
        { type: "session.permission.closed", ...scope, askId: "ask_1", outcome: "allowed", optionId: "q0:o1" },
        { type: "session.delta", ...scope, kind: "text", text: "Garfield, solid pick. He is the only one who looked like he was actually having fun up there, which is what a mascot has to do." },
        ...(over ? [{ type: "session.done", ...scope, result: { status: "completed", durationMs: 184_000, costUsd: 0.21 } }, { type: "session.end", ...scope, exitCode: 0, sawResult: true }] : []),
      ] as SessionEvent[])
    : []),
];

const askingLine = askingLineOf(prompt);
const lead: SessionView = { id: "s_ask", threadId: "thr_ask", workspaceId: MAC.id, harness: "claude", status: over ? "completed" : "running", prompt: "Quiz builder with images", harnessTitle: "Quiz builder with images", startedBy: "person", startedAt: ago(12), ...(over ? { endedAt: ago(1) } : settled ? {} : { asking: askingLine }) } as SessionView;
const others: SessionView[] = [
  { id: "s_work", threadId: "thr_work", workspaceId: MAC.id, harness: "codex", status: "running", prompt: "Review 1605: the switcher after the sidebar's three parts", harnessTitle: "Review 1605: the switcher after the sidebar's three parts", startedBy: "cli", startedAt: ago(41) } as SessionView,
  { id: "s_done", threadId: "thr_done", workspaceId: MAC.id, harness: "claude", status: "completed", prompt: "Probe: send latency on the relay", harnessTitle: "Probe: send latency", startedBy: "person", startedAt: ago(70), endedAt: ago(52) } as SessionView,
  { id: "s_read", threadId: "thr_read", workspaceId: MAC.id, harness: "claude", status: "completed", prompt: "Questions with visual options", harnessTitle: "Questions with visual options", startedBy: "person", startedAt: ago(150), endedAt: ago(140), readAt: ago(130) } as SessionView,
];
// The lead's own children, for the THREADS block under its reply: one of them stopped on a prompt of its own.
const children: SessionView[] =
  screen === "threads"
    ? [
        { id: "s_c1", threadId: "thr_c1", workspaceId: MAC.id, parentThreadId: "thr_ask", harness: "claude", status: "running", prompt: "Draw the pixel spider at 16 px", harnessTitle: "Draw the pixel spider at 16 px", startedBy: "agent", startedAt: ago(6), asking: "Write spider.svg in assets (1.2 kB)" } as SessionView,
        { id: "s_c2", threadId: "thr_c2", workspaceId: MAC.id, parentThreadId: "thr_ask", harness: "codex", status: "running", prompt: "Review the quiz copy", harnessTitle: "Review the quiz copy", startedBy: "agent", startedAt: ago(5) } as SessionView,
        { id: "s_c3", threadId: "thr_c3", workspaceId: MAC.id, parentThreadId: "thr_ask", harness: "claude", status: "completed", prompt: "Find the Whimsy crab credit", harnessTitle: "Find the Whimsy crab credit", startedBy: "agent", startedAt: ago(9), endedAt: ago(7) } as SessionView,
      ]
    : [];
const sessions = [lead, ...others, ...children];

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

// A pick closes the prompt on the wire's own event, as the runtime's would, so the composer's return is the real road.
const watching = new Set<(event: ProtocolEvent) => void>();
let open = !settled;
const closePrompt = (optionId: string): void => {
  if (!open) return;
  open = false;
  const closed: SessionEvent = { type: "session.permission.closed", ...scope, askId: "ask_1", outcome: optionId === "deny" ? "denied" : "allowed", optionId };
  history.push(closed);
  for (const fn of watching) fn(closed);
};

const api: Api = {
  listWorkspaces: async () => workspaces,
  getWorkspace: async () => MAC,
  createWorkspace: async () => MAC,
  watchStatuses: async () => workspaces.map(w => statusOf(w, { kind: "local", size: { cpu: 10, memMb: 16384 }, rateUsdPerHour: 0, facts: { os: "macOS 26.1", uptimeMs: 3 * 86_400_000, folder: "/Users/zingzy/wsp" } })),
  forget: async () => {},
  nap: async () => MAC,
  wake: async () => MAC,
  capabilities: async () => caps(),
  startSession: async () => ({ id: "s_ask", workspaceId: MAC.id, harness: "claude", status: "running" }),
  portReach: async (_id, port) => ({ url: `http://127.0.0.1:${port}`, expiresAt: Date.now() + 3_600_000 }),
  daemon: noDaemonApi,
  sessionHistory: async () => history,
  answerPermission: async (_sessionId, _askId, optionId) => {
    closePrompt(optionId);
    return "answered";
  },
  setSessionAccess: async () => "set",
  listSnapshots: async () => ({ name: "default", head: null, versions: [] }),
  snapshotStorage: async () => null,
  rollbackSnapshot: async () => ({ lineage: { name: "default", head: null, versions: [] }, existingWorkspaces: "untouched" }),
  listSessions: async () => sessions,
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
useStore.getState().select(MAC.id, "thr_ask");
useRightPanelStore.setState({ byWorkspaceId: {} });
useRightPanelStore.getState().close(MAC.id);

/** The keys the query names, as the person would press them, sent to the dock once it is on the page. */
const KEYS: Record<string, string> = { down: "ArrowDown", up: "ArrowUp", enter: "Enter", space: " ", esc: "Escape" };
function drive(): void {
  const dock = document.querySelector<HTMLElement>("[data-prompt-dock] [data-prompt-root]");
  if (dock === null) {
    setTimeout(drive, 50);
    return;
  }
  const press = (key: string): void => {
    const el = document.activeElement instanceof HTMLElement && dock.contains(document.activeElement) ? document.activeElement : dock;
    el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  };
  // One key per tick, as a hand presses them: a burst inside one tick lands on state React has not yet drawn.
  const keys = (params.get("keys") ?? "").split(",").filter(Boolean);
  const next = (): void => {
    const name = keys.shift();
    if (name === undefined) {
      type();
      return;
    }
    press(KEYS[name] ?? name);
    setTimeout(next, 60);
  };
  next();
}
function type(): void {
  const typed = params.get("typed");
  if (typed !== null) {
    const field = document.querySelector<HTMLInputElement>("[data-prompt-field]");
    if (field !== null) {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      set.call(field, typed);
      field.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }
}
if (!settled) setTimeout(drive, 150);

createRoot(document.getElementById("root")!).render(
  <TooltipProvider>
    <AppShell>
      <div className="flex min-h-0 flex-1 flex-col" data-terminal-beside>
        <WorkspaceThread workspaceId={MAC.id} threadId="thr_ask" dock />
      </div>
    </AppShell>
  </TooltipProvider>,
);
