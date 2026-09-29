// SPDX-License-Identifier: AGPL-3.0-only
// New thread from Cmd+T or the palette opens on a project, never inside the
// last workspace: the project the sidebar is filtered to, else the last one
// used. The heading's project name is the project picker, one line under the
// box says where the thread will run, the header reads New thread, and the
// composer's footer carries no project chip and no folder walker. A New thread
// from a workspace's own menu still opens in that workspace.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_PREFERENCES, type HarnessCatalog, type PlaceView, type ProjectView, type WorkspaceView } from "@wsp/protocol";
import { Shell } from "../src/App.js";
import type { Api } from "../src/protocol/client.js";
import { useStore } from "../src/protocol/store.js";
import { useComposerDraftStore } from "../src/components/chat/composerDraftStore.js";
import { useComposerOptionsStore } from "../src/components/chat/composerOptionsStore.js";
import { useMultiPickStore } from "../src/components/chat/composerMultiPick.js";
import { runShellCommand } from "../src/shell/shellCommands.js";
import { onAddProjectRequest } from "../src/shell/shellRequests.js";
import { PROJECT_PICK_KEY } from "../src/sidebar/picks.js";
import { installFakeLayout } from "./fake-layout.js";
import { caps } from "./caps.js";
import { noDaemonApi } from "./fake-daemon-api.js";

const project = (id: string, name: string, computer: string, remote: string): ProjectView => ({
  id,
  name,
  computer,
  source: { kind: "folder", path: `/Users/dev/${name}` },
  path: `/Users/dev/${name}`,
  remote,
  defaultBranch: "main",
  memoryKey: `-${name}`,
  memoryDir: `/Users/dev/.claude/projects/-${name}/memory`,
  createdAt: "t",
});
const WSP = project("pr_wsp", "wsp", "here", "https://github.com/dev/wsp.git");
const SPOO = project("pr_spoo", "py_spoo_url", "here", "https://github.com/dev/py_spoo_url.git");
/** The same repo recorded on another computer: the road `--on spoo` takes today. */
const WSP_ON_SPOO = project("pr_wsp_spoo", "wsp", "pl_spoo", "https://github.com/dev/wsp.git");

const PLACES: PlaceView[] = [
  { id: "here", kind: "computer", name: "here", label: "this Mac", default: true },
  { id: "pl_spoo", kind: "computer", name: "spoo", label: "spoo", default: false },
];

const PLANNER: WorkspaceView = {
  id: "ws_plan",
  name: "Plan batch 10: pull requests",
  machineId: "local",
  project: { id: WSP.id, name: WSP.name, path: WSP.path, computer: "here" },
  phase: "running",
  golden: "",
  createdAt: "2026-09-29T00:00:00Z",
};

const CLAUDE: HarnessCatalog = {
  harness: "claude",
  label: "Claude Code",
  source: "harness",
  version: "2.1.283",
  models: [{ value: "claude-opus-5-5", label: "Opus 5.5", isDefault: true }],
  efforts: [{ value: "low", label: "Low" }, { value: "high", label: "High", isDefault: true }],
  contextWindows: [],
  permissionModes: [{ value: "default", label: "Ask", isDefault: true }, { value: "bypassPermissions", label: "Bypass" }],
  steers: true,
  renames: true,
  images: true,
};

function fakeApi(projects: ProjectView[]): Api {
  return {
    preferences: async () => DEFAULT_PREFERENCES,
    listHarnesses: async () => [CLAUDE],
    portReach: async (_id, port) => ({ url: `https://m1-${port}.preview.example/`, expiresAt: Date.now() + 3_600_000 }),
    daemon: noDaemonApi,
    sessionHistory: async () => [],
    listSnapshots: async () => ({ name: "default", head: null, versions: [] }),
    snapshotStorage: async () => null,
    rollbackSnapshot: async () => ({ lineage: { name: "default", head: null, versions: [] }, existingWorkspaces: "untouched" }),
    listWorkspaces: async () => [PLANNER],
    getWorkspace: async () => PLANNER,
    createWorkspace: async () => PLANNER,
    nap: async () => PLANNER,
    wake: async () => PLANNER,
    capabilities: async () => caps(),
    listSessions: async () => [],
    watchStatuses: async () => [],
    subscribe: () => () => {},
    getGolden: async () => undefined,
    projectsList: async () => projects,
    placesList: async () => ({ places: PLACES, adds: [] }),
    workspacesLanding: async id => ({ ...(id === WSP_ON_SPOO.id ? { place: "pl_spoo" } : {}), name: id === WSP_ON_SPOO.id ? "spoo" : "this Mac", capabilities: caps() }),
    startSession: async o => ({ id: "s1", workspaceId: o.workspaceId, harness: "claude", status: "running" }),
  };
}

let restoreLayout: () => void = () => {};
beforeAll(() => { restoreLayout = installFakeLayout(); });
afterAll(() => restoreLayout());
beforeEach(() => {
  window.localStorage.clear();
  useComposerDraftStore.setState({ drafts: {}, queues: {}, held: {} });
  useComposerOptionsStore.setState({ byWorkspaceId: {}, pickedOn: {} });
  useMultiPickStore.setState({ byKey: {} });
});
afterEach(cleanup);

async function mount(projects: ProjectView[] = [WSP, SPOO]) {
  useStore.setState({ api: null, conn: "live", workspaces: [], statuses: {}, creations: [], sessions: {}, ready: false, selectedId: null, selectedThreadId: null, projectHome: null, freshThread: false, preferences: DEFAULT_PREFERENCES, projects: [], places: [], landings: {} });
  useStore.getState().bind(fakeApi(projects));
  render(<Shell />);
  await waitFor(() => expect(useStore.getState().ready).toBe(true));
  act(() => useStore.setState({ projects, places: PLACES }));
  // The last workspace the person had open: the planner copy the owner pressed Cmd+T over.
  act(() => useStore.getState().select(PLANNER.id));
}

const cmdT = () => act(() => runShellCommand("chat.new", { workspaceId: useStore.getState().selectedId, toggleSidebar: () => {} }, []));
const crumb = () => document.querySelector("[data-thread-breadcrumb]")!.textContent;
const heading = () => screen.getByRole("heading", { level: 1 });
const where = () => document.querySelector<HTMLElement>("[data-new-thread-where]");

describe("New thread from Cmd+T", () => {
  it("with All projects opens the last project used, not the last workspace's thread view", async () => {
    await mount();
    cmdT();
    await waitFor(() => expect(document.querySelector("[data-k=project-home]")).not.toBeNull());
    expect(useStore.getState()).toMatchObject({ selectedId: null, freshThread: false, projectHome: WSP.id });
    expect(heading().textContent).toBe("What should we build in wsp?");
    expect(crumb()).toBe("New thread");
    expect(document.body.textContent).not.toContain("What should we build in Plan batch 10");
  });

  it("with one project filtered in the sidebar opens that project", async () => {
    window.localStorage.setItem(PROJECT_PICK_KEY, JSON.stringify(SPOO.id));
    await mount();
    cmdT();
    await waitFor(() => expect(useStore.getState().projectHome).toBe(SPOO.id));
    expect(heading().textContent).toBe("What should we build in py_spoo_url?");
  });

  it("the heading's project name is the project picker: the projects and Add a project", async () => {
    await mount();
    cmdT();
    const picker = await screen.findByRole("button", { name: "Project: wsp" });
    expect(heading().contains(picker)).toBe(true);
    fireEvent.click(picker);
    const menu = await screen.findByRole("menu");
    expect(within(menu).getAllByRole("menuitemradio").map(item => item.textContent)).toEqual(["wsp", "py_spoo_url"]);
    fireEvent.click(within(menu).getByRole("menuitemradio", { name: "py_spoo_url" }));
    await waitFor(() => expect(useStore.getState().projectHome).toBe(SPOO.id));
    let asked = 0;
    const stop = onAddProjectRequest(() => void (asked += 1));
    fireEvent.click(await screen.findByRole("button", { name: "Project: py_spoo_url" }));
    fireEvent.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: "Add a project" }));
    stop();
    expect(asked).toBe(1);
  });

  it("says under the box where the thread will run, and picking another computer holding the repo is --on", async () => {
    await mount([WSP, SPOO, WSP_ON_SPOO]);
    cmdT();
    await waitFor(() => expect(where()?.textContent).toBe("Runs on this Mac"));
    fireEvent.click(screen.getByRole("button", { name: "Runs on this Mac" }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getAllByRole("menuitemradio").map(item => item.textContent)).toEqual(["this Mac", "spoo"]);
    fireEvent.click(within(menu).getByRole("menuitemradio", { name: "spoo" }));
    await waitFor(() => expect(useStore.getState().projectHome).toBe(WSP_ON_SPOO.id));
    await waitFor(() => expect(where()?.textContent).toBe("Runs on spoo"));
  });

  it("names each computer once, however many clones of the repo it holds", async () => {
    const secondClone = { ...project("pr_wsp_2", "wsp-2", "here", WSP.remote) };
    await mount([WSP, secondClone, SPOO, WSP_ON_SPOO]);
    cmdT();
    fireEvent.click(await screen.findByRole("button", { name: "Runs on this Mac" }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getAllByRole("menuitemradio").map(item => item.textContent)).toEqual(["this Mac", "spoo"]);
    expect(within(menu).getByRole("menuitemradio", { name: "this Mac" }).getAttribute("aria-checked")).toBe("true");
  });

  it("the line is plain words where no other computer holds the repo", async () => {
    await mount();
    cmdT();
    await waitFor(() => expect(where()?.textContent).toBe("Runs on this Mac"));
    expect(where()!.closest("button")).toBeNull();
  });

  it("the box carries model, effort with its brain, attach and send; under it a plain folder, access and branch, and no project chip", async () => {
    await mount();
    cmdT();
    const effort = await waitFor(() => document.querySelector<HTMLElement>('[data-composer-picker="reasoning"]')!);
    const brain = effort.querySelector("svg.lucide-brain")!;
    expect(brain).not.toBeNull();
    expect(brain.getAttribute("class")).toMatch(/(^|\s)size-4(\s|$)/);
    expect(document.querySelector('[data-composer-picker="project"]')).toBeNull();
    expect(screen.queryByText("other folder")).toBeNull();
    const strip = document.querySelector<HTMLElement>("[data-composer-checkout]")!;
    expect(strip.querySelector('[data-composer-picker="access"]')).not.toBeNull();
    const footer = document.querySelector<HTMLElement>("[data-chat-composer-footer]")!;
    expect(footer.querySelector('[data-composer-picker="access"]')).toBeNull();
    const folder = strip.querySelector<HTMLElement>("[data-composer-folder]")!;
    expect(folder.tagName).not.toBe("BUTTON");
    expect(folder.closest("button")).toBeNull();
  });
});

describe("New thread from a workspace's own menu", () => {
  it("opens inside that workspace, and the header still reads New thread, never the workspace's name", async () => {
    await mount();
    act(() => useStore.getState().newThread(PLANNER.id));
    await waitFor(() => expect(useStore.getState()).toMatchObject({ selectedId: PLANNER.id, freshThread: true, projectHome: null }));
    await waitFor(() => expect(crumb()).toBe("New thread"));
    expect(heading().textContent).toBe("What should we build in wsp?");
    expect(document.querySelector('[data-composer-picker="project"]')).toBeNull();
  });
});
