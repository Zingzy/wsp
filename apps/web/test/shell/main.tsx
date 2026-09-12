// SPDX-License-Identifier: AGPL-3.0-only
// Served by Vite to a real browser: the app shell over a fake api with three
// workspaces (running, paused, gone) and four threads, in either theme
// (?theme=light), with a status toast in the footer (?toast=...) and with the
// runtime replacing the first machine's helper (?helper=1) or the first
// machine's link dropped after a near-full memory sample (?oom=1) or the
// napping machine's last vault refused for its size (?vault=1) or every
// probe failing before it left this computer (?offline=1), so a test
// can measure the chrome's geometry, which jsdom cannot lay out. With
// ?ws=<id> the centre holds that workspace's thread and composer, so the
// refusal line above the box can be measured for the running, paused and gone
// workspaces and the model picker's agent marks for their size and colour;
// ?ws=ws_a&linger=1 replays a turn that replied but whose process has not
// exited; ?ws=ws_a&chat=1 replays one whose reply is markdown of every kind the
// chat draws, so the message body and its code blocks can be measured, and
// whose init announced the CLI's slash commands, its own screens among them;
// ?local=1&ws=ws_m&perm=1 replays a turn on this computer with one permission
// prompt answered and one still open, so the relayed prompt row can be laid
// out and photographed in both states; ?shell=desktop puts a desktop bridge on the page so the workspace
// switch chord reaches it; ?mac=1 marks the html the way the macOS preload
// does; ?panel=terminal opens the right panel with a Browser tab and a
// terminal over a fake daemon wire, the host answering a translucent Ghostty
// config, so the pane's material can be measured with each tab active;
// ?sidebar=<px> opens the sidebar at that remembered width so the rows can
// be measured at several; ?spaces=1 opens it in the Spaces body, one
// workspace under its header with an icon per workspace at the bottom;
// ?look=1 gives the first two workspaces a theme and the first a glyph of its own, ?ssh=1 adds a machine over ssh,
// ?many=<n> adds n more running forks so the space bar overflows;
// ?archived=1 gives the first workspace two threads quiet for days, so the
// Archived group nested in its idle shelf can be measured shut and opened;
// ?images=<n> puts n images in the composer so the thumbnail row above the
// text can be measured; ?settings=1 puts the settings page in the centre,
// with the theme rule mounted so a pick on it moves the page's theme as the
// app's would; ?size=file is the record saying the terminal's text size comes
// from the Ghostty file; ?local=1 puts this computer in the list beside the
// cloud machines, so a mixed list of both kinds can be measured; ?projects=1
// gives the first workspace two projects, its threads folders inside them and
// the record a last project for it, so the composer's project pick, the folder
// line under the box and the thread rows' project word can be measured, and
// this computer the same two and a third with a long name; ?efforts=1 gives
// the claude row its effort and context lists so the composer's row carries
// every picker; ?panel=preview opens the right panel inline with nothing in
// it, the narrowest the centre column gets at a width; ?panel=browser&at=<address>
// opens it on a browser tab framing that address, so the bar can be measured
// with a path and a query in it; ?drop=1 holds the page
// mid-drag of a folder from the desktop, with the desktop bridge that reads a
// dropped path, so every workspace row's drop tile can be measured; ?import=1
// opens the import dialog on ws_a already reading a folder, as a drop on its
// tile leaves it; ?panel=machine opens the right panel on the Machine tab of
// the workspace ?ws names, so its PROJECTS section can be measured with two
// projects (ws_a under ?projects=1) and with none;
// ?init=building puts the init job mid-build so the cloud row's progress line
// can be measured; ?version=behind holds a shell older than the host that
// served the page, so the one line the app says about it can be measured.
import { createRoot } from "react-dom/client";
import { DAEMON_UPDATING, DEFAULT_PREFERENCES, DEFAULT_THEME, DESKTOP_MAC_CLASS, GOLDEN_STAGE_WORDS, SIGN_IN_OPEN_STATE, keptAccess, THEME_PRESETS, THIS_COMPUTER, vaultOverCapLine, type HarnessCatalog, type SessionEvent, type SessionView, type TerminalConfig, type WorkspaceView } from "@wsp/protocol";
import { statusOf } from "../workspace-status";
import { TooltipProvider } from "../../src/components/ui/tooltip";
import type { Api } from "../../src/protocol/client";
import { getLive } from "../../src/machine/live";
import { useStore } from "../../src/protocol/store";
import { useRightPanelStore } from "../../src/rightPanelStore";
import { useBrowserTabs } from "../../src/browser/tabs";
import { parseAddress } from "../../src/browser/url";
import { SettingsPage } from "../../src/settings/SettingsPage";
import { useThemeEffect } from "../../src/settings/theme";
import { AppShell } from "../../src/shell/AppShell";
import { useShellVersionEffect } from "../../src/shell/shellVersion";
import { openPanelTerminal } from "../../src/shell/shellCommands";
import { WorkspaceThread } from "../../src/shell/WorkspaceThread";
import { useComposerImagesStore } from "../../src/components/chat/composerImages";
import { requestProjectTrip } from "../../src/shell/shellRequests";
import { GhosttyTerminalSurface } from "../../src/terminal/ghostty/surface";
import { provideTerminals, WorkspaceTerminals, type TerminalWire } from "../../src/terminal/link";
import "../../src/index.css";
import { caps } from "../caps.js";
import { noDaemonApi } from "../fake-daemon-api.js";

const params = new URLSearchParams(window.location.search);
const theme = params.get("theme") === "light" ? "light" : "dark";
document.documentElement.classList.toggle("dark", theme === "dark");
document.documentElement.classList.toggle(DESKTOP_MAC_CLASS, params.get("mac") === "1");
// The bridge alone tells the page which shell holds it; with ?shell=desktop the chords a browser tab keeps for its
// own tabs reach the page, which is what the switcher's chord needs. It carries the two picture calls, which is what
// the switcher's well reads, and neither answers with a picture, so the wells draw empty.
if (params.get("shell") === "desktop") {
  window.wsp = { capturePreview: async () => undefined, workspacePreview: async () => undefined };
}
// ?drop=1 and ?import=1 are the desktop's roads: the bridge that reads a dropped folder's path is what lets the rows
// become tiles at all, and the picker is what the dialog draws for the folder there.
if (params.get("drop") === "1" || params.get("import") === "1") window.wsp = { ...window.wsp, droppedPath: file => `/Users/dev/${file.name}`, pickFolder: async () => undefined };

const view = (id: string, name: string, phase: WorkspaceView["phase"] = "running"): WorkspaceView => ({
  id,
  name,
  machineId: `m_${id}`,
  phase,
  golden: "snap_g",
  createdAt: "2026-09-05T11:00:00Z",
});
const cloud = [view("ws_a", "api"), view("ws_b", "web", "napping"), { ...view("ws_c", "old", "gone"), gone: "machine m_ws_c is gone at the provider: Not found" }];
// ?vault=1: the napping workspace's last nap could not store a vault, so its row says the machine has no backup
// since the day of the one that stands and the Machine tab names the cap the export was cut against.
if (params.get("vault") === "1") Object.assign(cloud[1]!, { vaultedAt: "2026-09-08T07:10:04.444Z", vaultRefused: vaultOverCapLine(677_178_573, 209_715_200) });
// ?projects=1: two projects on the first workspace, as two imports leave them, with the sizes the imports measured.
const PROJECTS = [
  { name: "spoo", dest: "/root/spoo", importedAt: "2026-09-04T10:00:00Z", size: 48_200_000 },
  { name: "wsp", dest: "/root/wsp", importedAt: "2026-09-05T09:30:00Z", size: 133_000_000 },
];
const projects = params.get("projects") === "1";
if (projects) Object.assign(cloud[0]!, { projects: PROJECTS });
// ?local=1 adds this computer to the list, so a mixed list can be measured: two cloud rows and one local beside them.
// With ?projects=1 it holds the same two projects and a third with a name longer than the composer's picker row is
// wide in a narrow window, so the composer on a kept machine draws every picker it has and the one label a person
// names, which no width bounds.
const LONG_PROJECT = { name: "customer-billing-service-platform", dest: "/Users/zingzy/customer-billing-service-platform", importedAt: "2026-09-06T08:00:00Z", size: 912_000_000 };
const MAC: WorkspaceView = { ...view("ws_m", "zingzy-mac"), kind: "local", machineId: "local", golden: "", ...(projects ? { projects: [...PROJECTS, LONG_PROJECT] } : {}) };
const workspaces = params.get("local") === "1" ? [...cloud, MAC] : cloud;
// ?look=1 gives the first two workspaces a theme and the first a glyph of its own, and leaves the rest with neither, so
// one page holds two themed spaces, a plain one and, with ?local=1 and ?ssh=1, every kind's own glyph on the bar. The
// first theme is a preset at the default grain and opacity; the second has three colours, grain and its own side pinned.
if (params.get("look") === "1") {
  Object.assign(workspaces[0]!, { theme: { ...DEFAULT_THEME, dots: [...THEME_PRESETS[1]!.dots], harmony: THEME_PRESETS[1]!.harmony }, glyph: "flask" });
  Object.assign(workspaces[1]!, { theme: { ...DEFAULT_THEME, dots: [...THEME_PRESETS[2]!.dots], harmony: THEME_PRESETS[2]!.harmony, grain: 0.5, opacity: 0.7, mode: "dark" } });
}
// ?ssh=1 adds a machine over ssh, the third kind, so the space bar can be shot with every kind's own glyph.
if (params.get("ssh") === "1") workspaces.push({ ...view("ws_s", "build-box"), kind: "ssh", machineId: "ssh:build-box", golden: "" });
// ?many=<n> adds n more running forks, so the space bar can be measured once its icons outgrow the footer.
for (let i = 0; i < Number(params.get("many") ?? 0); i++) workspaces.push(view(`ws_x${i}`, `extra-${i}`));
// The ticket's rows: long titles with the agent and both opener words. ws_a mixes a working thread with an idle
// one; ws_b has only idle ones, the shape that used to draw no Idle header at all, one of them on Codex so both a
// coloured and a monochrome agent mark sit in the shots.
// Two of the first workspace's threads quiet for days, added only with ?archived=1 so every other case keeps the
// four rows it measures: past the protocol's threshold they fold into the Archived group under that workspace's
// idle shelf, which is what the group's own case reads.
const archived: SessionView[] = params.get("archived") !== "1"
  ? []
  : [
      { id: "s5", workspaceId: "ws_a", harness: "claude", status: "completed", prompt: "Rotate the daemon token and restart the host.", startedBy: "person", startedAt: Date.now() - 3 * 24 * 60 * 60_000, endedAt: Date.now() - 2 * 24 * 60 * 60_000 },
      { id: "s6", workspaceId: "ws_a", harness: "codex", status: "interrupted", prompt: "Drop the preview shim from the packing list.", startedBy: "cli", startedAt: Date.now() - 9 * 24 * 60 * 60_000, endedAt: Date.now() - 8 * 24 * 60 * 60_000 },
    ];
const sessions: SessionView[] = [
  // With ?projects=1 the first thread works in spoo and the second deep inside wsp, so both rows carry a project word.
  { id: "s1", workspaceId: "ws_a", harness: "claude", status: "running", prompt: "Now reply with exactly the word pong.", startedBy: "person", startedAt: Date.now() - 48 * 60_000, ...(projects ? { cwd: "/root/spoo" } : {}) },
  { id: "s2", workspaceId: "ws_a", harness: "claude", status: "completed", prompt: "Reply with exactly the word hi.", startedBy: "cli", startedAt: Date.now() - 30 * 60_000, endedAt: Date.now() - 24 * 60_000, ...(projects ? { cwd: "/root/wsp/packages/host" } : {}) },
  { id: "s3", workspaceId: "ws_b", harness: "codex", status: "completed", prompt: "Bump the lockfile and run the gate.", startedBy: "cli", startedAt: Date.now() - 90 * 60_000, endedAt: Date.now() - 80 * 60_000 },
  { id: "s4", workspaceId: "ws_b", harness: "claude", status: "interrupted", prompt: "Drop the old preview shim.", startedBy: "person", startedAt: Date.now() - 120 * 60_000, endedAt: Date.now() - 110 * 60_000 },
  ...archived,
];

// Two agents the composer can start a thread on, so its picker draws a coloured mark and a monochrome one. Codex
// carries the effort lists its app-server reports, each model with the effort that model runs at, so the effort
// picker draws its default against a pick rather than against the binary.
// The access modes are the CLI's own list, and keptAccess turns it into the kept-machine list the runtime hands out
// for a workspace on this computer: the mode the harness asks in marked, and bypass named after the machine it would
// touch. One list serves every workspace here, which is what a fixture can do; the runtime decides per machine.
const ACCESS_MODES = [
  { value: "default", label: "Default", description: "Asks in the chat about each action that needs permission" },
  { value: "acceptEdits", label: "Accept edits", description: "Edits files without asking; asks about commands that need permission" },
  { value: "plan", label: "Plan", description: "Reads and plans only; changes nothing" },
  { value: "bypassPermissions", label: "Bypass", description: "Runs every action without asking", isDefault: true },
];
// ?efforts=1 gives the claude row the effort levels and context windows the runtime's table lists for it, so the
// composer's row carries the effort picker beside the others and is as wide as it gets.
const efforts = params.get("efforts") === "1";
const CLAUDE_EFFORTS = ["Low", "Medium", "High", "Extra high", "Max"].map(label => ({ value: label.toLowerCase().replace(" ", ""), label, ...(label === "High" ? { isDefault: true } : {}) }));
const CLAUDE_CONTEXT_WINDOWS = [{ value: "200k", label: "200k" }, { value: "1m", label: "1M", isDefault: true }];

const catalogs: HarnessCatalog[] = [
  keptAccess(
    {
      harness: "claude",
      label: "Claude Code",
      source: "harness",
      version: "2.1.257",
      models: [{ value: "claude-opus-5", label: "Opus 5", isDefault: true, contextWindows: efforts ? ["200k", "1m"] : [] }],
      efforts: efforts ? CLAUDE_EFFORTS : [],
      contextWindows: efforts ? CLAUDE_CONTEXT_WINDOWS : [],
      permissionModes: ACCESS_MODES,
      steers: true,
      renames: true,
      images: true,
      keptMode: "default",
      bypassMode: "bypassPermissions",
      // The CLI's own screens, as the runtime's table names them; the chat replay announces them beside the rest.
      screenCommands: [
        { name: "login", control: "sign-in" },
        { name: "logout", control: "sign-in" },
        { name: "model", control: "model" },
        { name: "permissions", control: "access" },
        { name: "config", control: "settings" },
        { name: "help", control: "docs" },
      ],
    },
    THIS_COMPUTER,
  ),
  {
    harness: "codex",
    label: "Codex",
    source: "table",
    version: "app-server 0.153.0, 2026-09-07",
    models: [
      { value: "gpt-5.6-sol", label: "GPT-5.6-Sol", isDefault: true, efforts: ["low", "medium", "high"], defaultEffort: "low" },
      { value: "gpt-5.5", label: "GPT-5.5", efforts: ["low", "medium", "high"], defaultEffort: "medium" },
    ],
    efforts: [{ value: "low", label: "Low", isDefault: true }, { value: "medium", label: "Medium" }, { value: "high", label: "High" }],
    contextWindows: [],
    permissionModes: [],
    steers: false,
    renames: false,
    images: false,
  },
];

/** A turn on this computer with a permission prompt open and one already answered, so the row can be laid out and
 * photographed in both states; the local kind is what starts a thread at the access its harness asks in. */
const perm = { workspaceId: MAC.id, sessionId: "s_perm", turnId: "turn_perm", threadId: "thr_perm" };
const permOptions = [
  { id: "allow", label: "Allow", effect: "allow" as const },
  { id: "deny", label: "Deny", effect: "deny" as const },
  { id: "mode:acceptEdits", label: "Allow, then Accept edits", effect: "mode" as const, mode: "acceptEdits" },
];
/** A page about two kilobytes long, the size the persona's prompt pasted into the chat before this row folded it. */
const LANDING_PAGE = [
  "<!DOCTYPE html>",
  '<html lang="en">',
  "  <head>",
  '    <meta charset="utf-8" />',
  '    <meta name="viewport" content="width=device-width, initial-scale=1" />',
  "    <title>Health</title>",
  "    <style>",
  "      body { font: 16px/1.5 system-ui, sans-serif; margin: 0; padding: 3rem 1.5rem; color: #18181b; }",
  "      main { max-width: 38rem; margin: 0 auto; }",
  "      h1 { font-size: 2rem; margin: 0 0 1rem; }",
  "      p { margin: 0 0 1rem; }",
  "      code { font-family: ui-monospace, monospace; background: #f4f4f5; padding: 0.1rem 0.3rem; }",
  "    </style>",
  "  </head>",
  "  <body>",
  "    <main>",
  "      <h1>The api is up</h1>",
  "      <p>",
  "        This page is served by the health route. If you can read it, the process started, the port was free",
  "        and the router matched. Nothing on it is clever, and that is on purpose.",
  "      </p>",
  "      <p>",
  '        The route answers <code>GET /health</code> with <code>{ "ok": true }</code> and this page with the same',
  "        words a person can read. One of the two is for a machine and the other is for whoever is paged at",
  "        three in the morning.",
  "      </p>",
  "      <p>",
  "        There is no script tag here and no stylesheet to fetch, so a browser that draws nothing is telling you",
  "        about the network rather than about the page.",
  "      </p>",
  "    </main>",
  "  </body>",
  "</html>",
  "",
].join("\n");

const prompting: SessionEvent[] = [
  { type: "session.start", ...perm, prompt: "Add a health route and run the tests." },
  { type: "session.delta", ...perm, kind: "text", text: "I will add the route, then run the suite." },
  {
    type: "session.permission",
    ...perm,
    askId: "ask_done",
    toolName: "Write",
    toolUseId: "toolu_1",
    input: JSON.stringify({ file_path: "/Users/zingzy/api/src/health.ts", content: "export const health = () => ({ ok: true });\n" }),
    detail: "health.ts",
    options: permOptions,
  },
  { type: "session.permission.closed", ...perm, askId: "ask_done", outcome: "allowed", optionId: "allow" },
  {
    type: "session.permission",
    ...perm,
    askId: "ask_open",
    toolName: "Bash",
    toolUseId: "toolu_2",
    input: JSON.stringify({ command: "pnpm exec vitest run --minWorkers=1 --maxWorkers=1 packages/api/test/health.test.ts packages/api/test/routes.test.ts", description: "Run the health route's test" }),
    detail: "pnpm exec vitest run",
    options: permOptions,
  },
  // A page of the size a person really meets, so the rule that an opened file leaves the buttons on the screen can
  // be measured rather than asserted.
  {
    type: "session.permission",
    ...perm,
    askId: "ask_file",
    toolName: "Write",
    toolUseId: "toolu_4",
    input: JSON.stringify({ file_path: "/Users/zingzy/api/public/index.html", content: LANDING_PAGE }),
    detail: "index.html",
    options: permOptions,
  },
  // One token longer than any row is wide, so the rule that a command is never broken inside a token can be measured.
  {
    type: "session.permission",
    ...perm,
    askId: "ask_long",
    toolName: "Bash",
    toolUseId: "toolu_3",
    input: JSON.stringify({ command: `curl -fsSL https://registry.example.com/artifacts/${"a1b2c3d4e5".repeat(15)}/health.tar.gz` }),
    options: permOptions,
  },
];

const linger = { workspaceId: "ws_a", sessionId: "s1", turnId: "turn_1", threadId: "thr_linger" };
const lingering: SessionEvent[] = [
  { type: "session.start", ...linger, prompt: "Start the dev server in the background and reply when it is up." },
  { type: "session.delta", ...linger, kind: "text", text: "Server is live at :3000." },
  { type: "session.done", ...linger, result: { status: "completed", durationMs: 900, costUsd: 0.001 } },
];

// ?chat=1 replays one answered turn whose reply is the markdown the chat actually has to draw: prose, a
// sentence with inline code in it, a fenced block the highlighter colours, a quote, a list and a table. It is
// the surface the ticket names, and the parts that can go wrong in light are the ones that carry their own
// ground: a code block, an inline code chip and a quote's rule all sit on a near-white card.
const chatTurn = { workspaceId: "ws_a", sessionId: "s1", turnId: "turn_2", threadId: "thr_chat" };
const CHAT_MARKDOWN = [
  "Bumped the lockfile and ran the gate. The failing file was `apps/web/test/tokens.test.ts`, which pins",
  "the stylesheet's additions, so the new token needed the snapshot taken again.",
  "",
  "```ts",
  'const ROW_META_CLASS = "font-mono text-[11px] tabular-nums";',
  "export function metaLine(project: Project): string {",
  "  // A machine wsp does not drive says what it is instead of what it costs.",
  "  return driven(project) ? costLine(project) : machineLine(project);",
  "}",
  "```",
  "",
  "> The gate runs once, on the branch merged with origin/main in a fresh worktree.",
  "",
  "- `pnpm test` green without creds",
  "- `tsc --noEmit` clean",
  "",
  "| file | tests | state |",
  "| --- | --- | --- |",
  "| tokens.test.ts | 5 | green |",
  "| sidebar.test.tsx | 55 | green |",
  "",
  "Full notes in [the tracker](https://example.invalid/439).",
].join("\n");
// The init's slash_commands as the CLI lists them: the built-ins that run headless, its own screens, and a skill.
const CHAT_SLASH_COMMANDS = ["compact", "context", "cost", "init", "review", "login", "logout", "model", "permissions", "config", "help", "unslop"];
const chatHistory: SessionEvent[] = [
  { type: "session.start", ...chatTurn, prompt: "Bump the lockfile and run the gate.", harness: { slashCommands: CHAT_SLASH_COMMANDS } },
  { type: "session.delta", ...chatTurn, kind: "text", text: CHAT_MARKDOWN },
  { type: "session.done", ...chatTurn, result: { status: "completed", durationMs: 2400, costUsd: 0.004 } },
];

// The import ops ride the api only where a case reads them (the tiles, the dialog, the Machine tab), so the rows'
// menu the shell case counts keeps the import refused as a client without the ops has it.
const importOps: Pick<Api, "planProject" | "importProject"> = {
  // The import dialog's plan for the folder a drop hands it: a repository of some files, two caches left behind, one
  // secret-shaped file cut and one offered rewritten, so every row of the plan draws.
  planProject: async source => ({
    source,
    repo: true,
    files: 412,
    bytes: 48_200_000,
    secrets: [
      { path: ".env", bytes: 120, signals: ["name", "keys"] },
      { path: ".git/config", bytes: 300, signals: ["url"], rewrite: { urls: ["https://github.com/zingzy/spoo"], drop: [] } },
    ],
    excluded: ["node_modules", ".next"],
    skipped: [],
    agents: [],
  }),
  importProject: async o => ({ dest: o.dest, files: 412, bytes: 48_200_000, parts: 1, cut: [".env"], rewritten: [".git/config"], agents: [] }),
};
const withImport = params.get("drop") === "1" || params.get("import") === "1" || params.get("panel") === "machine";

const api: Api = {
  listWorkspaces: async () => workspaces,
  getWorkspace: async id => workspaces.find(w => w.id === id)!,
  createWorkspace: async () => workspaces[0]!,
  createFromGoldenHead: async () => workspaces[0]!,
  watchStatuses: async () =>
    workspaces.map(w =>
      w.id === MAC.id
        ? statusOf(w, { kind: "local", size: { cpu: 10, memMb: 16384 }, rateUsdPerHour: 0, facts: { os: "macOS 15.5", uptimeMs: 3 * 86_400_000 + 4 * 3_600_000, folder: "/Users/zingzy/wsp" } })
        : statusOf(w, params.get("offline") === "1" ? { reach: { state: statusOf(w).reach.state, offline: true } } : w.id !== "ws_a" ? {} : params.get("helper") === "1" ? { daemonNote: DAEMON_UPDATING } : params.get("oom") === "1" ? { reach: { state: "unreachable" } } : { idleAt: Date.now() + 15.5 * 60_000 }),
    ),
  forget: async () => {},
  nap: async id => workspaces.find(w => w.id === id)!,
  wake: async id => workspaces.find(w => w.id === id)!,
  upgrade: async id => workspaces.find(w => w.id === id)!,
  capabilities: async () => (caps()),
  startSession: async o => ({ id: "s2", workspaceId: o.workspaceId, harness: "claude", status: "running" }),
  portReach: async (_id, port) => ({ url: `https://m1-${port}.preview.example/?pt_token=e`, expiresAt: Date.now() + 3_600_000 }),
  daemon: noDaemonApi,
  sessionHistory: async id =>
    id === MAC.id
      ? params.get("perm") === "1"
        ? prompting
        : []
      : id !== "ws_a"
        ? []
        : params.get("chat") === "1"
          ? chatHistory
          : params.get("linger") === "1"
            ? lingering
            : [],
  answerPermission: async () => "answered",
  // Bypass is a launch flag on this CLI, so a pick of it while a turn runs is the one the harness will not take;
  // the composer then says when it lands, which is the line this fixture is here to draw.
  setSessionAccess: async () => "unsupported",
  listSnapshots: async () => ({ name: "default", head: null, versions: [] }),
  snapshotStorage: async () => null,
  rollbackSnapshot: async () => ({ lineage: { name: "default", head: null, versions: [] }, existingWorkspaces: "untouched" }),
  listSessions: async () => sessions,
  // The runtime keeps the name on the row, so the next listing carries it; the shell fixture does the same.
  renameSession: async (sessionId, title) => {
    const row = sessions.find(s => s.id === sessionId);
    if (row !== undefined) row.harnessTitle = title;
    return { outcome: "renamed" };
  },
  // The runtime holds the name on this computer, so the next listing carries it; the shell fixture does the same.
  renameWorkspace: async (id, name) => {
    const row = workspaces.find(w => w.id === id)!;
    row.name = name;
    return row;
  },
  // The look sits on the record beside the name, so the fixture writes it there and answers with the row.
  setWorkspaceLook: async (id, look) => {
    const row = workspaces.find(w => w.id === id)!;
    if (look.theme !== undefined) {
      if (look.theme === null) delete row.theme;
      else row.theme = look.theme;
    }
    if (look.glyph !== undefined) {
      if (look.glyph === null) delete row.glyph;
      else row.glyph = look.glyph;
    }
    return row;
  },
  listHarnesses: async () => catalogs,
  subscribe: () => () => {},
  getGolden: async () => undefined,
  hostTerminalConfig: async () => TRANSLUCENT,
  ...(withImport ? importOps : {}),
  listProjectGoldens: async () => [],
  snapshotWorkspace: async id => ({ snapshotId: "snap_taken", projects: PROJECTS, golden: "snap_g", workspaceId: id, workspaceName: "api", createdAt: new Date().toISOString() }),
};

/** A Ghostty config with a background-opacity under 1, the shape whose translucency belongs to the canvas alone, and a
 * font-size of 16, the size the pane's cells must take from the file. */
const TRANSLUCENT: TerminalConfig = { files: ["/Users/dev/.config/ghostty/config"], fontFamily: [], fontSize: 16, palette: Array<null>(16).fill(null), windowPaddingX: { left: 14, right: 14 }, windowPaddingY: { top: 14, bottom: 14 }, backgroundOpacity: 0.85 };

/** A daemon that holds the ptys the page opens and answers nothing else. */
function fakeWire(): TerminalWire {
  const held = new Set<string>();
  return {
    request: async (op, params = {}) => {
      if (op === "pty.create") {
        const ptyId = `p${held.size + 1}`;
        held.add(ptyId);
        return { ok: true, ptyId };
      }
      if (op === "pty.kill") held.delete(String(params["ptyId"]));
      if (op === "pty.list") return { ok: true, ptys: [...held].map(id => ({ id, pid: 1, cols: 80, rows: 24, exited: false })) };
      return { ok: true };
    },
  };
}

// ?version=behind puts a shell older than the host that served this page on the window, so the one line the app
// says about it can be measured where it lands; the whole road runs, bridge and boot object both.
if (params.get("version") === "behind") {
  window.wsp = { ...window.wsp, version: "0.1.3" };
  (window as unknown as { __WSP__?: { wsPort: number; token: string; version: string } }).__WSP__ = { wsPort: 0, token: "", version: "0.1.5" };
}
const toast = params.get("toast");
const shown = params.get("ws");
useStore.setState({ conn: "live", ...(toast !== null ? { toast } : {}), ...(shown !== null ? { selectedId: shown } : {}) });
// ?sidebar=<px> is the width the host's record holds, and ?spaces=1 the body it holds; the fixture's api answers no
// preferences op, so the record is put in place here as the host's answer would put it. The shell is where the
// surfaces behind labs are shot, so labs is on unless ?labs=0 asks for the record a host without it serves.
const sidebarWidth = params.get("sidebar");
useStore.setState({ preferences: { ...DEFAULT_PREFERENCES, theme, labs: params.get("labs") !== "0", ...(sidebarWidth !== null ? { sidebarWidth: Number(sidebarWidth) } : {}), ...(params.get("spaces") === "1" ? { sidebarMode: "spaces" as const } : {}), ...(params.get("size") === "file" ? { terminalSize: "file" as const } : {}), ...(projects ? { project: { ws_a: "spoo", ws_m: "spoo" } } : {}) } });
const settings = params.get("settings") === "1";
if (settings) useStore.setState({ settingsOpen: true });
function ThemeRule() {
  useThemeEffect();
  return null;
}
/** The app's own reading of the two halves, so ?version=behind runs the road the app runs and not a set toast. */
function VersionRule() {
  useShellVersionEffect();
  return null;
}
useStore.getState().bind(api);
// ?init=building puts the init job mid-build on the store, as its events would, so the collapsed cloud row's progress
// line can be measured and photographed; the fixture's golden is none, so the row is there.
if (params.get("init") === "building") {
  useStore.setState({
    initJob: {
      id: "init_1",
      road: "manual",
      phase: "building",
      keys: { solari: true },
      step: 0,
      stoppable: true,
      screens: [],
      rows: [
        { id: "stage/creating", kind: "stage", label: GOLDEN_STAGE_WORDS.creating, state: "done", ms: 14_000 },
        { id: "stage/deploying-daemon", kind: "stage", label: GOLDEN_STAGE_WORDS["deploying-daemon"], state: "running", detail: "node v22", lines: ["apt-get install -y git curl", "node v22"] },
        { id: "stage/applying-setup", kind: "stage", label: GOLDEN_STAGE_WORDS["applying-setup"], state: "waiting" },
        { id: "stage/ready", kind: "stage", label: GOLDEN_STAGE_WORDS.ready, state: "waiting" },
      ],
      progress: { done: 1, total: 4 },
      log: [],
    },
  });
}
// ?init=waiting puts the job at a sign-in whose page waits for the person, two of four stages over, so the button's
// paused spinner and its words can be measured.
if (params.get("init") === "waiting") {
  useStore.setState({
    initJob: {
      id: "init_1",
      road: "manual",
      phase: "signing-in",
      keys: { solari: true },
      step: 0,
      stoppable: true,
      screens: [],
      rows: [
        { id: "stage/creating", kind: "stage", label: GOLDEN_STAGE_WORDS.creating, state: "done", ms: 14_000 },
        { id: "stage/deploying-daemon", kind: "stage", label: GOLDEN_STAGE_WORDS["deploying-daemon"], state: "done", ms: 40_000 },
        { id: "sign-in/gh", kind: "sign-in", tool: "gh", label: "GitHub CLI login", state: SIGN_IN_OPEN_STATE, page: "https://github.com/login/device", code: "8F4A-C21B" },
        { id: "stage/ready", kind: "stage", label: GOLDEN_STAGE_WORDS.ready, state: "waiting" },
      ],
      progress: { done: 2, total: 4 },
      needsYou: { what: "sign in to GitHub CLI login", since: Date.now() },
      log: [],
    },
  });
}
// The meter's tick for the running machine, so its row's second line reads cost, rate and countdown together.
useStore.getState().applyEvent({ type: "workspace.cost", workspaceId: "ws_a", phase: "running", rateUsdPerHour: 0.11, awakeMs: 2 * 3_600_000, accruedUsd: 0.29, at: new Date().toISOString() });
// ?panel=preview opens the right panel inline with nothing in it, the narrowest the centre column gets at a width.
if (params.get("panel") === "preview" && shown !== null) {
  useRightPanelStore.setState({ byWorkspaceId: {} });
  useRightPanelStore.getState().open(shown, "preview");
}
// The fake route's host resolves nowhere, so the frame under the bar stays blank.
const at = params.get("at");
if (params.get("panel") === "browser" && shown !== null && at !== null) {
  useRightPanelStore.setState({ byWorkspaceId: {} });
  useRightPanelStore.getState().open(shown, "preview");
  useRightPanelStore.getState().openBrowser(shown, useBrowserTabs.getState().createTab(shown, parseAddress(at)));
}
if (params.get("panel") === "machine" && shown !== null) {
  useRightPanelStore.setState({ byWorkspaceId: {} });
  useRightPanelStore.getState().open(shown, "machine");
}
if (params.get("panel") === "terminal" && shown !== null) {
  const surfaces: GhosttyTerminalSurface[] = [];
  const create = GhosttyTerminalSurface.create.bind(GhosttyTerminalSurface);
  GhosttyTerminalSurface.create = async (mount, options) => { const s = await create(mount, options); surfaces.push(s); return s; };
  Object.assign(window, { surfaces });
  const terminals = new WorkspaceTerminals(fakeWire());
  terminals.feedStatus("live");
  provideTerminals(shown, terminals);
  useRightPanelStore.setState({ byWorkspaceId: {} });
  useRightPanelStore.getState().open(shown, "preview");
  void openPanelTerminal(shown);
}
// ?images=<n> puts n images in the composer, as a paste would, so the thumbnail row can be measured; the bytes are a
// tiny gradient of a known colour, since what is measured is the row and not the picture.
if (params.get("images") !== null) {
  const swatch = (hue: number): File => {
    const canvas = document.createElement("canvas");
    canvas.width = 32;
    canvas.height = 32;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = `hsl(${hue} 70% 55%)`;
    ctx.fillRect(0, 0, 32, 32);
    const bytes = Uint8Array.from(atob(canvas.toDataURL("image/png").split(",")[1]!), c => c.charCodeAt(0));
    return new File([bytes], `shot-${hue}.png`, { type: "image/png" });
  };
  const count = Number(params.get("images")) || 1;
  void useComposerImagesStore.getState().add(shown ?? "ws_a", Array.from({ length: count }, (_, i) => swatch(i * 60)));
}
if (params.get("oom") === "1") {
  const GiB = 1024 ** 3;
  getLive("ws_a").feedStatus("live");
  getLive("ws_a").feedSample({ type: "sys.sample", cpu: 99, load1: 6.4, mem: { used: 3.59 * GiB, total: 3.94 * GiB }, disk: { used: 1, total: 10 }, at: 1 });
  getLive("ws_a").feedStatus("connecting");
}
createRoot(document.getElementById("root")!).render(
  <TooltipProvider>
    {settings ? <ThemeRule /> : null}
    {params.get("version") === "behind" ? <VersionRule /> : null}
    <AppShell>{settings ? <SettingsPage /> : shown === null ? <div /> : <WorkspaceThread workspaceId={shown} />}</AppShell>
  </TooltipProvider>,
);
// ?import=1: the dialog as a drop on the first workspace's tile leaves it, asked for once the sidebar is listening.
if (params.get("import") === "1") {
  const ask = (): void => {
    if (document.querySelector("[data-sidebar-row]") === null) setTimeout(ask, 20);
    else requestProjectTrip({ workspaceId: "ws_a", trip: "import", source: "/Users/dev/spoo" });
  };
  ask();
}
