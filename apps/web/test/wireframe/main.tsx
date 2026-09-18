// SPDX-License-Identifier: AGPL-3.0-only
// Served by Vite to a real browser: the app's own components on a fixed store,
// for the screens of the four nouns a live host on one Mac cannot make. A
// workspace on a second computer, a workspace an agent forked, a project
// nobody has started work on and a first run that has been refused are all
// states a person meets and none of them can be staged on the owner's own
// machine, so the real sidebar, the real dialog and the real first run are fed
// records here instead of pixels being drawn by hand.
//
// ?screen=<name> picks one, ?theme=light the light side:
//   sidebar          two projects, three workspaces with all three made-of
//                    lines, a thread that forked a workspace nested under it,
//                    and a project with no workspace yet
//   sidebar-fallback the same with the forking thread's workspace collapsed,
//                    where the forked workspace falls back to its project's list
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
//   computers        Settings on a fresh state: this Mac's row alone, no cloud
//                    row and no price
//   computers-many   the same with three computers joined and a cloud account
//                    whose key this host holds, and the three words a recipe job
//                    reads as on their rows
//   computers-open   one of those boxes open on its agents block
//   computers-here   this Mac's row open on the agents found here
//   computers-failed the box whose recipe lost rows, open on the agent it could
//                    not put on, the file that failed and the server set aside
//   add-computer     the Add a computer sheet, one field, nothing typed
//   add-computer-run the same sheet with the install under way
//   add-computer-refused  the same sheet with what ssh said in the slot
//   remove-computer  the Remove dialog over the table
//   bring-back-paused    the row's menu on a machine that is stopped, with
//                        Bring back held and its reason under the pointer
//   bring-back-absent    the same on a workspace whose computer is not
//                        answering, which says what that computer says
//   bring-back-roadless  the same on a wsp whose host carries no such request
import { createRoot } from "react-dom/client";
import { CATALOG_AGENTS, agentName } from "@wsp/catalog";
import { manyAgents } from "./agents";
import { CREATE_READY, DEFAULT_PREFERENCES, placeAddSheetWord, startingLine, type Capabilities, type InitAgent, type PlaceAddStep, type PlaceProvision, type PlaceView, type ProjectView, type SessionView, type WorkspaceLanding, type WorkspaceView } from "@wsp/protocol";
import { AppShell } from "../../src/shell/AppShell";
import { FirstRun } from "../../src/shell/FirstRun";
import { SettingsPage } from "../../src/settings/SettingsPage";
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
  copy: { road: "in-place", path: p.path, source: p.path, base: "", branch: "", carried: "nothing" },
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
  ws_copy: [thread("th_lead", "ws_copy", "retry the webhook queue")],
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
  box("p_spoo", "spoo", { provision: provision({}) }),
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
/** The screens that are Settings in the centre rather than a workspace: the table, one row open, the sheet and
 * the Remove dialog. */
const computerScreens = ["computers", "computers-many", "computers-open", "computers-here", "computers-failed", "add-computer", "add-computer-run", "add-computer-refused", "remove-computer"];
const settings = computerScreens.includes(screen);
/** Which computers this host holds on this screen: one alone where the table is read fresh, the whole list where
 * it is read with boxes and a cloud on it. */
const manyComputers = ["computers-many", "computers-open", "computers-failed", "remove-computer"].includes(screen);
const computers = settings ? (manyComputers ? COMPUTERS : [COMPUTERS[0]!]) : places;
const drawsSidebar = !firstRunScreens.includes(screen) && screen !== "creating";

/** The workspaces this screen's store holds, which is also what the fake host answers with: a bind that answered
 * something else would paint over the record the screen is about. */
const HELD: WorkspaceView[] = drawsSidebar
  ? // A host that holds no row for a computer holds no workspace standing on it either, since a workspace there
    // is what puts its row on the table: the fresh screens drop the one that stands on the box.
    WORKSPACES.filter(w => w.place === undefined || computers.some(place => place.id === w.place))
  : screen === "creating"
    ? [copyHere(CREATED_ID, "add a LICENSE file", SPOO, 3100, "agent/license")]
    : [];

const api = {
  subscribe: () => () => {},
  listWorkspaces: async () => HELD,
  listSessions: async () => (drawsSidebar ? Object.values(SESSIONS).flat() : []),
  watchStatuses: async () => [],
  capabilities: async () => caps({}),
  getGolden: async () => ({ head: null, versions: [] }),
  placesList: async () => computers,
  projectsList: async () => (drawsSidebar ? [SPOO, WSP, LANDING] : []),
  workspacesLanding: async (project: string) => landings[project] ?? landings["pr_spoo"]!,
  listHarnesses: async () => [],
  initGet: async () => ({
    keys: { solari: manyComputers },
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
  spend: async () => [],
  image: async () => ({ image: null, copies: [] }),
  hostTerminalConfig: async () => ({ files: [] }),
  // The one road the sheet runs: it reports each step in the protocol's own words for it, the way the client does,
  // so no line on the plan says one thing before Add and another after. On the refused screen it answers with
  // ssh's own line instead, which lands in the slot under the field.
  addComputerOverSsh: async (_login: unknown, onStage: (stage: { step: PlaceAddStep; word: string; state: "running" | "done" }) => void) => {
    if (screen === "add-computer-refused") throw new Error("ssh refused the login (publickey).");
    onStage({ step: "connect", word: placeAddSheetWord("connect", "done"), state: "done" });
    onStage({ step: "host-key", word: placeAddSheetWord("host-key", "done"), state: "done" });
    onStage({ step: "wsp", word: placeAddSheetWord("wsp", "running"), state: "running" });
    return new Promise<never>(() => {});
  },
} as unknown as Api;

useStore.setState({
  conn: "live",
  ready: true,
  projectsRead: true,
  preferences: { ...DEFAULT_PREFERENCES },
  places: computers,
  settingsOpen: settings,
  addComputerOpen: ["add-computer", "add-computer-run", "add-computer-refused"].includes(screen),
  projects: drawsSidebar ? [SPOO, WSP, LANDING] : [],
  workspaces: HELD,
  landings: drawsSidebar || screen === "creating" ? landings : {},
  sessions: drawsSidebar ? SESSIONS : {},
  selectedId: null,
  selectedThreadId: null,
} as never);
useStore.getState().bind(api);
// A workspace nobody has touched shows an open right panel, which at a phone's width is the whole screen: the
// creation view is what this shot is of, so the panel on that workspace is shut before the first paint.
if (screen === "creating") useRightPanelStore.setState({ byWorkspaceId: { [CREATED_ID]: { isOpen: false, activeSurfaceId: null, surfaces: [] } } });

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

function Centre() {
  if (screen === "creating") return <WorkspaceCreation creation={creation as never} />;
  if (settings) return <SettingsPage />;
  return <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">center content</div>;
}

createRoot(document.getElementById("root")!).render(
  <>
    {firstRunScreens.includes(screen) ? (
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
  if (screen === "computers-open") clickWhenThere('[data-place-row="p_spoo"]');
  if (screen === "computers-failed") clickWhenThere('[data-place-row="p_lab"]');
  if (screen === "computers-here") clickWhenThere('[data-place-row="here"]');
  if (screen === "remove-computer") clickWhenThere('[data-place-row="p_spoo"]', () => clickWhenThere('[data-k="place-detail"] [data-k="remove"]'));
  if (screen === "add-computer-run" || screen === "add-computer-refused") {
    typed("login", "root@spoo");
    setTimeout(() => document.querySelector<HTMLButtonElement>("[data-k=ssh-add]")?.click(), 60);
  }
}, 400);
