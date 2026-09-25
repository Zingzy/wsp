// SPDX-License-Identifier: AGPL-3.0-only
// Served by Vite to a real browser: the app's own components on a fixed store,
// for the screens of the four nouns a live host on one Mac cannot make. A
// workspace on a second computer, a workspace an agent forked, a project
// nobody has started work on and a first run that has been refused are all
// states a person meets and none of them can be staged on the owner's own
// machine, so the real sidebar, the real dialog and the real first run are fed
// records here instead of pixels being drawn by hand.
//
// ?screen=<name> picks one, ?theme=light the light side, ?sidebar=<px> opens
// the sidebar at that remembered width, ?pick=<project id> is the project
// the switcher is filtered to, written to this window's storage before the
// store binds:
//   sidebar          three projects (spoo and wsp on this Mac, landing on the
//                    box), three workspaces with their branches, a lead thread
//                    with a thread its agent opened and one that opened under
//                    that stopped on a question, a workspace the lead forked
//                    nested under it, and a project with no workspace yet
//   sidebar-fallback the same with the forking thread's workspace collapsed,
//                    where the forked workspace falls back to its project's list
//   sidebar-empty    no project and no workspace: the first run in the centre
//                    and the sidebar's one row pointing at it
//   sidebar-one-project  spoo alone with its two workspaces
//   sidebar-picked   the sidebar screen filtered to spoo, with the thread three
//                    deep selected, so the lifted row is the deepest one
//   sidebar-hosts    the sidebar screen in a desktop window that knows a second
//                    host, so the foot names the computer this window is on
//   switcher-open    the sidebar screen with the switcher's menu open
//   dialog           New workspace over that sidebar with three projects, so
//                    the pick is the segmented control
//   first-run        the first run with nothing typed
//   first-run-refused    the runtime's own sentence in the slot under the button
//   first-run-starting   Start held while the create runs
//   first-run-no-agent   the line for a computer with no agent on it, Start held
//   first-run-agents     six agents on this computer, which fill the line's two
//                        lines and are cut at the second
//   creating         the creation view with its stage log and the word table's
//                    own line under it, off the record the create answered with
//   settings-appearance   Settings on Appearance, the record at its defaults
//   settings-restore      the same with the sidebar width off its default, so
//                         Restore defaults stands (with ?sidebar=<px>)
//   settings-light-picked the Light segment picked on the dark side
//   settings-computers    the Computers list: this Mac, three boxes joined and
//                         the cloud whose key this host holds
//   settings-computer     the box whose recipe is done, its own page
//   settings-computer-failed  the box whose recipe lost rows
//   settings-this-mac     this Mac's page, the agents found here
//   settings-cloud        the cloud's page with the image built and copied
//   settings-projects     the Projects list, one on the box
//   settings-project      spoo's own page
//   settings-devices      three devices paired, one of them this browser
//   settings-account      the one Account row, not signed in
//   settings-keybindings  the chords, in a desktop shell
//   settings-about        the two halves of the release, in a desktop shell
//   settings-about-behind the same with 0.3.0 out, the app on its own host, whose
//                         shell holds the bundle's download until the test lets it go
//   settings-about-restart 0.3.0 installed under the running 0.2.0 host, which a restart brings back
//   settings-search       "width" typed in the field
//   settings-over-panel   a workspace's panel open, then Settings over it
//   settings-add-computer the Add a computer sheet over Computers
//   settings-remove-computer  the Remove dialog over the box's page
//   bring-back-paused    the row's menu on a machine that is stopped, with
//                        Bring back held and its reason under the pointer
//   bring-back-absent    the same on a workspace whose computer is not
//                        answering, which says what that computer says
//   bring-back-roadless  the same on a wsp whose host carries no such request
//   agents-widths    the agents manager off one report as the page at its
//                    card's width and a phone's (760, 696, 358) and as the
//                    panel at the widths its shape changes over (520, 480,
//                    380 and its 360 floor)
//   panel-agents     the task on the box selected, its panel open on Agents
import { createRoot } from "react-dom/client";
import { CATALOG_AGENTS, agentName } from "@wsp/catalog";
import { manyAgents } from "./agents";
import { CREATE_READY, DEFAULT_PREFERENCES, hereWord, placeAddSheetWord, startingLine, type AgentsSignInEvent, type Capabilities, type DeviceView, type InitAgent, type PlaceAddStep, type PlaceProvision, type PlaceView, type ProjectView, type SealedImage, type SessionView, type WorkspaceLanding, type WorkspaceView } from "@wsp/protocol";
import { AppShell } from "../../src/shell/AppShell";
import { FirstRun } from "../../src/shell/FirstRun";
import { AgentsManager, type AgentsShell } from "../../src/components/agents/AgentsManager";
import { useServerTools } from "../../src/components/agents/useServerTools";
import { SettingsPage } from "../../src/settings/SettingsPage";
import { AGENTS_REPORT, SERVER_TOOLS } from "../fixtures/agents-report";
import { useSettingsStore, type SettingsAt } from "../../src/settings/settingsStore";
import { useThemeEffect } from "../../src/settings/theme";
import { WorkspaceCreation } from "../../src/shell/WorkspaceCreation";
import { NewWorkspaceDialog } from "../../src/sidebar/NewWorkspaceDialog";
import { requestNewWorkspace } from "../../src/shell/shellRequests";
import type { Api } from "../../src/protocol/client";
import { useStore } from "../../src/protocol/store";
import { useRightPanelStore } from "../../src/rightPanelStore";
import "../../src/index.css";

const params = new URLSearchParams(window.location.search);
const screen = params.get("screen") ?? "sidebar";
document.documentElement.classList.toggle("dark", params.get("theme") !== "light");

const AT = "2026-09-17T09:00:00.000Z";
const project = (id: string, name: string, computer: string): ProjectView => ({
  id,
  name,
  computer,
  source: { kind: "folder", path: `/Users/dev/${name}` },
  path: `/Users/dev/${name}`,
  remote: `https://github.com/dev/${name}.git`,
  defaultBranch: "main",
  memoryKey: `-Users-dev-${name}`,
  memoryDir: `/Users/dev/.claude-cfg/projects/-Users-dev-${name}/memory`,
  createdAt: AT,
});
const SPOO = project("pr_spoo", "spoo", "here");
const WSP = project("pr_wsp", "wsp", "here");
const LANDING = project("pr_landing", "landing", "p_spoo");

const caps = (over: Partial<Capabilities>): Capabilities => ({ copies: true, ownNetwork: false, ...over }) as Capabilities;
const landings: Record<string, WorkspaceLanding> = {
  pr_spoo: { name: "here", capabilities: caps({}) },
  pr_wsp: { name: "here", capabilities: caps({}) },
  pr_landing: { place: "p_spoo", name: "spoo", capabilities: caps({ copies: false, ownNetwork: true, pauseMode: "disk" }) },
};

const places: PlaceView[] = [
  { id: "here", kind: "computer", name: "zingzy-mbp", default: false, present: true, shape: { cpu: 10, memMb: 16384 }, takesForks: false } as PlaceView,
  // The box stops answering on the screen about a computer that has gone quiet; every other screen has it on.
  {
    id: "p_spoo",
    kind: "computer",
    name: "spoo",
    default: true,
    present: params.get("screen") !== "bring-back-absent",
    lastSeenAt: new Date(Date.parse(AT) - 40 * 60_000).toISOString(),
    shape: { cpu: 4, memMb: 8192 },
    takesForks: true,
  } as PlaceView,
];

const ref = (p: ProjectView) => ({ id: p.id, name: p.name, path: p.path, computer: p.computer });
/** The folder worked where it sits: the first piece of work on a project here. */
const inPlace = (id: string, name: string, p: ProjectView): WorkspaceView => ({
  id,
  name,
  kind: "local",
  machineId: "local",
  project: ref(p),
  phase: "running",
  golden: "",
  createdAt: AT,
  copy: { road: "clonefile", path: `${p.path}-first`, source: p.path, base: "", branch: "main", carried: "deps-and-config" },
});
/** A copy of that folder beside it, with the port an app reading PORT binds inside it. */
const copyHere = (id: string, name: string, p: ProjectView, portBase: number, branch: string, extra: Partial<WorkspaceView> = {}): WorkspaceView => ({
  ...inPlace(id, name, p),
  copy: { road: "clonefile", path: `${p.path}-${id}`, source: p.path, base: "abc", branch, carried: "deps-and-config" },
  portBase,
  ...extra,
});
/** A copy on a computer of the person's own, which gives every copy a network of its own. */
const onBox = (id: string, name: string, p: ProjectView, branch: string): WorkspaceView => ({
  id,
  name,
  kind: "cloud",
  machineId: "wsp-landing",
  place: "p_spoo",
  project: ref(p),
  phase: "running",
  golden: "img_1",
  createdAt: AT,
  copy: { road: "clonefile", path: `/root/${p.name}`, source: `/root/${p.name}`, base: "abc", branch, carried: "deps-and-config" },
});

const thread = (id: string, workspaceId: string, prompt: string, over: Partial<SessionView> = {}): SessionView =>
  ({
    id: `s_${id}`,
    workspaceId,
    threadId: id,
    harness: "claude",
    status: "running",
    prompt,
    startedBy: "person",
    startedAt: Date.parse(AT),
    ...over,
  }) as SessionView;

/** The workspace a create answered with, for the creation view's own last line. */
const CREATED_ID = "ws_new";

/** The three screens about a held Bring back, and what each holds the row back with. */
const bringBackScreen = ["bring-back-paused", "bring-back-absent", "bring-back-roadless"].includes(screen);

const WORKSPACES: WorkspaceView[] = [
  inPlace("ws_here", "pricing page", SPOO),
  copyHere("ws_copy", "webhook retries", SPOO, 3100, "agent/webhook-retries"),
  // The box's workspace is stopped on the screen about a machine that is not running, so the row's own state is
  // what holds the verb rather than a flag this page invents.
  { ...onBox("ws_box", "import from stripe", LANDING, "agent/stripe-import"), ...(screen === "bring-back-paused" ? { phase: "napping" as const } : {}) },
  { ...copyHere("ws_fork", "pricing table", SPOO, 3200, "agent/pricing-table"), parentThreadId: "th_lead" },
];
const SESSIONS: Record<string, SessionView[]> = {
  ws_here: [thread("th_quiet", "ws_here", "read the redirect middleware", { status: "completed", endedAt: Date.parse(AT) })],
  ws_copy: [
    thread("th_lead", "ws_copy", "retry the webhook queue"),
    // The lead's agent opened a builder, and the builder's agent a reviewer, which stopped on a question: the tree
    // three deep, with the deepest row the one a person has to act on.
    thread("th_build", "ws_copy", "build the rows", { startedBy: "agent", parentThreadId: "th_lead" } as Partial<SessionView>),
    thread("th_review", "ws_copy", "review the rows", { startedBy: "agent", parentThreadId: "th_build", asking: "Write out review.md in the repo root" } as Partial<SessionView>),
  ],
  ws_box: [thread("th_box", "ws_box", "import the stripe customers")],
  ws_fork: [thread("th_child", "ws_fork", "move the pricing table", { startedBy: "agent", parentThreadId: "th_lead" } as Partial<SessionView>)],
};

/** Six agents on one computer, the list that fills the first run's line to both its lines and is cut there. */
const MANY_AGENTS: InitAgent[] = manyAgents(6);

const GB = 1024 * 1024 * 1024;
/** The agents a joined computer reported, by their catalog ids, which is what the wire carries. */
const REPORTED = CATALOG_AGENTS.map(entry => entry.id);
/** One recipe job on a computer: what it put there, in the three states a row can be read in. */
const provision = (over: Partial<PlaceProvision>): PlaceProvision => ({
  state: "done",
  addId: "a_1",
  recipeAt: AT,
  startedAt: AT,
  finishedAt: AT,
  rows: [
    ...REPORTED.map(id => ({ id: `agents/${id}`, label: agentName(id), outcome: "installed" as const })),
    { id: "tools/gh", label: "GitHub CLI", outcome: "installed" as const },
    { id: "agents/files/skills", label: "code-review", outcome: "installed" as const, kind: "file" as const },
    { id: "agents/mcp/linear", label: "linear", outcome: "installed" as const, kind: "server" as const },
  ],
  ...over,
});
const box = (id: string, name: string, over: Partial<PlaceView>): PlaceView =>
  ({
    id,
    kind: "computer",
    name,
    default: false,
    present: true,
    os: "Ubuntu 24.04",
    shape: { cpu: 4, memMb: 8192 },
    diskFreeBytes: 63 * GB,
    engine: "docker",
    copies: "reflink",
    agents: REPORTED,
    joinedAt: AT,
    lastSeenAt: AT,
    daemonVersion: 40,
    takesForks: true,
    road: { ssh: `root@${name}` },
    dialled: { at: AT, answered: true, roundTripMs: 41 },
    ...over,
  }) as PlaceView;

/** The rows the Computers table draws once this wsp holds more than the computer it runs on: three boxes, one job
 * done, one still running and one that lost two rows, and the cloud account whose key this host holds. */
const COMPUTERS: PlaceView[] = [
  { id: "here", kind: "computer", name: "zingzy-mbp", default: false, present: true, os: "macOS 26.4", shape: { cpu: 10, memMb: 16384 }, diskFreeBytes: 214 * GB, takesForks: false } as PlaceView,
  box("p_spoo", "spoo", { default: true, provision: provision({}) }),
  box("p_dev4", "dev4", { provision: provision({ state: "running", finishedAt: undefined, at: { label: "uv", index: 3, of: 7 } }) }),
  box("p_lab", "lab", {
    provision: provision({
      rows: [
        { id: "tools/gh", label: "GitHub CLI", outcome: "failed", note: "no release for this chip" },
        { id: "tools/uv", label: "uv", outcome: "failed", note: "the script exited 1" },
        // The agent the job could not put on, beside the ones it did: what a person reads on this row is which
        // agent they cannot open a thread with there and why.
        { id: `agents/${REPORTED[1]}`, label: agentName(REPORTED[1]!), outcome: "failed", note: "npm exited 1" },
        ...REPORTED.slice(2).map(id => ({ id: `agents/${id}`, label: agentName(id), outcome: "installed" as const })),
        { id: `agents/${REPORTED[0]}`, label: agentName(REPORTED[0]!), outcome: "installed" as const },
        { id: "tools/node", label: "Node 22 with npm", outcome: "installed" as const },
        { id: "tools/git", label: "git", outcome: "present" as const },
        { id: "agents/files/skills", label: "code-review", outcome: "failed" as const, kind: "file" as const, note: "no home folder for that login" },
        { id: "agents/mcp/linear", label: "linear", outcome: "skipped" as const, kind: "server" as const, note: "waited on GitHub CLI" },
      ],
    }),
  }),
  // A job that ended before its rows did, which the row says in the protocol's own word for it.
  box("p_attic", "attic", { provision: provision({ state: "stopped", finishedAt: undefined, said: "the link dropped" }) }),
  { id: "solari", kind: "provider", name: "solari", default: false, takesForks: true, rateUsdPerHour: 0.11 } as PlaceView,
];

const firstRunScreens = ["first-run", "first-run-refused", "first-run-starting", "first-run-no-agent", "first-run-agents"];
/** The screens that are Settings in the centre rather than a workspace, each by the page it opens on. */
const SETTINGS_SCREENS: Record<string, SettingsAt> = {
  "settings-appearance": { kind: "group", group: "appearance" },
  "settings-restore": { kind: "group", group: "appearance" },
  "settings-light-picked": { kind: "group", group: "appearance" },
  "settings-computers": { kind: "group", group: "computers" },
  "settings-computer": { kind: "computer", id: "p_spoo" },
  "settings-computer-failed": { kind: "computer", id: "p_lab" },
  "settings-this-mac": { kind: "computer", id: "here" },
  "settings-cloud": { kind: "computer", id: "solari" },
  "settings-projects": { kind: "group", group: "projects" },
  "settings-project": { kind: "project", id: "pr_spoo" },
  "settings-devices": { kind: "group", group: "devices" },
  "settings-account": { kind: "group", group: "account" },
  "settings-keybindings": { kind: "group", group: "keybindings" },
  "settings-about": { kind: "group", group: "about" },
  "settings-about-behind": { kind: "group", group: "about" },
  "settings-about-restart": { kind: "group", group: "about" },
  "settings-search": { kind: "group", group: "appearance" },
  "settings-over-panel": { kind: "group", group: "appearance" },
  "settings-add-computer": { kind: "group", group: "computers" },
  "settings-remove-computer": { kind: "computer", id: "p_spoo" },
};
const settingsAt = SETTINGS_SCREENS[screen];
const settings = settingsAt !== undefined;
/** Every computer this host holds on a settings screen: this Mac, three boxes and the cloud whose key it holds. */
const computers = settings ? COMPUTERS : places;
/** The image this host sealed and where it stands, on the cloud's page. */
const IMAGE: SealedImage = {
  name: "default",
  version: 3,
  hash: "a".repeat(63) + "1",
  recipeHash: "recipe-1",
  logins: [{ name: "claude", state: "copied" }, { name: "gh", state: "signed-in" }],
  sealedAt: new Date(Date.parse(AT) - 3 * 3_600_000).toISOString(),
  sealedFrom: "this Mac",
  vault: { sha256: "c".repeat(64), bytes: 4_200, paths: 7, takenAt: AT },
  usedBytes: 1.2 * GB,
};
const IMAGE_COPIES = [
  { place: "spoo", version: 3, hash: IMAGE.hash, snapshotId: "snap_spoo", builtAt: new Date(Date.parse(AT) - 2 * 3_600_000).toISOString(), sizeBytes: 1.2 * GB },
  { place: "solari", version: 2, hash: "b".repeat(63) + "2", snapshotId: "snap_slr", builtAt: new Date(Date.parse(AT) - 26 * 3_600_000).toISOString(), sizeBytes: 1.1 * GB },
];
/** The devices paired with this wsp: a laptop, a phone's browser and this browser, and a running thread's token,
 * which is not a device a person revokes and is not drawn. */
const DEVICES: DeviceView[] = [
  { id: "d_1", name: "zingzy-laptop", createdAt: new Date(Date.now() - 9 * 86_400_000).toISOString(), lastSeenAt: new Date(Date.now() - 12 * 60_000).toISOString() },
  { id: "d_2", name: "Safari on iPhone", createdAt: new Date(Date.now() - 2 * 86_400_000).toISOString(), lastSeenAt: new Date(Date.now() - 3 * 3_600_000).toISOString() },
  { id: "d_3", name: "zingzy-mbp", createdAt: new Date(Date.now() - 30 * 86_400_000).toISOString(), lastSeenAt: new Date().toISOString(), here: true },
  { id: "d_4", name: "a thread's token", createdAt: AT, lastSeenAt: AT, scope: { kind: "thread", workspaceId: "ws_copy", threadId: "th_lead", rootThreadId: "th_lead" } },
];
const drawsSidebar = !firstRunScreens.includes(screen) && screen !== "creating";
/** The screens about the sidebar's shape with fewer records: nothing at all, and one project alone. */
const emptyScreen = screen === "sidebar-empty";
const oneProject = screen === "sidebar-one-project";
/** On a settings screen spoo carries what its own page reads: the branch a workspace starts on, the last agent and
 * what the seed carried. */
const SPOO_RECORDED: ProjectView = settings ? { ...SPOO, base: "main", lastAgent: "claude", seeded: { files: 412, bytes: 3_250_000, memory: "landed", memoryFiles: 3, commits: 9, at: AT } } : SPOO;
const RECORDED: ProjectView[] = emptyScreen ? [] : oneProject ? [SPOO] : [SPOO_RECORDED, WSP, LANDING];

/** The workspaces this screen's store holds, which is also what the fake host answers with: a bind that answered
 * something else would paint over the record the screen is about. */
const HELD: WorkspaceView[] = emptyScreen
  ? []
  : drawsSidebar
    ? // A host that holds no row for a computer holds no workspace standing on it either, since a workspace there
      // is what puts its row on the table: the fresh screens drop the one that stands on the box. The one-project
      // screen keeps spoo's two workspaces of their own and nothing else.
      WORKSPACES.filter(w => w.place === undefined || computers.some(place => place.id === w.place)).filter(w => !oneProject || (w.project.id === SPOO.id && w.parentThreadId === undefined))
    : screen === "creating"
      ? [copyHere(CREATED_ID, "add a LICENSE file", SPOO, 3100, "agent/license")]
      : [];
/** The threads of the workspaces this screen holds and no other. */
const HELD_SESSIONS: Record<string, SessionView[]> = Object.fromEntries(Object.entries(SESSIONS).filter(([workspace]) => HELD.some(w => w.id === workspace)));

const api = {
  subscribe: () => () => {},
  listWorkspaces: async () => HELD,
  listSessions: async () => (drawsSidebar ? Object.values(HELD_SESSIONS).flat() : []),
  watchStatuses: async () => [],
  capabilities: async () => caps({}),
  getGolden: async () => ({ head: null, versions: [] }),
  placesList: async () => computers,
  projectsList: async () => (drawsSidebar ? RECORDED : []),
  workspacesLanding: async (project: string) => landings[project] ?? landings["pr_spoo"]!,
  listHarnesses: async () => [],
  initGet: async () => ({
    keys: { solari: settings },
    home: "/Users/dev",
    agents:
      screen === "first-run-no-agent"
        ? []
        : screen === "first-run-agents"
          ? MANY_AGENTS
          : // This computer's own block: one agent holding the wsp tools and one that could, which are the two
            // states a row here can be read in.
            CATALOG_AGENTS.map((entry, at) => ({ id: entry.id, name: entry.name, configured: at === 0, takesTools: true })),
    pricing: null,
    job: null,
  }),
  // The one screen that records a project: refused by the runtime's own sentence, or still running, or taken.
  projectsAdd: async () => {
    if (screen === "first-run-refused") throw new Error("/Users/dev/notes is not a git repository");
    if (screen === "first-run-starting") return new Promise<ProjectView>(() => {});
    return SPOO;
  },
  // The one road Bring back takes; the screen about a wsp whose host carries no such request has none.
  ...(screen === "bring-back-roadless" ? {} : { bringBack: async () => ({ branch: "agent/stripe-import", base: "main", ahead: 1, uncommitted: 0, stat: [] }) }),
  daemon: { open: () => () => {} },
  spend: async () => (settings ? [{ place: "solari", monthUsd: 1.2, rateUsdPerHour: 0.11 }] : []),
  image: async () => (settings ? { image: IMAGE, copies: IMAGE_COPIES, projects: [] } : { image: null, copies: [], projects: [] }),
  hostTerminalConfig: async () => ({ files: [] }),
  agentsRead: async () => AGENTS_REPORT,
  serversTools: async (_target: unknown, _agent: string, name: string) => SERVER_TOOLS[name] ?? { auth: "open", tools: [], readAt: AGENTS_REPORT.readAt },
  // A sign-in whose tool prints its page at once: a device code for an agent, a page whose answer is pasted back for a server.
  agentsSignIn: async (_target: unknown, agent: string, server: string | undefined, onStep: (step: AgentsSignInEvent) => void) => {
    const url = server === undefined ? "https://auth.openai.com/codex/device" : "https://claude.ai/oauth/authorize?code=true";
    setTimeout(() => onStep({ type: "agents.signIn", signInId: `si_${agent}`, state: "waiting", url, ...(server === undefined ? { code: "ABCD-12345", paste: false } : { paste: true }) }), 30);
    return { signInId: `si_${agent}`, stop: () => {} };
  },
  agentsSignInCode: async () => {},
  agentsKey: async () => {
    throw new Error("That is not a Claude Code token.");
  },
  agentsAddTools: async () => ({ file: "~/.config/opencode/opencode.json" }),
  account: async () => ({ signedIn: false }),
  devicesList: async () => DEVICES,
  devicesRevoke: async () => {},
  // A dial that answers, so a computer's page draws Try now beside when it last answered.
  dialPlace: async (placeId: string) => {
    const place = computers.find(row => row.id === placeId)!;
    return { dialled: { at: new Date().toISOString(), answered: true, roundTripMs: 41 }, line: `${place.name} answered in 41 ms.`, place };
  },
  // The one road the sheet runs: it reports each step in the protocol's own words for it, the way the client does,
  // so no line on the plan says one thing before Add and another after. On the refused screen it answers with
  // ssh's own line instead, which lands in the slot under the field.
  addComputerOverSsh: async (_login: unknown, onStage: (stage: { step: PlaceAddStep; word: string; state: "running" | "done" }) => void) => {
    onStage({ step: "connect", word: placeAddSheetWord("connect", "done"), state: "done" });
    onStage({ step: "host-key", word: placeAddSheetWord("host-key", "done"), state: "done" });
    onStage({ step: "reach", word: placeAddSheetWord("reach", "done"), state: "done" });
    onStage({ step: "wsp", word: placeAddSheetWord("wsp", "running"), state: "running" });
    return new Promise<never>(() => {});
  },
} as unknown as Api;

// The desktop shell's bridge, on the one screen about the foot: the hosts this window can move between, which is
// what draws the row naming the computer it is on. Every other screen is a browser tab and draws no foot row,
// except the two settings screens that read the shell's half: the chords a tab keeps for itself and the app's version.
if (screen === "sidebar-hosts") {
  window.wsp = { hosts: async () => ({ here: hereWord(true), current: null, hosts: [{ alias: "spoo", label: "spoo", url: "wss://spoo.example/ws", road: "ssh" }] }) };
}
if (screen === "settings-keybindings" || screen === "settings-about" || screen === "settings-about-behind" || screen === "settings-about-restart") {
  window.wsp = { version: "0.2.0" };
  (window as unknown as { __WSP__?: { wsPort: number; paired: boolean; version: string } }).__WSP__ = { wsPort: 0, paired: true, version: "0.2.0" };
}
if (screen === "settings-about-behind") {
  const held = window as unknown as { finishBundle?: () => void };
  window.wsp = {
    ...window.wsp,
    hosts: async () => ({ here: hereWord(true), current: null, hosts: [] }),
    getBundle: () => new Promise(resolve => (held.finishBundle = () => resolve({ ok: true }))),
    quitAndOpen: async () => ({ ok: true }),
  };
}

// The switcher's pick is this window's own, so the screen writes it where the sidebar reads it before binding.
const pick = params.get("pick");
if (pick !== null) window.localStorage.setItem("wsp:sidebar-project", JSON.stringify(pick));
const sidebarWidth = params.get("sidebar");
// The page Settings opens on, as this window would remember it, and the one screen with text in the field.
if (settingsAt !== undefined) useSettingsStore.setState({ at: settingsAt, search: screen === "settings-search" ? "width" : "" });
useStore.setState({
  conn: "live",
  ready: true,
  projectsRead: true,
  preferences: { ...DEFAULT_PREFERENCES, ...(sidebarWidth !== null ? { sidebarWidth: Number(sidebarWidth) } : {}), ...(screen === "settings-light-picked" ? { theme: "light" as const } : {}) },
  places: computers,
  settingsOpen: settings,
  addComputerOpen: screen === "settings-add-computer",
  release:
    screen === "settings-about-behind"
      ? { state: "read", latest: { version: "0.3.0", tag: "v0.3.0", url: "https://github.com/Zingzy/wsp/releases/tag/v0.3.0", publishedAt: AT }, checkedAt: AT, triedAt: AT, shape: "app" }
      : screen === "settings-about-restart"
        ? { state: "read", latest: { version: "0.3.0", tag: "v0.3.0", url: "https://github.com/Zingzy/wsp/releases/tag/v0.3.0", publishedAt: AT }, checkedAt: AT, triedAt: AT, installed: "0.3.0", update: "npm i -g @zingzy/wsp@0.3.0", shape: "service" }
        : null,
  projects: drawsSidebar ? RECORDED : [],
  workspaces: HELD,
  landings: drawsSidebar || screen === "creating" ? landings : {},
  sessions: drawsSidebar ? HELD_SESSIONS : {},
  // The screen about Settings over a workspace's panel has that workspace selected; every other opens on none.
  selectedId: screen === "settings-over-panel" ? "ws_copy" : screen === "panel-agents" ? "ws_box" : null,
  selectedThreadId: null,
} as never);
useStore.getState().bind(api);
// A workspace nobody has touched shows an open right panel, which at a phone's width is the whole screen: the
// sidebar and the creation view are what these shots are of, so the panel on every workspace a screen can select
// is shut before the first paint, except on the one screen about the panel coming back after Settings.
const shutPanel = { isOpen: false, activeSurfaceId: null, surfaces: [] };
const openPanel = { isOpen: true, activeSurfaceId: "browser:new", surfaces: [{ id: "browser:new" as const, kind: "preview" as const, resourceId: null }] };
const agentsPanel = { isOpen: true, activeSurfaceId: "agents", surfaces: [{ id: "agents" as const, kind: "agents" as const }] };
useRightPanelStore.setState({
  byWorkspaceId: Object.fromEntries([...HELD.map(w => w.id), CREATED_ID].map(id => [id, screen === "settings-over-panel" && id === "ws_copy" ? openPanel : screen === "panel-agents" && id === "ws_box" ? agentsPanel : shutPanel])),
});

/** The widths the agents manager is measured at: the page's column, its card and a phone's page, and the panel over
 * the widths its tabs change shape at down to its floor. */
const AGENTS_WIDTHS: readonly { shell: AgentsShell; width: number }[] = [
  { shell: "page", width: 760 },
  { shell: "page", width: 696 },
  { shell: "page", width: 358 },
  { shell: "panel", width: 520 },
  { shell: "panel", width: 480 },
  { shell: "panel", width: 380 },
  { shell: "panel", width: 360 },
];
function AgentsWidths() {
  const tools = useServerTools(AGENTS_REPORT.target);
  return (
    <div className="flex flex-col gap-10 bg-background p-4">
      {AGENTS_WIDTHS.map(w => (
        <div key={w.width} data-agents-width={w.width} data-shell={w.shell} className={w.shell === "panel" ? "bg-card" : undefined} style={{ width: w.width }}>
          <AgentsManager
            shell={w.shell}
            head={w.shell === "panel" ? { title: "On spoo, for wsp", line: "Agents, MCP servers and skills this thread can use: global on spoo, plus wsp's own at ~/wsp.", manage: { computer: "spoo", open: () => {} } } : { line: "Agents, MCP servers and skills on spoo." }}
            report={AGENTS_REPORT}
            reading={false}
            on="spoo"
            ctx={{ where: "box", computer: "spoo", project: { name: "wsp", path: "~/wsp" }, ...(tools === undefined ? {} : { tools }) }}
            onRefresh={() => {}}
            now={Date.parse(AGENTS_REPORT.readAt)}
          />
        </div>
      ))}
    </div>
  );
}

/** How the runtime names the computer the host runs on in a line of prose. */
const THIS_COMPUTER_LOWER = "this Mac";

/** The creation view's own log, as the stages arrive. */
const creation = {
  key: "creating:1",
  name: "add a LICENSE file",
  askedAt: Date.parse(AT),
  project: SPOO.id,
  workspaceId: CREATED_ID,
  failed: null,
  // The lines the runtime reports for a create on the computer the host runs on, in its own words rather than words
  // written here: the fork itself, and the last line the word table ends a create with. A workspace that is the
  // folder worked in place lands no project, so those two are the whole log.
  lines: [
    { stage: "fork-requested" as const, message: startingLine("add a LICENSE file", THIS_COMPUTER_LOWER), at: AT, elapsedMs: 0 },
    { stage: "ready" as const, message: CREATE_READY, at: AT, elapsedMs: 900 },
  ],
};

/** The app's own theme rule, mounted on the settings screens so the Theme row's pick moves the page it stands on. */
function ThemeRule() {
  useThemeEffect();
  return null;
}

function Centre() {
  if (screen === "creating") return <WorkspaceCreation creation={creation as never} />;
  if (settings) {
    return (
      <>
        <ThemeRule />
        <SettingsPage />
      </>
    );
  }
  // With no project the first run is the whole centre, as the app draws it, beside the sidebar's one row.
  if (emptyScreen) return <FirstRun />;
  return <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">center content</div>;
}

createRoot(document.getElementById("root")!).render(
  <>
    {screen === "agents-widths" ? (
      <AgentsWidths />
    ) : firstRunScreens.includes(screen) ? (
      <div className="flex h-dvh flex-col">
        <FirstRun />
      </div>
    ) : (
      <AppShell>
        <Centre />
      </AppShell>
    )}
    {screen === "dialog" ? <NewWorkspaceDialog projects={[SPOO, WSP, LANDING]} landings={landings} places={places} picked={null} onCreate={() => {}} onCancel={() => {}} /> : null}
  </>,
);

// The states a person reaches by hand, put in place once the shell is up: the fields the first run was refused
// with, and the collapsed workspace whose forked workspace falls back to its project's list.
const typed = (id: string, value: string): void => {
  const field = document.querySelector<HTMLInputElement>(`[data-k=${id}] input, input[data-k=${id}]`);
  if (field === null) return;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(field, value);
  field.dispatchEvent(new Event("input", { bubbles: true }));
};
setTimeout(() => {
  if (screen === "first-run-refused" || screen === "first-run-starting") {
    typed("folder", "/Users/dev/notes");
    typed("work", "add a README badge");
    setTimeout(() => document.querySelector<HTMLButtonElement>("[data-k=start]")?.click(), 60);
  }
  if (screen === "first-run-no-agent" || screen === "first-run-agents") {
    typed("folder", "/Users/dev/spoo");
    typed("work", "add a README badge");
  }
  // At 390 the sidebar is a sheet that opens after this page does, so the collapse is tried until the row is there.
  if (screen === "sidebar-fallback") {
    const collapse = setInterval(() => {
      const shut = document.querySelector<HTMLButtonElement>('[aria-label="Expand webhook retries"]');
      if (shut !== null) return clearInterval(collapse);
      document.querySelector<HTMLButtonElement>('[aria-label="Collapse webhook retries"]')?.click();
    }, 250);
  }
  if (screen === "dialog") requestNewWorkspace();
  // The row a shot wants open, and the dialog opened from the row that is open: the table is drawn from a read
  // that lands after this page does, so each click is tried until its row is there.
  const clickWhenThere = (css: string, then?: () => void): void => {
    const waiting = setInterval(() => {
      const found = document.querySelector<HTMLElement>(css);
      if (found === null) return;
      clearInterval(waiting);
      found.click();
      then?.();
    }, 120);
  };
  // The row's own menu over the workspace on the box, where Bring back is the row the shot is about.
  if (bringBackScreen) {
    const waiting = setInterval(() => {
      const row = document.querySelector<HTMLElement>('[data-row-id="ws:ws_box"]');
      if (row === null) return;
      clearInterval(waiting);
      const box = row.getBoundingClientRect();
      row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, composed: true, clientX: Math.round(box.left + 80), clientY: Math.round(box.top + 20) }));
    }, 120);
  }
  // The thread three deep, whose row is the lifted one on the filtered screen, and the switcher's menu.
  if (screen === "sidebar-picked") clickWhenThere("[data-row-id='thread:th_review']");
  if (screen === "switcher-open") clickWhenThere("[data-k=project-switcher]");
  if (screen === "settings-remove-computer") clickWhenThere('[data-settings-page] [data-k="remove"]');
}, 400);
