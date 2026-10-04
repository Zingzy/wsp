// SPDX-License-Identifier: AGPL-3.0-only
// New thread from Cmd+T or the palette opens on a project, never inside the
// last workspace: the project the sidebar is filtered to, else the last one
// used, or, where the person asked to pick every time, the palette's page of
// projects. The heading's project name is the project picker, one line under
// the box says where the thread will run, the header reads New thread, and the
// composer's footer carries no project chip and no folder walker. A New thread
// from a workspace's own menu still opens in that workspace. One send starts one
// thread, even where React runs the page's effects twice, as the dev window does.
import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PREFERENCES, type HarnessCatalog, type PlaceView, type Preferences, type ProjectView, type WorkspaceView } from "@wsp/protocol";
import { Shell } from "../src/App.js";
import type { Api, StartSessionOptions } from "../src/protocol/client.js";
import { useStore } from "../src/protocol/store.js";
import { useComposerDraftStore } from "../src/components/chat/composerDraftStore.js";
import { useComposerOptionsStore } from "../src/components/chat/composerOptionsStore.js";
import { useMultiPickStore } from "../src/components/chat/composerMultiPick.js";
import { openCommandPalette } from "../src/commandPaletteBus.js";
import { runShellCommand } from "../src/shell/shellCommands.js";
import { onAddProjectRequest } from "../src/shell/shellRequests.js";
import { PROJECT_PICK_KEY } from "../src/sidebar/picks.js";
import { composerEditor, press, typeInto } from "./composer-harness.js";
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

function fakeApi(projects: ProjectView[], preferences: Preferences): Api {
  return {
    preferences: async () => preferences,
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
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete window.wsp;
});

async function mount(projects: ProjectView[] = [WSP, SPOO], preferences: Preferences = CURRENT) {
  useStore.setState({ api: null, conn: "live", workspaces: [], statuses: {}, creations: [], sessions: {}, ready: false, selectedId: null, selectedThreadId: null, projectHome: null, freshThread: false, preferences, projects: [], places: [], landings: {} });
  useStore.getState().bind(fakeApi(projects, preferences));
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
const palette = () => document.querySelector<HTMLElement>("[data-command-palette]");
const search = () => palette()!.querySelector<HTMLInputElement>("input")!;
const paletteRows = () => [...palette()!.querySelectorAll<HTMLElement>("[data-slot=command-item]")];
const rowTitle = (row: HTMLElement) => row.querySelector("span.truncate")?.textContent;
const projectRows = () => [...palette()!.querySelectorAll<HTMLElement>("[data-palette-group=projects] [data-slot=command-item]")];
const ASK: Preferences = { ...DEFAULT_PREFERENCES, newThreadIn: "ask" };
const CURRENT: Preferences = { ...DEFAULT_PREFERENCES, newThreadIn: "current" };
/** The desktop shell, told apart by the bridge its preload puts on the page; a browser tab keeps the mod digits. */
const asDesktopShell = (): void => void (window.wsp = {});
const modDigit = (n: number) => fireEvent.keyDown(search(), { key: String(n), code: `Digit${n}`, metaKey: true });

describe("New thread from Cmd+T", () => {
  it("with All projects opens the last project used, not the last workspace's thread view", async () => {
    await mount();
    cmdT();
    await waitFor(() => expect(document.querySelector("[data-k=project-home]")).not.toBeNull());
    expect(useStore.getState()).toMatchObject({ selectedId: null, freshThread: false, projectHome: WSP.id });
    expect(heading().textContent).toBe("What should we build in wsp?");
    expect(crumb()).toBe("New thread");
    expect(document.body.textContent).not.toContain("What should we build in Plan batch 10");
    expect(palette()).toBeNull();
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

  it("names the computer the thread will run on as the first item of the one row under the box, and picking another computer holding the repo is --on", async () => {
    await mount([WSP, SPOO, WSP_ON_SPOO]);
    cmdT();
    await waitFor(() => expect(where()?.textContent).toBe("this Mac"));
    const strip = document.querySelector<HTMLElement>("[data-composer-checkout]")!;
    expect(strip.firstElementChild!.contains(where())).toBe(true);
    // The computer's icon is the one the Computers page draws for it, the person's own pick included.
    act(() => useStore.setState(s => ({ preferences: { ...s.preferences, computerLook: { here: { icon: "home" } } } })));
    expect(where()!.querySelector("[data-composer-computer] [data-computer-glyph]")?.getAttribute("data-computer-glyph")).toBe("home");
    expect(document.querySelectorAll("[data-slot=composer-context-strip]")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Runs on this Mac" }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getAllByRole("menuitemradio").map(item => item.textContent)).toEqual(["this Mac", "spoo"]);
    fireEvent.click(within(menu).getByRole("menuitemradio", { name: "spoo" }));
    await waitFor(() => expect(useStore.getState().projectHome).toBe(WSP_ON_SPOO.id));
    await waitFor(() => expect(where()?.textContent).toBe("spoo"));
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

  it("the computer is plain words, no picker, where no other computer holds the repo", async () => {
    await mount();
    cmdT();
    await waitFor(() => expect(where()?.textContent).toBe("this Mac"));
    expect(where()!.closest("button")).toBeNull();
  });

  it("the box carries model, effort with its brain, access, attach and send; under it the computer and branch, no folder path, and no project chip", async () => {
    await mount();
    cmdT();
    const effort = await waitFor(() => document.querySelector<HTMLElement>('[data-composer-picker="reasoning"]')!);
    const brain = effort.querySelector("svg.lucide-brain")!;
    expect(brain).not.toBeNull();
    expect(brain.getAttribute("class")).toMatch(/(^|\s)size-4(\s|$)/);
    expect(document.querySelector('[data-composer-picker="project"]')).toBeNull();
    expect(screen.queryByText("other folder")).toBeNull();
    const strip = document.querySelector<HTMLElement>("[data-composer-checkout]")!;
    expect(strip.querySelector('[data-composer-picker="access"]')).toBeNull();
    const footer = document.querySelector<HTMLElement>("[data-chat-composer-footer]")!;
    expect(footer.querySelector('[data-composer-picker="access"]')).not.toBeNull();
    expect(strip.dataset["composerFolder"]).toBeDefined();
    expect(strip.textContent).not.toContain(strip.dataset["composerFolder"]!);
    expect(strip.querySelector("[data-composer-computer]")).not.toBeNull();
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

describe("New thread when the setting asks every time", () => {
  it("Cmd+T opens the palette on the projects page: each project's glyph, name, computer and folder, and the first nine keyed", async () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    asDesktopShell();
    await mount([WSP, SPOO, WSP_ON_SPOO], { ...ASK, projectLook: { [SPOO.id]: { icon: "rocket", hue: "teal" } } });
    cmdT();
    await waitFor(() => expect(palette()).not.toBeNull());
    expect(useStore.getState()).toMatchObject({ selectedId: PLANNER.id, projectHome: null });
    expect(palette()!.querySelector("[data-palette-group=projects] [data-slot=command-group-label]")?.textContent).toBe("Projects");
    expect(projectRows().map(rowTitle)).toEqual(["wsp", "py_spoo_url", "wsp"]);
    const [here, spoo, there] = projectRows();
    expect(spoo!.querySelector("svg.lucide-rocket")?.getAttribute("data-hue")).toBe("teal");
    expect(here!.querySelector("[data-item-description]")?.textContent).toBe(`this Mac ${WSP.path}`);
    expect(here!.querySelector("[data-item-description] [data-computer-glyph]")).toBeNull();
    expect(there!.querySelector("[data-item-description]")?.textContent).toBe(`spoo ${WSP_ON_SPOO.path}`);
    expect(there!.querySelector("[data-item-description] [data-computer-glyph]")).not.toBeNull();
    expect(projectRows().map(row => row.querySelector("[data-slot=command-shortcut]")?.textContent)).toEqual(["⌘1", "⌘2", "⌘3"]);
    expect(search().getAttribute("placeholder")).toBe("Search projects...");
    expect(palette()!.querySelector("[data-slot=autocomplete-start-addon] svg.lucide-arrow-left")).not.toBeNull();
    expect([...palette()!.querySelectorAll("[data-slot=command-footer] [data-slot=kbd-group] > span")].map(hint => hint.textContent)).toEqual(["Navigate", "Select", "Close"]);
  });

  it("asks for the project by default: Cmd+T on preferences that name no choice opens the projects page", async () => {
    await mount([WSP, SPOO], DEFAULT_PREFERENCES);
    cmdT();
    await waitFor(() => expect(palette()).not.toBeNull());
    expect(projectRows().map(rowTitle)).toEqual(expect.arrayContaining([WSP.name, SPOO.name]));
  });

  it("Cmd and a digit open that row's project while the page is open, and the chord leaves the sidebar's rows alone", async () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    asDesktopShell();
    await mount([WSP, SPOO], ASK);
    cmdT();
    await waitFor(() => expect(palette()).not.toBeNull());
    modDigit(2);
    await waitFor(() => expect(palette()).toBeNull());
    expect(useStore.getState()).toMatchObject({ projectHome: SPOO.id, selectedId: null });
    expect(heading().textContent).toBe("What should we build in py_spoo_url?");
  });

  it("in a browser tab, which keeps Cmd and a digit for its own tabs, the rows offer no key", async () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    await mount([WSP, SPOO], ASK);
    cmdT();
    await waitFor(() => expect(projectRows().map(rowTitle)).toEqual(["wsp", "py_spoo_url"]));
    expect(palette()!.querySelector("[data-slot=command-shortcut]")).toBeNull();
  });

  it("typing narrows the list and Enter opens the highlighted project", async () => {
    await mount([WSP, SPOO], ASK);
    cmdT();
    await waitFor(() => expect(palette()).not.toBeNull());
    fireEvent.change(search(), { target: { value: "spoo" } });
    await waitFor(() => expect(projectRows().map(rowTitle)).toEqual(["py_spoo_url"]));
    fireEvent.keyDown(search(), { key: "Enter" });
    await waitFor(() => expect(palette()).toBeNull());
    expect(useStore.getState().projectHome).toBe(SPOO.id);
  });

  it("the back arrow before the search is a button that goes back to the palette's root", async () => {
    await mount([WSP, SPOO], ASK);
    cmdT();
    await waitFor(() => expect(palette()).not.toBeNull());
    const back = document.querySelector<HTMLButtonElement>("[data-k=palette-back]")!;
    expect(back.getAttribute("aria-label")).toBe("Back");
    fireEvent.click(back);
    await waitFor(() => expect(projectRows()).toEqual([]));
    expect(paletteRows().map(rowTitle)).toEqual(expect.arrayContaining(["New thread in..."]));
  });

  it("Backspace on an empty search goes back to the palette's root, and Esc closes it with nothing opened", async () => {
    await mount([WSP, SPOO], ASK);
    cmdT();
    await waitFor(() => expect(palette()).not.toBeNull());
    fireEvent.change(search(), { target: { value: "w" } });
    fireEvent.keyDown(search(), { key: "Backspace" });
    expect(projectRows().length).toBeGreaterThan(0);
    fireEvent.change(search(), { target: { value: "" } });
    fireEvent.keyDown(search(), { key: "Backspace" });
    await waitFor(() => expect(projectRows()).toEqual([]));
    expect(paletteRows().map(rowTitle)).toEqual(expect.arrayContaining(["New thread", "New thread in..."]));
    expect(search().getAttribute("placeholder")).toBe("Search commands, tasks, and threads...");
    fireEvent.keyDown(search(), { key: "Escape" });
    await waitFor(() => expect(palette()).toBeNull());
    expect(useStore.getState()).toMatchObject({ selectedId: PLANNER.id, projectHome: null });
  });

  it("the sidebar's new thread button asks too", async () => {
    await mount([WSP, SPOO], ASK);
    fireEvent.click(screen.getByRole("button", { name: "New thread" }));
    await waitFor(() => expect(projectRows().map(rowTitle)).toEqual(["wsp", "py_spoo_url"]));
    expect(useStore.getState().projectHome).toBeNull();
  });
});

describe("New thread from the palette", () => {
  const openPalette = () => act(() => openCommandPalette());
  const rowNamed = (title: string) => paletteRows().find(row => rowTitle(row) === title)!;

  it("New thread in... always opens the projects page, and a click on a row opens that project", async () => {
    await mount();
    openPalette();
    await waitFor(() => expect(palette()).not.toBeNull());
    fireEvent.click(rowNamed("New thread in..."));
    await waitFor(() => expect(projectRows().map(rowTitle)).toEqual(["wsp", "py_spoo_url"]));
    fireEvent.click(projectRows()[1]!);
    await waitFor(() => expect(palette()).toBeNull());
    expect(useStore.getState().projectHome).toBe(SPOO.id);
  });

  it("the plain New thread follows the setting: the project you're in opens straight away, Ask every time opens the page", async () => {
    await mount();
    openPalette();
    await waitFor(() => expect(palette()).not.toBeNull());
    fireEvent.click(rowNamed("New thread"));
    await waitFor(() => expect(palette()).toBeNull());
    expect(useStore.getState().projectHome).toBe(WSP.id);
    cleanup();
    await mount([WSP, SPOO], ASK);
    openPalette();
    await waitFor(() => expect(palette()).not.toBeNull());
    fireEvent.click(rowNamed("New thread"));
    await waitFor(() => expect(projectRows().map(rowTitle)).toEqual(["wsp", "py_spoo_url"]));
    expect(useStore.getState().projectHome).toBeNull();
  });
});

describe("New thread's send", () => {
  const MADE: WorkspaceView = { id: "ws_new", name: "what do you think about yams", machineId: "local", project: { id: SPOO.id, name: SPOO.name, path: SPOO.path, computer: "here" }, phase: "running", golden: "", createdAt: "2026-10-03T00:00:00Z" };

  it("starts one thread, even where React runs the page's effects twice", async () => {
    const started: string[] = [];
    const api: Api = {
      ...fakeApi([WSP, SPOO], CURRENT),
      createWorkspace: async () => MADE,
      startSession: async o => {
        started.push(`${o.workspaceId}: ${o.prompt}`);
        return { id: `s${started.length}`, workspaceId: o.workspaceId, harness: "claude", status: "running", prompt: o.prompt, startedAt: 0 };
      },
    };
    useStore.setState({ api: null, conn: "live", workspaces: [], statuses: {}, creations: [], sessions: {}, ready: false, selectedId: null, selectedThreadId: null, projectHome: null, freshThread: false, preferences: CURRENT, projects: [], places: [], landings: {} });
    useStore.getState().bind(api);
    render(
      <StrictMode>
        <Shell />
      </StrictMode>,
    );
    await waitFor(() => expect(useStore.getState().ready).toBe(true));
    act(() => useStore.setState({ projects: [WSP, SPOO], places: PLACES }));
    act(() => useStore.getState().openProjectHome(SPOO.id));
    await waitFor(() => expect(document.querySelector("[data-k=project-home]")).not.toBeNull());
    await typeInto(composerEditor(), "what do you think about yams?");
    await press(composerEditor(), "Enter");
    await waitFor(() => expect(started).not.toEqual([]));
    await act(() => new Promise(r => setTimeout(r, 300)));
    expect(started).toEqual(["ws_new: what do you think about yams?"]);
  });

  it("carries the image the first message was sent with, on the start and on the person's row", async () => {
    const starts: StartSessionOptions[] = [];
    const api: Api = {
      ...fakeApi([WSP, SPOO], CURRENT),
      createWorkspace: async () => MADE,
      startSession: async o => {
        starts.push(o);
        return { id: "s1", workspaceId: o.workspaceId, harness: "claude", status: "running", prompt: o.prompt, startedAt: 0 };
      },
    };
    URL.createObjectURL = vi.fn(() => "blob:wsp/shot");
    URL.revokeObjectURL = vi.fn();
    useStore.setState({ api: null, conn: "live", workspaces: [], statuses: {}, creations: [], sessions: {}, ready: false, selectedId: null, selectedThreadId: null, projectHome: null, freshThread: false, preferences: CURRENT, projects: [], places: [], landings: {} });
    useStore.getState().bind(api);
    render(<Shell />);
    await waitFor(() => expect(useStore.getState().ready).toBe(true));
    act(() => useStore.setState({ projects: [WSP, SPOO], places: PLACES }));
    act(() => useStore.getState().openProjectHome(SPOO.id));
    await waitFor(() => expect(document.querySelector("[data-k=project-home]")).not.toBeNull());
    const png = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])], "shot.png", { type: "image/png" });
    fireEvent.paste(document.querySelector<HTMLElement>("[data-chat-composer-surface]")!, { clipboardData: { files: [png], items: [], getData: () => "" } });
    await waitFor(() => expect(document.querySelectorAll("[data-composer-files] [data-chat-image]")).toHaveLength(1));
    await typeInto(composerEditor(), "what does this show?");
    await press(composerEditor(), "Enter");
    await waitFor(() => expect(starts).toHaveLength(1));
    expect(starts[0]!.attachments).toEqual([{ mediaType: "image/png", bytes: "iVBORw0KGgoBAgME", name: "shot.png" }]);
    await waitFor(() => expect(document.querySelector("[data-chat-image-row=true] [data-chat-image='shot.png'] img")).not.toBeNull());
  });
});
