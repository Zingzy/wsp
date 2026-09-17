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
//   creating         the creation view with its stage log
import { createRoot } from "react-dom/client";
import { DEFAULT_PREFERENCES, type Capabilities, type PlaceView, type ProjectView, type SessionView, type WorkspaceLanding, type WorkspaceView } from "@wsp/protocol";
import { AppShell } from "../../src/shell/AppShell";
import { FirstRun } from "../../src/shell/FirstRun";
import { WorkspaceCreation } from "../../src/shell/WorkspaceCreation";
import { NewWorkspaceDialog } from "../../src/sidebar/NewWorkspaceDialog";
import { requestNewWorkspace } from "../../src/shell/shellRequests";
import type { Api } from "../../src/protocol/client";
import { useStore } from "../../src/protocol/store";
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
  { id: "p_spoo", kind: "computer", name: "spoo", default: true, present: true, shape: { cpu: 4, memMb: 8192 }, takesForks: true } as PlaceView,
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

const WORKSPACES: WorkspaceView[] = [
  inPlace("ws_here", "pricing page", SPOO),
  copyHere("ws_copy", "webhook retries", SPOO, 3100, "agent/webhook-retries"),
  onBox("ws_box", "import from stripe", LANDING, "agent/stripe-import"),
  { ...copyHere("ws_fork", "pricing table", SPOO, 3200, "agent/pricing-table"), parentThreadId: "th_lead" },
];
const SESSIONS: Record<string, SessionView[]> = {
  ws_here: [thread("th_quiet", "ws_here", "read the redirect middleware", { status: "completed", endedAt: Date.parse(AT) })],
  ws_copy: [thread("th_lead", "ws_copy", "retry the webhook queue")],
  ws_box: [thread("th_box", "ws_box", "import the stripe customers")],
  ws_fork: [thread("th_child", "ws_fork", "move the pricing table", { startedBy: "agent", parentThreadId: "th_lead" } as Partial<SessionView>)],
};

const firstRunScreens = ["first-run", "first-run-refused", "first-run-starting", "first-run-no-agent"];
const drawsSidebar = !firstRunScreens.includes(screen) && screen !== "creating";

const api = {
  subscribe: () => () => {},
  listWorkspaces: async () => (drawsSidebar ? WORKSPACES : []),
  listSessions: async () => (drawsSidebar ? Object.values(SESSIONS).flat() : []),
  watchStatuses: async () => [],
  capabilities: async () => caps({}),
  getGolden: async () => ({ head: null, versions: [] }),
  placesList: async () => places,
  projectsList: async () => (drawsSidebar ? [SPOO, WSP, LANDING] : []),
  workspacesLanding: async (project: string) => landings[project] ?? landings["pr_spoo"]!,
  listHarnesses: async () => [],
  initGet: async () => ({
    keys: { solari: false },
    home: "/Users/dev",
    agents: screen === "first-run-no-agent" ? [] : [{ id: "claude", name: "Claude Code", configured: true, takesTools: true }],
    pricing: null,
    job: null,
  }),
  // The one screen that records a project: refused by the runtime's own sentence, or still running, or taken.
  projectsAdd: async () => {
    if (screen === "first-run-refused") throw new Error("/Users/dev/notes is not a git repository");
    if (screen === "first-run-starting") return new Promise<ProjectView>(() => {});
    return SPOO;
  },
  daemon: { open: () => () => {} },
} as unknown as Api;

useStore.setState({
  conn: "live",
  ready: true,
  projectsRead: true,
  preferences: { ...DEFAULT_PREFERENCES },
  places,
  projects: drawsSidebar ? [SPOO, WSP, LANDING] : [],
  landings: drawsSidebar ? landings : {},
  workspaces: drawsSidebar ? WORKSPACES : [],
  sessions: drawsSidebar ? SESSIONS : {},
  selectedId: null,
  selectedThreadId: null,
} as never);
useStore.getState().bind(api);

/** The creation view's own log, as the stages arrive. */
const creation = {
  key: "creating:1",
  name: "add a LICENSE file",
  askedAt: Date.parse(AT),
  project: SPOO.id,
  workspaceId: null,
  failed: null,
  lines: [
    { stage: "asked" as const, message: "Asked for a workspace on spoo.", at: AT, elapsedMs: 0 },
    { stage: "copy" as const, message: "Copying the folder beside itself.", at: AT, elapsedMs: 1200 },
    { stage: "ready" as const, message: "Workspace ready.", at: AT, elapsedMs: 2400 },
  ],
};

function Centre() {
  if (screen === "creating") return <WorkspaceCreation creation={creation as never} />;
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
  if (screen === "first-run-no-agent") {
    typed("folder", "/Users/dev/spoo");
    typed("work", "add a README badge");
  }
  if (screen === "sidebar-fallback") document.querySelector<HTMLButtonElement>('[aria-label="Collapse webhook retries"]')?.click();
  if (screen === "dialog") requestNewWorkspace();
}, 400);
