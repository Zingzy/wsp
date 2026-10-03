// SPDX-License-Identifier: AGPL-3.0-only
// Served by Vite to a real browser: Add a computer, the sidebar's Setting up
// section, Settings Computers, a computer's page and Settings Recipes over the
// real app shell and a fake host, one screen per ?screen=, in either theme
// (?theme=light). ?screen=closing is the moment after the dialog is put away
// mid-setup, and ?screen=sidebar the Setting up section. Every screen is drawn by the product's own components from
// the host's shapes, so a screenshot of one is what the app draws for that
// record. ?scroll=bottom scrolls the dialog's panel to its end.
import { createRoot } from "react-dom/client";
import { DAEMON_VERSION, DEFAULT_PREFERENCES, PLACE_HOST_KEY_KIND, RecipeFile, hostKeyUnconfirmedRefusal, type PendingComputer, type PlaceAddJob, type PlaceApplied, type PlaceSetup, type PlaceView, type ProjectView, type RecipeOptions, type RecipeView, type SessionView, type WorkspaceView } from "@wsp/protocol";
import { TooltipProvider } from "../../src/components/ui/tooltip";
import { addNotice } from "../../src/notices/store";
import { useStore } from "../../src/protocol/store";
import { useAddFlow, type AddStep } from "../../src/settings/add/addFlow";
import { useAdds } from "../../src/settings/adds";
import { SettingsPage } from "../../src/settings/SettingsPage";
import { useSettingsStore } from "../../src/settings/settingsStore";
import { applyTheme } from "../../src/settings/theme";
import { AppShell } from "../../src/shell/AppShell";
import { settingsApi } from "../settings-harness";
import "../../src/index.css";
import "../../src/themes/index";

const params = new URLSearchParams(window.location.search);
const theme: "light" | "dark" = params.get("theme") === "light" ? "light" : "dark";
const picks = { lightTheme: params.get("lightTheme") ?? DEFAULT_PREFERENCES.lightTheme, darkTheme: params.get("darkTheme") ?? DEFAULT_PREFERENCES.darkTheme };
applyTheme({ theme, ...picks }, theme === "dark");
const screen = params.get("screen") ?? "where";

const MB = 1024 * 1024;
const AT = "2026-10-03T10:00:00.000Z";
const HERE: PlaceView = { id: "here", kind: "computer", name: "zingzy-mbp", label: "zingzy's MacBook Pro", mac: "macbook", default: true, present: true, shape: { cpu: 10, memMb: 16384 }, takesForks: false, agentVersions: { claude: "2.1.286", codex: "0.47.0", opencode: "1.18.18" } };
const STUDIO: PlaceView = { id: "p_studio", kind: "computer", name: "studio", default: false, present: true, os: "Ubuntu 24.04", shape: { cpu: 8, memMb: 32768 }, diskFreeBytes: 61_000_000_000, takesForks: true, daemonVersion: DAEMON_VERSION };
const SPOO: PlaceView = { id: "p_spoo", kind: "computer", name: "spoo", default: false, present: true, os: "Ubuntu 24.04", shape: { cpu: 2, memMb: 7700 }, takesForks: true, behind: { word: "runs daemon 57, this wsp deploys 61", fix: "wsp add spoo --update", act: "update" }, daemonVersion: 1 };
const MONGO: PlaceView = { id: "p_mongo", kind: "computer", name: "spoo-mongo", default: false, present: true, os: "Debian 12", shape: { cpu: 2, memMb: 4096 }, takesForks: true };
const BOAT: PlaceView = { id: "p_boat", kind: "computer", name: "Boat", default: false, present: false, lastSeenAt: "2026-10-01T18:02:00Z", shape: { cpu: 4, memMb: 8192 }, takesForks: true };
const DISHA: PlaceView = { id: "p_disha", kind: "computer", name: "dishapc", default: false, present: true, os: "Ubuntu 22.04", shape: { cpu: 4, memMb: 16384 }, takesForks: true };

const OPTIONS: RecipeOptions = {
  agents: [
    { id: "claude", name: "Claude Code", signins: ["vault", "machine"] },
    { id: "codex", name: "Codex", signins: ["machine"] },
    { id: "opencode", name: "OpenCode", signins: ["machine"] },
  ],
  mcp: [
    { name: "wsp", agents: ["claude", "codex"] },
    { name: "context7", agents: ["claude", "codex"] },
    { name: "gsc", agents: ["claude"] },
    { name: "linear", agents: ["claude"] },
    { name: "playwright", agents: ["claude"] },
    { name: "github", agents: ["codex"] },
    { name: "cloudflare_observability", agents: ["claude"] },
    { name: "firecrawl", agents: ["claude"] },
    { name: "excalidraw", agents: ["claude"] },
  ],
  clis: [
    { name: "gh", via: "apt", version: "2.86.0" },
    { name: "ripgrep", via: "apt", version: "15.1.0" },
    { name: "jq", via: "apt", version: "1.8.1" },
    { name: "fd", via: "apt", version: "10.3.0" },
    { name: "uv", via: "installer", version: "0.9.2" },
    { name: "pnpm", via: "npm", version: "11.9.0" },
    { name: "bun", via: "npm", version: "1.3.1" },
    { name: "go", via: "apt", version: "1.25.1" },
    { name: "cargo-nextest", via: "cargo", version: "0.9.98", needs: ["build-essential"] },
    { name: "yq", via: "apt", version: "4.47.1" },
  ],
  skills: ["unslop", "diagnosing-bugs", "blast-radius", "typescript-best-practices", "grilling", "wizard", "wsp", "wsp-review", "agent-pipeline", "zingzy-design-taste", "writing-plans", "prototype", "research", "why"].map(name => ({ name, from: name === "wsp" ? "~/.agents/skills" : "~/.claude/skills", linked: false })),
  plugins: ["frontend-design@claude-plugins-official", "code-review@claude-plugins-official", "skill-creator@claude-plugins-official", "ralph-loop@claude-plugins-official", "brag@hyperframes", "dataviz@anthropic-labs", "turnstile-spin@spoo-me", "excalidraw-skill@excalidraw", "raycast-ui-skills@raycast"].map(name => ({ name })),
  configs: [
    { id: "git", label: "git settings and identity" },
    { id: "shell", label: "zsh or fish, the prompt, tmux and the rest of the shell's look" },
    { id: "github", label: "the GitHub sign-in" },
  ],
};

const project = (id: string, name: string, path: string, remote: string, computer = "here"): ProjectView => ({ id, name, computer, source: { kind: "folder", path }, path, remote, defaultBranch: "main", memoryKey: id, memoryDir: "/m" }) as ProjectView;
const PROJECTS: ProjectView[] = [project("pr_wsp", "wsp", "~/wsp", "github.com/Zingzy/wsp"), project("pr_spoo", "spoo", "~/spoo", "github.com/spoo-me/url-shortener"), project("pr_laya", "laya", "~/laya", ""), project("pr_kart", "kartsmash", "~/kartsmash", "")];
const LOOKS = { pr_wsp: { icon: "terminal" as const, hue: "amber" as const }, pr_spoo: { icon: "globe" as const, hue: "blue" as const }, pr_kart: { icon: "gamepad" as const, hue: "pink" as const } };

/** The picks the frozen screens hold: everything but OpenCode, two servers, yq, two plugins, and one project. */
const PICKS: RecipeFile = RecipeFile.parse({
  name: "studio",
  agents: { claude: { signin: "vault" }, codex: { signin: "machine" } },
  mcp: Object.fromEntries(OPTIONS.mcp.slice(0, 7).map(s => [s.name, { agents: s.agents }])),
  clis: Object.fromEntries(OPTIONS.clis.slice(0, 9).map(c => [c.name, { via: c.via, ...(c.needs === undefined ? {} : { needs: c.needs }) }])),
  skills: Object.fromEntries(OPTIONS.skills.map(s => [s.name, { from: s.from }])),
  plugins: Object.fromEntries(OPTIONS.plugins.slice(0, 7).map(p => [p.name, {}])),
  folders: { wsp: { from: "~/wsp", name: "wsp", icon: "terminal", hue: "amber", keep: [] } },
  configs: { git: {}, shell: {}, github: { signin: "vault" } },
});

const RECIPES: RecipeView[] = [
  { name: "Builders", slug: "builders", summary: "2 agents, 7 MCP servers, 9 CLIs, 14 skills, 7 plugins, 1 folder, 3 configs", machines: ["spoo", "studio"], file: { ...PICKS, name: "Builders" } },
  { name: "Minimal", slug: "minimal", summary: "1 agent, 1 CLI, 3 skills, 1 config", machines: [], file: RecipeFile.parse({ name: "Minimal", agents: { claude: { signin: "vault" } }, clis: { gh: { via: "apt" } }, skills: { unslop: { from: "~/.claude/skills" }, why: { from: "~/.claude/skills" }, grilling: { from: "~/.claude/skills" } }, configs: { git: {} } }) },
];

const s = (n: number): number => n * 1000;
const row = (step: PlaceApplied["rows"][number]["step"], id: string, label: string, outcome: "installed" | "present" | "failed" = "installed", note?: string): PlaceApplied["rows"][number] => ({ id, label, outcome, step, ...(note === undefined ? {} : { note }) });
const LANDED: PlaceApplied["rows"] = [
  row("floor", "floor/git", "git"),
  row("floor", "floor/curl", "curl"),
  row("floor", "floor/node", "node 22"),
  row("agents", "claude", "Claude Code 2.1.286"),
  row("agents", "codex", "Codex 0.47.0"),
  row("signins", "signins/claude", "Claude Code", "present", "Key copied."),
];
const setupOf = (state: PlaceSetup["state"], steps: PlaceSetup["steps"], waiting: PlaceSetup["waiting"] = [], said?: string): PlaceSetup => ({ state, addId: "a_set", startedAt: AT, ...(state === "running" ? {} : { finishedAt: "2026-10-03T10:06:12.000Z" }), steps, waiting, ...(said === undefined ? {} : { said }) });
const CODEX_WAIT = { row: "signins/codex", label: "Codex", url: "https://auth.openai.com/device", code: "4F2K-9QJM", expiresAt: "2026-10-03T10:10:00.000Z", state: "waiting" as const };
const DONE_STEPS: PlaceSetup["steps"] = [
  { step: "floor", state: "done", ms: s(72) },
  { step: "agents", state: "done", ms: s(53) },
  { step: "signins", state: "done", ms: 600 },
  { step: "mcp", state: "done", ms: s(18) },
  { step: "clis", state: "done", ms: s(64) },
  { step: "skills", state: "done", ms: s(6) },
  { step: "plugins", state: "done", ms: s(22) },
  { step: "github", state: "done", ms: 400 },
  { step: "folders", state: "done", ms: s(31) },
  { step: "configs", state: "done", ms: s(3) },
];
const ALL_LANDED: PlaceApplied["rows"] = [
  ...LANDED,
  row("signins", "signins/codex", "Codex", "installed", "Signed in on studio."),
  ...OPTIONS.mcp.slice(0, 7).map(m => row("mcp", `mcp/${m.name}`, m.name)),
  ...OPTIONS.clis.slice(0, 9).map(c => row("clis", `clis/${c.name}`, c.name)),
  row("skills", "skills/all", "77 skills"),
  row("plugins", "plugins/all", "8 plugins"),
  row("github", "github", "GitHub", "present"),
  row("folders", "folders/portfolio", "portfolio"),
  row("configs", "configs/git", "git"),
  row("configs", "configs/shell", "shell"),
];
const SETUPS: Record<string, { setup: PlaceSetup; applied: PlaceApplied }> = {
  running: {
    setup: setupOf("running", [{ step: "floor", state: "done", ms: s(72) }, { step: "agents", state: "done", ms: s(53) }, { step: "signins", state: "done" }, { step: "mcp", state: "running" }, { step: "clis", state: "running" }, { step: "skills", state: "running" }, { step: "plugins", state: "running" }, { step: "github", state: "done", ms: 400 }, { step: "folders", state: "running" }, { step: "configs", state: "done", ms: s(3) }], [CODEX_WAIT]),
    applied: { hash: "h", at: AT, rows: [...LANDED, row("github", "github", "GitHub", "present"), row("configs", "configs/git", "git"), row("configs", "configs/shell", "shell")] },
  },
  "running-failed": {
    setup: setupOf("done", DONE_STEPS.map(l => (l.step === "skills" || l.step === "folders" ? { ...l, state: "failed" as const, note: "1 of 2 failed" } : l))),
    applied: { hash: "h", at: AT, rows: [...ALL_LANDED, row("skills", "skills/zingzy-design-taste", "zingzy-design-taste", "failed", "A link inside the folder points at a folder, which never travels."), row("folders", "folders/wsp", "wsp", "failed", "studio could not clone github.com/Zingzy/wsp: permission denied.")] },
  },
  "running-blocked": {
    setup: setupOf("failed", [{ step: "floor", state: "failed" }], [], "apt-get install exited 100 on studio: E: Unable to locate package nodejs."),
    applied: { hash: "h", at: AT, rows: [row("floor", "floor/stopped", "the base tools", "failed")] },
  },
  "running-done": { setup: setupOf("done", DONE_STEPS), applied: { hash: "h", at: AT, rows: ALL_LANDED } },
};

const ADD_STEPS: Record<string, PlaceAddJob> = {
  checks: { addId: "a_add", address: "studio", startedAt: AT, state: "running", steps: [{ step: "connect", state: "done", note: "Ubuntu 24.04" }, { step: "check", state: "done", note: "root, systemd, cgroup v2, 61 GB free" }, { step: "reach", state: "done", note: "studio dials back over ssh" }, { step: "wsp", state: "running", note: "x86_64" }] },
  "checks-refused": { addId: "a_add", address: "jumpbox", startedAt: AT, state: "failed", steps: [{ step: "connect", state: "done", note: "Ubuntu 22.04" }, { step: "check", state: "running" }], said: "jumpbox logs in as a user that is not root, and root on the box is required: wsp runs its daemon there as a system service.", fix: "Add it as root@jump.zingzy.dev, or put User root under Host jumpbox in your ssh config." },
  hostkey: { addId: "a_add", address: "studio", startedAt: AT, state: "failed", steps: [{ step: "connect", state: "running" }], said: hostKeyUnconfirmedRefusal("studio", "ED25519 SHA256:tK3mX9Qf2bWq8vRz0YhN4cL7pJd1sE6gA5uF8oH2kIw"), kind: PLACE_HOST_KEY_KIND, hostKey: "ED25519 SHA256:tK3mX9Qf2bWq8vRz0YhN4cL7pJd1sE6gA5uF8oH2kIw" },
};

const PICK_STEPS: AddStep[] = ["startfrom", "agents", "mcp", "clis", "skills", "plugins", "github", "projects", "other", "summary"];
const RUNNING_SCREENS = ["running", "running-failed", "running-blocked", "running-done", "ready"];
const SIDEBAR_SCREENS = ["sidebar"];
const SETTINGS_PAGES: Record<string, () => void> = {
  computers: () => useSettingsStore.getState().go({ kind: "group", group: "computers" }),
  computer: () => useSettingsStore.getState().go({ kind: "computer", id: STUDIO.id }),
  recipes: () => useSettingsStore.getState().go({ kind: "group", group: "recipes" }),
  recipe: () => useSettingsStore.getState().go({ kind: "group", group: "recipes" }),
  "recipes-empty": () => useSettingsStore.getState().go({ kind: "group", group: "recipes" }),
};

const studioAt = (key: string): PlaceView => ({ ...STUDIO, ...SETUPS[key]!, picks: PICKS, recipe: "builders" });
const studio = RUNNING_SCREENS.includes(screen) ? studioAt(screen === "ready" ? "running-done" : screen) : screen === "computer" ? studioAt("running-failed") : STUDIO;
const sidebarPlaces = [
  { ...STUDIO, setup: setupOf("running", [{ step: "floor", state: "done" }, { step: "agents", state: "done" }, { step: "signins", state: "done" }, { step: "mcp", state: "done" }, { step: "clis", state: "done" }, { step: "skills", state: "running" }]) },
  { ...MONGO, setup: setupOf("done", [{ step: "floor", state: "done" }, { step: "agents", state: "done" }, { step: "signins", state: "done" }, { step: "mcp", state: "done" }], [CODEX_WAIT]) },
  { ...DISHA, setup: setupOf("failed", [{ step: "floor", state: "failed" }], [], "base packages did not install") },
];
const listPlaces = [HERE, SPOO, { ...STUDIO, setup: sidebarPlaces[0]!.setup }, sidebarPlaces[1]!, sidebarPlaces[2]!, BOAT];
const places = SIDEBAR_SCREENS.includes(screen) ? [HERE, SPOO, ...sidebarPlaces] : screen === "computers" || screen === "closing" ? listPlaces : screen === "computer" ? listPlaces.map(p => (p.id === STUDIO.id ? studio : p)) : [HERE, SPOO, studio];
const pending: PendingComputer[] = screen === "computers" ? [{ id: "a_jump", address: "root@jump.zingzy.dev", name: "jumpbox", step: "choosing", placeId: "p_jump", startedAt: AT, choices: PICKS }] : [];
if (screen === "computers") localStorage.setItem("wsp:add-reached", JSON.stringify({ a_jump: "skills" }));

const { api } = settingsApi({
  sshHosts: async () => [
    { alias: "studio", hostName: "65.21.4.12", user: "root", from: "config" },
    { alias: "oldlaptop", hostName: "oldlaptop.local", user: "zingzy", from: "config" },
    { alias: "spoo-mongo", hostName: "95.216.8.77", user: "root", from: "config" },
    { alias: "jumpbox", hostName: "jump.zingzy.dev", user: "ubuntu", from: "config" },
    { alias: "dishapc", hostName: "192.168.1.24", user: "disha", from: "config" },
  ],
  recipesOptions: async () => OPTIONS,
  recipesList: async () => (screen === "recipes-empty" ? [] : RECIPES),
  placesChoose: async () => pending[0]!,
  placesList: async () => ({ places, adds: [], pending }),
  initGet: async () => null,
  addComputerOverSsh: async () => STUDIO,
  placesUpdate: async () => ({ name: "spoo" }),
} as never);

const workspace = (id: string, name: string, projectName: string, place: string): WorkspaceView => ({ id, name, machineId: `m_${id}`, project: { id: `pr_${projectName}`, name: projectName, path: `/Users/zingzy/${projectName}`, computer: place }, phase: "running", golden: "snap_g", createdAt: AT, place }) as WorkspaceView;
const workspaces: WorkspaceView[] = [workspace("ws_1", "relay-helper", "wsp", "p_spoo"), workspace("ws_2", "release-notes", "wsp", "here"), workspace("ws_3", "ban-flow", "spoo", "here")];
const ago = (m: number): number => Date.now() - m * 60_000;
const sessions: Record<string, SessionView[]> = {
  ws_1: [{ id: "s1", threadId: "s1", workspaceId: "ws_1", harness: "claude", status: "running", prompt: "Move the relay to one callback helper.", startedBy: "person", startedAt: ago(22) }],
  ws_2: [{ id: "s2", threadId: "s2", workspaceId: "ws_2", harness: "codex", status: "completed", prompt: "Release notes for 0.9.", startedBy: "person", startedAt: ago(70), endedAt: ago(61) }],
  ws_3: [{ id: "s3", threadId: "s3", workspaceId: "ws_3", harness: "claude", status: "completed", prompt: "Ban flow: take a link down from the report.", startedBy: "cli", startedAt: ago(140), endedAt: ago(131) }],
};
const projects = screen === "projects-taken" ? [...PROJECTS, project("pr_box", "wsp", "/root/wsp", "", STUDIO.id)] : PROJECTS;
const preferences = { ...DEFAULT_PREFERENCES, theme, ...picks, labs: false, projectLook: LOOKS, recipeLook: { builders: { icon: "rocket" as const }, minimal: { icon: "zap" as const } } };
const settingsOpen = !SIDEBAR_SCREENS.includes(screen);
useStore.setState({ api, conn: "live", ready: true, projectsRead: true, placesRead: true, places, pending, projects, preferences, settingsOpen, workspaces, sessions });
(SETTINGS_PAGES[screen] ?? SETTINGS_PAGES["computers"]!)();

const job = ADD_STEPS[screen];
if (job !== undefined) useAdds.setState({ jobs: { [job.addId]: job } });
if (screen === "where") useAddFlow.setState({ open: true, step: "where", address: "studio" });
else if (job !== undefined) useAddFlow.setState({ open: true, step: "checks", address: job.address, addId: job.addId });
else if (PICK_STEPS.includes(screen as AddStep) || screen === "projects-taken") {
  const step = (screen === "projects-taken" ? "projects" : screen) as AddStep;
  useAddFlow.setState({ open: true, step, address: "studio", placeId: STUDIO.id, pendingId: "a_add", picks: PICKS, from: "here", options: OPTIONS, saveAs: { on: true, name: "Builders", icon: "rocket" } });
} else if (RUNNING_SCREENS.includes(screen)) useAddFlow.setState({ open: true, step: screen === "ready" ? "ready" : "running", placeId: STUDIO.id, address: "studio" });

// The desktop shell's folder picker, which is what draws Add a folder on Import projects.
if (screen.startsWith("projects")) window.wsp = { pickFolder: async () => undefined };

if (screen === "closing") setTimeout(() => addNotice({ kind: "note", text: "Setup keeps going. wsp pings you when it needs you.", where: "studio", action: { word: "Open", run: () => {} } }), 50);

if (params.get("scroll") === "bottom") {
  const scroll = (): void => {
    const panel = document.querySelector("[data-slot=dialog-panel]");
    let box: HTMLElement | null = panel instanceof HTMLElement ? panel.parentElement : null;
    while (box !== null && box.scrollHeight <= box.clientHeight) box = box.parentElement;
    if (box === null) setTimeout(scroll, 50);
    else box.scrollTop = box.scrollHeight;
  };
  setTimeout(scroll, 300);
}

createRoot(document.getElementById("root")!).render(
  <TooltipProvider>
    <AppShell>{settingsOpen ? <SettingsPage /> : <div />}</AppShell>
  </TooltipProvider>,
);
