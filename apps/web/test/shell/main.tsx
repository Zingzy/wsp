// SPDX-License-Identifier: AGPL-3.0-only
// Served by Vite to a real browser: the app shell over a fake api with three
// workspaces (running, paused, gone) and four threads, in either theme
// (?theme=light), with a status toast in the footer (?toast=...) and with the
// runtime replacing the first machine's helper (?helper=1) or the first
// machine's link dropped after a near-full memory sample (?oom=1) or every
// probe failing before it left this computer (?offline=1), so a test
// can measure the chrome's geometry, which jsdom cannot lay out. With
// ?ws=<id> the centre holds that workspace's thread and composer, so the
// refusal line above the box can be measured for the running, paused and gone
// workspaces and the model picker's agent marks for their size and colour;
// ?ws=ws_a&linger=1 replays a turn that replied but whose process has not
// exited; ?ws=ws_a&chat=1 replays one whose reply is markdown of every kind the
// chat draws, so the message body and its code blocks can be measured; ?shell=desktop puts a desktop bridge on the page so the workspace
// switch chord reaches it; ?mac=1 marks the html the way the macOS preload
// does; ?panel=terminal opens the right panel with a Browser tab and a
// terminal over a fake daemon wire, the host answering a translucent Ghostty
// config, so the pane's material can be measured with each tab active;
// ?sidebar=<px> opens the sidebar at that remembered width so the rows can
// be measured at several; ?spaces=1 opens it in the Spaces body, one
// workspace under its header with a dot per workspace at the bottom;
// ?images=<n> puts n images in the composer so the thumbnail row above the
// text can be measured; ?settings=1 puts the settings page in the centre,
// with the theme rule mounted so a pick on it moves the page's theme as the
// app's would; ?size=file is the record saying the terminal's text size comes
// from the Ghostty file; ?local=1 puts this computer in the list beside the
// cloud machines, so a mixed list of both kinds can be measured.
import { createRoot } from "react-dom/client";
import { DAEMON_UPDATING, DEFAULT_PREFERENCES, DESKTOP_MAC_CLASS, type HarnessCatalog, type SessionEvent, type SessionView, type TerminalConfig, type WorkspaceView } from "@wsp/protocol";
import { statusOf } from "../workspace-status";
import { TooltipProvider } from "../../src/components/ui/tooltip";
import type { Api } from "../../src/protocol/client";
import { getLive } from "../../src/machine/live";
import { useStore } from "../../src/protocol/store";
import { useRightPanelStore } from "../../src/rightPanelStore";
import { SettingsPage } from "../../src/settings/SettingsPage";
import { useThemeEffect } from "../../src/settings/theme";
import { AppShell } from "../../src/shell/AppShell";
import { openPanelTerminal } from "../../src/shell/shellCommands";
import { WorkspaceThread } from "../../src/shell/WorkspaceThread";
import { useComposerImagesStore } from "../../src/components/chat/composerImages";
import { GhosttyTerminalSurface } from "../../src/terminal/ghostty/surface";
import { provideTerminals, WorkspaceTerminals, type TerminalWire } from "../../src/terminal/link";
import "../../src/index.css";

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

const view = (id: string, name: string, phase: WorkspaceView["phase"] = "running"): WorkspaceView => ({
  id,
  name,
  machineId: `m_${id}`,
  phase,
  golden: "snap_g",
  createdAt: "2026-09-05T11:00:00Z",
});
const cloud = [view("ws_a", "api"), view("ws_b", "web", "napping"), { ...view("ws_c", "old", "gone"), gone: "machine m_ws_c is gone at the provider: Not found" }];
// ?local=1 adds this computer to the list, so a mixed list can be measured: two cloud rows and one local beside them.
const MAC: WorkspaceView = { ...view("ws_m", "zingzy-mac"), kind: "local", machineId: "local", golden: "" };
const workspaces = params.get("local") === "1" ? [...cloud, MAC] : cloud;
// The ticket's rows: long titles with the agent and both opener words. ws_a mixes a working thread with an idle
// one; ws_b has only idle ones, the shape that used to draw no Idle header at all, one of them on Codex so both a
// coloured and a monochrome agent mark sit in the shots.
const sessions: SessionView[] = [
  { id: "s1", workspaceId: "ws_a", harness: "claude", status: "running", prompt: "Now reply with exactly the word pong.", startedBy: "person", startedAt: Date.now() - 48 * 60_000 },
  { id: "s2", workspaceId: "ws_a", harness: "claude", status: "completed", prompt: "Reply with exactly the word hi.", startedBy: "cli", startedAt: Date.now() - 30 * 60_000, endedAt: Date.now() - 24 * 60_000 },
  { id: "s3", workspaceId: "ws_b", harness: "codex", status: "completed", prompt: "Bump the lockfile and run the gate.", startedBy: "cli", startedAt: Date.now() - 90 * 60_000, endedAt: Date.now() - 80 * 60_000 },
  { id: "s4", workspaceId: "ws_b", harness: "claude", status: "interrupted", prompt: "Drop the old preview shim.", startedBy: "person", startedAt: Date.now() - 120 * 60_000, endedAt: Date.now() - 110 * 60_000 },
];

// Two agents the composer can start a thread on, so its picker draws a coloured mark and a monochrome one. Codex
// carries the effort lists its app-server reports, each model with the effort that model runs at, so the effort
// picker draws its default against a pick rather than against the binary.
const catalogs: HarnessCatalog[] = [
  { harness: "claude", label: "Claude Code", source: "harness", version: "2.1.257", models: [{ value: "claude-opus-5", label: "Opus 5", isDefault: true, contextWindows: [] }], efforts: [], contextWindows: [], permissionModes: [], steers: true, renames: true, images: true },
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
const chatHistory: SessionEvent[] = [
  { type: "session.start", ...chatTurn, prompt: "Bump the lockfile and run the gate." },
  { type: "session.delta", ...chatTurn, kind: "text", text: CHAT_MARKDOWN },
  { type: "session.done", ...chatTurn, result: { status: "completed", durationMs: 2400, costUsd: 0.004 } },
];

const api: Api = {
  listWorkspaces: async () => workspaces,
  getWorkspace: async id => workspaces.find(w => w.id === id)!,
  createWorkspace: async () => workspaces[0]!,
  createFromGoldenHead: async () => workspaces[0]!,
  watchStatuses: async () =>
    workspaces.map(w =>
      w.id === MAC.id
        ? statusOf(w, { kind: "local", size: { cpu: 10, memMb: 16384 }, rateUsdPerHour: 0 })
        : statusOf(w, params.get("offline") === "1" ? { reach: { state: statusOf(w).reach.state, offline: true } } : w.id !== "ws_a" ? {} : params.get("helper") === "1" ? { daemonNote: DAEMON_UPDATING } : params.get("oom") === "1" ? { reach: { state: "unreachable" } } : { idleAt: Date.now() + 15.5 * 60_000 }),
    ),
  forget: async () => {},
  nap: async id => workspaces.find(w => w.id === id)!,
  wake: async id => workspaces.find(w => w.id === id)!,
  upgrade: async id => workspaces.find(w => w.id === id)!,
  capabilities: async () => ({ liveCloneForks: true, ramPreservingPause: true, resize: true, previewUrls: true, signedUrls: true, containers: true, callbackRelay: true, snapshotListing: true, templates: false, sizes: [] }),
  startSession: async o => ({ id: "s2", workspaceId: o.workspaceId, harness: "claude", status: "running" }),
  portReach: async (_id, port) => ({ url: `https://m1-${port}.preview.example/?pt_token=e`, expiresAt: Date.now() + 3_600_000 }),
  daemonReach: async () => ({ url: "ws://127.0.0.1:1", expiresAt: 0 }),
  sessionHistory: async id => (id !== "ws_a" ? [] : params.get("chat") === "1" ? chatHistory : params.get("linger") === "1" ? lingering : []),
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
  listHarnesses: async () => catalogs,
  subscribe: () => () => {},
  getGolden: async () => undefined,
  hostTerminalConfig: async () => TRANSLUCENT,
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

const toast = params.get("toast");
const shown = params.get("ws");
useStore.setState({ conn: "live", ...(toast !== null ? { toast } : {}), ...(shown !== null ? { selectedId: shown } : {}) });
// ?sidebar=<px> is the width the host's record holds, and ?spaces=1 the body it holds; the fixture's api answers no
// preferences op, so the record is put in place here as the host's answer would put it.
const sidebarWidth = params.get("sidebar");
useStore.setState({ preferences: { ...DEFAULT_PREFERENCES, theme, ...(sidebarWidth !== null ? { sidebarWidth: Number(sidebarWidth) } : {}), ...(params.get("spaces") === "1" ? { sidebarMode: "spaces" as const } : {}), ...(params.get("size") === "file" ? { terminalSize: "file" as const } : {}) } });
const settings = params.get("settings") === "1";
if (settings) useStore.setState({ settingsOpen: true });
function ThemeRule() {
  useThemeEffect();
  return null;
}
useStore.getState().bind(api);
// The meter's tick for the running machine, so its row's second line reads cost, rate and countdown together.
useStore.getState().applyEvent({ type: "workspace.cost", workspaceId: "ws_a", phase: "running", rateUsdPerHour: 0.11, awakeMs: 2 * 3_600_000, accruedUsd: 0.29, at: new Date().toISOString() });
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
    <AppShell>{settings ? <SettingsPage /> : shown === null ? <div /> : <WorkspaceThread workspaceId={shown} />}</AppShell>
  </TooltipProvider>,
);
