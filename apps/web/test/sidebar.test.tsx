// SPDX-License-Identifier: AGPL-3.0-only
// The workspace sidebar over the fixture wire: thread tiles from the store's
// workspaces, statuses and sessions; the tree; the Settled fold; search;
// keyboard traversal; the project switcher; the creation tile.
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { cloneElement, createContext, useContext, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PREFERENCES, HOST_ASLEEP_LINE, PROVIDER_UNREACHED_LINE, type PlaceView, type ProjectView, type SessionView, type WorkspaceLook, type WorkspaceStatus, type WorkspaceView } from "@wsp/protocol";
import { onOpenCommandPalette } from "../src/commandPaletteBus.js";
import { SidebarProvider } from "../src/components/ui/sidebar.js";
import { RequestError, type Api } from "../src/protocol/client.js";
import { useStore } from "../src/protocol/store.js";
import { placeName } from "../src/settings/places.js";
import { statusOf } from "./workspace-status.js";
import { onNewThreadRequest, requestNewWorkspace } from "../src/shell/shellRequests.js";
import { WorkspaceSidebar } from "../src/sidebar/WorkspaceSidebar.js";
import { useSettingsStore } from "../src/settings/settingsStore.js";
import { COMPUTER_SWITCHER_WORDS, NEW_WORKSPACE, PROJECT_WORDS, SWITCHER_WORDS } from "../src/sidebar/words.js";
import { caps } from "./caps.js";
import { noDaemonApi } from "./fake-daemon-api.js";
import { WorkspaceTerminals, provideTerminals } from "../src/terminal/link.js";
import { clearNotices, lastNotice } from "./notice-text.js";

// The triggers keep their elements, and no popup mounts: this file focuses and
// clicks the search row, and Base UI's positioning against jsdom's zero-size
// rects costs seconds per open. The tooltip's own text is covered in
// search-row.test.tsx, where the popup renders inline.
vi.mock("../src/components/ui/tooltip.js", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ render: element, children }: { render?: ReactElement<{ children?: ReactNode }>; children?: ReactNode }) =>
    element === undefined ? <>{children}</> : cloneElement(element, {}, children ?? element.props.children),
  TooltipPopup: () => null,
}));

// The switcher's menu on a plain open/closed context: Base UI's popover never settles under jsdom. The trigger
// keeps its element and its props, so the head is the real row.
vi.mock("../src/components/ui/popover.js", () => {
  const Ctx = createContext<{ open: boolean; set: (open: boolean) => void }>({ open: false, set: () => {} });
  const Popover = ({ children, open, onOpenChange }: { children: ReactNode; open: boolean; onOpenChange: (open: boolean) => void }) => <Ctx.Provider value={{ open, set: onOpenChange }}>{children}</Ctx.Provider>;
  const PopoverTrigger = ({ children, render: element, disabled, ...props }: { children: ReactNode; render: ReactElement<Record<string, unknown>>; disabled?: boolean; [key: string]: unknown }) => {
    const ctx = useContext(Ctx);
    return cloneElement(element, { ...props, disabled, onClick: () => ctx.set(!ctx.open) }, children);
  };
  const PopoverPopup = ({ children }: { children: ReactNode }) => (useContext(Ctx).open ? <div role="dialog" data-slot="popover-popup">{children}</div> : null);
  return { Popover, PopoverTrigger, PopoverPopup };
});

const NOW = Date.now();
const iso = (offsetMs: number) => NOW + offsetMs;

// The rows stand in the order the workspaces were made, so a test that reads the list by position says how long
// ago each of its own was; an hour is the default, and workspaces sharing it fall to their ids.
const view = (id: string, name: string, phase: WorkspaceView["phase"] = "running", createdAgoMs = 60 * 60_000): WorkspaceView => ({
  id,
  name,
  machineId: `m_${id}`, project: { id: "pr_1", name: "the-project", path: "/root", computer: "default" },
  phase,
  golden: "snap_g",
  createdAt: new Date(NOW - createdAgoMs).toISOString(),
});

const status = statusOf;

const session = (id: string, workspaceId: string, over: Partial<SessionView> = {}): SessionView => ({
  id,
  workspaceId,
  harness: "claude",
  status: "running",
  ...over,
});

type FakeApi = Api & {
  createWorkspace: ReturnType<typeof vi.fn>;
  rebuild: ReturnType<typeof vi.fn>;
  forget: ReturnType<typeof vi.fn>;
  watchStatuses: ReturnType<typeof vi.fn>;
};

function fakeApi(workspaces: WorkspaceView[], statuses: WorkspaceStatus[], sessions: SessionView[] = []): FakeApi {
  return {
    listWorkspaces: vi.fn(async () => workspaces),
    // Two rows: this computer, which is never somewhere to put a workspace, and the provider this host forks on,
    // which is the row the New workspace dialog checks.
    placesList: vi.fn(async () => ({ places: PLACES, adds: [] })),
    projectsList: vi.fn(async () => PROJECTS),
    getWorkspace: vi.fn(async id => workspaces.find(w => w.id === id)!),
    createWorkspace: vi.fn(async (_project: string, name: string) => view("ws_new", name)),
    watchStatuses: vi.fn(async () => statuses),
    nap: vi.fn(async (id: string) => view(id, "?", "napping")),
    wake: vi.fn(async (id: string) => view(id, "?", "running")),
    rebuild: vi.fn(async (id: string) => ({ ...view(id, "?", "running"), machineId: "m_rebuilt" })),
    forget: vi.fn(async (_id: string) => {}),
    capabilities: vi.fn(async () => (caps())),
    startSession: vi.fn(async (o: { workspaceId: string }) => session("s_x", o.workspaceId)),
    portReach: vi.fn(async (_id: string, port: number) => ({ url: `https://m1-${port}.preview.example/?pt_token=e`, expiresAt: NOW + 3_600_000 })),
    daemon: noDaemonApi,
    sessionHistory: vi.fn(async () => []),
    listSnapshots: vi.fn(async () => ({ name: "default", head: null, versions: [] })),
    snapshotStorage: async () => null,
    rollbackSnapshot: vi.fn(async () => ({ lineage: { name: "default", head: null, versions: [] }, existingWorkspaces: "untouched" as const })),
    listSessions: vi.fn(async () => sessions),
    subscribe: vi.fn(() => () => {}),
    // The rows here are forks of a golden, so one is sealed; first-run.test.tsx covers the sidebar with none.
    getGolden: async () => ({ head: 1, versions: [{ version: 1, snapshotId: "snap_g", baseTemplate: "t", setupSha: "s", createdAt: "c", smoke: { cmd: "true", exitCode: 0 } }] }),
    // The look sits on the record beside the name, so the fixture writes it there and answers with the row.
    setWorkspaceLook: vi.fn(async (id: string, look: WorkspaceLook) => {
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
    }),
  };
}

const PLACES: PlaceView[] = [
  { id: "here", kind: "computer", name: "studio.local", default: false, engine: "none", present: true, takesForks: false },
  { id: "box", kind: "provider", name: "box", default: true, rateUsdPerHour: 0.018, takesForks: true },
];
/** What the dialog makes a workspace of: one project on the computer these tests fork at. */
const PROJECTS: ProjectView[] = [
  { id: "pr_1", name: "spoo-landing", computer: "box", source: { kind: "git", url: "https://github.com/dev/spoo.git" }, path: "/root/spoo-landing", remote: "https://github.com/dev/spoo.git", defaultBranch: "main", memoryKey: "-root-spoo-landing", memoryDir: "/var/lib/wsp/projects/pr_1/memory", createdAt: "t" },
];
/** What a row calls the provider these tests fork at, through the one rule every surface names a computer by. */
const BOX_NAME = placeName(PLACES[1]!);
/** A second project, on this computer, for the cases about the switcher and the tree over two projects. */
const HERE_PROJECT: ProjectView = { id: "pr_2", name: "wsp", computer: "here", source: { kind: "folder", path: "/Users/dev/wsp" }, path: "/Users/dev/wsp", remote: "https://github.com/dev/wsp.git", defaultBranch: "main", memoryKey: "-Users-dev-wsp", memoryDir: "/Users/dev/.claude-cfg/projects/-Users-dev-wsp/memory", createdAt: "t" };

beforeEach(() => {
  window.localStorage.clear();
  useStore.setState({ places: [], projects: [], placesRefused: null, projectsRefused: null, api: null, conn: "live", capabilities: null, workspaces: [], statuses: {}, costs: {}, spending: {}, selectedId: null, selectedThreadId: null, projectHome: null, creations: [], sessions: {}, launches: {}, ready: false, preferences: { ...DEFAULT_PREFERENCES, labs: true }, settingsOpen: false });
  clearNotices();
});

async function mount(api: FakeApi, firstName: string) {
  useStore.getState().bind(api);
  render(
    <SidebarProvider defaultOpen>
      <WorkspaceSidebar />
    </SidebarProvider>,
  );
  await waitFor(() => expect(screen.getByText(firstName)).toBeDefined());
  return api;
}

const rowOf = (text: string): HTMLElement => screen.getByText(text).closest<HTMLElement>("[data-sidebar-row]")!;
const rowIds = () => Array.from(document.querySelectorAll<HTMLElement>("[data-sidebar-row]")).map(r => r.dataset["rowId"]);
const statusSlot = (row: HTMLElement): HTMLElement | null => row.querySelector<HTMLElement>("[data-thread-status]");
/** A thread row's state word, which a toned status slot carries (a working one for screen readers, beside its time);
 * null on a row at rest. */
const threadState = (row: HTMLElement): string | null => {
  const slot = statusSlot(row);
  return slot?.dataset["tone"] === undefined ? null : (slot.querySelector("span")?.textContent ?? null);
};
/** A thread row's age, which stands in the slot only once the thread rests; null while a state holds it. */
const threadTime = (row: HTMLElement): string | null => {
  const slot = statusSlot(row);
  return slot === null || slot.dataset["tone"] !== undefined ? null : slot.textContent;
};
const depthOf = (row: HTMLElement): number => Number(row.dataset["depth"]);
const head = (): HTMLButtonElement => document.querySelector<HTMLButtonElement>("[data-k=project-switcher]")!;
const menu = (): HTMLElement | null => document.querySelector<HTMLElement>("[data-project-switcher-menu]");

const API = view("ws_a", "api");
const WEB = view("ws_b", "web", "napping");
/** The same workspace as a copy on a branch, which is what gives its row a second line. */
const COPIED = { ...API, copy: { road: "clonefile" as const, path: "/Users/dev/spoo-api", source: "/Users/dev/spoo", base: "abc", branch: "agent/api-port-list", carried: "deps-and-config" as const } };

describe("header", () => {
  it("carries the brand lockup named wsp", async () => {
    useStore.getState().bind(fakeApi([], []));
    await act(async () => {
      render(
        <SidebarProvider defaultOpen>
          <WorkspaceSidebar />
        </SidebarProvider>,
      );
    });
    expect(screen.getByRole("img", { name: "wsp" })).toBeTruthy();
  });

  it("the header row starts at the frame inset with the toggle, the lockup follows it, and the search row shares the content inset", async () => {
    useStore.getState().bind(fakeApi([], []));
    await act(async () => {
      render(
        <SidebarProvider defaultOpen>
          <WorkspaceSidebar />
        </SidebarProvider>,
      );
    });
    const lockup = screen.getByRole("img", { name: "wsp" });
    const row = lockup.parentElement!;
    expect(row.getAttribute("data-slot")).toBe("sidebar-header");
    expect(row.className).toContain("pl-[var(--header-frame-inset)]");
    expect(row.className).toContain("gap-[calc(var(--header-gap)-var(--workspace-titlebar-control-size)/2)]");
    expect(lockup.previousElementSibling!.getAttribute("data-slot")).toBe("sidebar-trigger");
    expect(screen.getByRole("button", { name: "Search" }).closest("[data-sidebar-search]")!.className).toContain("px-[var(--sidebar-content-inset)]");
  });
});

describe("tiles from the fixture wire", () => {
  it("every root thread is a tile titled by its prompt, newest first across every workspace, with where it runs and its status in row one", async () => {
    await mount(
      fakeApi(
        [API, WEB],
        [status(API), status(WEB)],
        [
          session("s1", "ws_a", { prompt: "fix the port list", startedAt: iso(-3 * 60_000) }),
          session("s2", "ws_a", { status: "completed", prompt: "upgrade node", startedAt: iso(-60 * 60_000), endedAt: iso(-50 * 60_000) }),
          session("s3", "ws_b", { status: "failed", claudeSessionId: "59094224-bb3d", startedAt: iso(-20 * 60_000), endedAt: iso(-19 * 60_000) }),
        ],
      ),
      "fix the port list",
    );
    expect(rowIds()).toEqual(["thread:s1", "thread:s3", "thread:s2"]);
    expect(rowOf("fix the port list").querySelector("[data-tile-where]")!.textContent).toBe(`the-project @ ${BOX_NAME}`);
    // The one slot at row one's right edge: the state word while a thread is one a person acts on, the age once it rests.
    expect(threadState(rowOf("fix the port list"))).toBe("Working");
    expect(threadTime(rowOf("upgrade node"))).toBe("50m");
    // A session without a prompt falls back to the harness session id.
    expect(threadState(rowOf("59094224-bb3d"))).toBe("Failed");
    expect(screen.queryByText(/Settled/i)).toBeNull();
    expect(document.querySelector("[data-sidebar-tree]")!.textContent).not.toMatch(/[·•]/);
  });

  it("a thread stopped on a permission prompt says Needs you, and goes back to working when it is answered", async () => {
    const asking = "Permission for Bash: Check wsp version";
    await mount(fakeApi([API], [status(API)], [session("s1", "ws_a", { prompt: "fix the port list", startedAt: iso(-3 * 60_000), asking })]), "fix the port list");
    expect(threadState(rowOf("fix the port list"))).toBe("Needs you");
    expect(rowOf("fix the port list").getAttribute("title")).toContain(asking);
    act(() => useStore.setState({ sessions: { ws_a: [session("s1", "ws_a", { prompt: "fix the port list", startedAt: iso(-3 * 60_000) })] } }));
    await waitFor(() => expect(threadState(rowOf("fix the port list"))).toBe("Working"));
  });

  it("every tile's row three leads with the agent's own mark in its colour at 12 px, and its hover names the title, where it runs and the agent", async () => {
    await mount(
      fakeApi([API], [status(API)], [session("s1", "ws_a", { prompt: "fix the port list", startedBy: "cli", startedAt: iso(-60_000) }), session("s2", "ws_a", { prompt: "upgrade node", harness: "codex", startedAt: iso(-120_000) })]),
      "fix the port list",
    );
    const markOf = (title: string) => rowOf(title).children[2]!.querySelector("[data-harness-mark]")!;
    expect(markOf("fix the port list").getAttribute("data-harness-mark")).toBe("claude");
    expect([...markOf("fix the port list").classList]).toContain("size-3");
    expect([...markOf("fix the port list").classList]).toContain("text-(--ink-0)");
    expect(markOf("upgrade node").getAttribute("data-harness-mark")).toBe("codex");
    expect(rowOf("fix the port list").getAttribute("title")).toBe(`fix the port list\nthe-project @ ${BOX_NAME}\nClaude Code`);
    expect(rowOf("upgrade node").getAttribute("title")).toBe(`upgrade node\nthe-project @ ${BOX_NAME}\nCodex`);
    // The agent is its mark alone on the face, never its name, and no opener word.
    expect(rowOf("fix the port list").textContent).not.toMatch(/Claude Code|cli|you/);
  });

  it("clicking a thread selects it; a workspace with no thread is a tile of its own that selects it with no thread pinned", async () => {
    await mount(fakeApi([API, WEB], [status(API), status(WEB)], [session("s1", "ws_b", { prompt: "hello", threadId: "thr_1", startedAt: iso(-60_000) })]), "hello");
    expect(rowIds()).toEqual(["thread:thr_1", "ws:ws_a"]);
    fireEvent.click(rowOf("hello"));
    expect(useStore.getState()).toMatchObject({ selectedId: "ws_b", selectedThreadId: "thr_1" });
    expect(rowOf("hello").getAttribute("data-active")).toBe("true");
    fireEvent.click(rowOf("api"));
    expect(useStore.getState()).toMatchObject({ selectedId: "ws_a", selectedThreadId: null });
    expect(rowOf("api").getAttribute("data-active")).toBe("true");
    expect(rowOf("hello").getAttribute("data-active")).toBe("false");
  });

  it("clicking a tile whose thread has no id selects its workspace with no thread pinned, and that tile is the one lifted", async () => {
    await mount(fakeApi([API, WEB], [status(API), status(WEB)], [session("s1", "ws_b", { prompt: "before threads" })]), "before threads");
    fireEvent.click(rowOf("before threads"));
    expect(useStore.getState()).toMatchObject({ selectedId: "ws_b", selectedThreadId: null });
    expect(rowOf("before threads").getAttribute("data-active")).toBe("true");
  });

  it("an empty fleet says so; a refused status read is a notice, never a line in the sidebar", async () => {
    const api = fakeApi([], []);
    api.watchStatuses = vi.fn(async () => { throw new Error("runtime unreachable"); });
    useStore.getState().bind(api);
    render(<SidebarProvider defaultOpen><WorkspaceSidebar /></SidebarProvider>);
    await waitFor(() => expect(screen.getByText(/No tasks yet/)).toBeDefined());
    await waitFor(() => expect(lastNotice()).toBe("Live status is not coming from the host: runtime unreachable"));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("a refused project list says so where New project would stand", async () => {
    const api = fakeApi([], []);
    api.projectsList = async () => { throw new RequestError("projects.json is not valid JSON"); };
    useStore.getState().bind(api);
    render(<SidebarProvider defaultOpen><WorkspaceSidebar /></SidebarProvider>);
    const line = await waitFor(() => {
      const found = document.querySelector<HTMLElement>("[data-k='projects-refused']");
      expect(found).not.toBeNull();
      return found!;
    });
    expect(line.textContent).toBe("Projects not read: projects.json is not valid JSON");
    expect(document.querySelector("[data-k='new-project']")).toBeNull();
  });
});

describe("new thread", () => {
  it("the compose glyph raises a new-thread request for the selected workspace; no tile carries a plus of its own", async () => {
    await mount(fakeApi([API, WEB], [status(API), status(WEB)], [session("s1", "ws_a", { prompt: "hello" })]), "hello");
    const seen: string[] = [];
    const off = onNewThreadRequest(d => seen.push(d.workspaceId));
    const compose = screen.getByRole("button", { name: "New thread" });
    act(() => useStore.getState().select(null));
    // Held by aria-disabled rather than the disabled attribute, so the pointer still reaches it and its tooltip
    // can say what it is in the one state a person might ask.
    expect(compose.getAttribute("aria-disabled")).toBe("true");
    expect(compose.hasAttribute("disabled")).toBe(false);
    expect(compose.className).not.toContain("pointer-events-none");
    fireEvent.click(compose);
    fireEvent.click(rowOf("web"));
    expect(useStore.getState().selectedId).toBe("ws_b");
    expect(compose.getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(compose);
    expect(seen).toEqual(["ws_b"]);
    expect(document.querySelectorAll("[data-sidebar-tree] svg.lucide-plus")).toHaveLength(0);
    off();
  });

  it("a send in flight is a tile of its own at the top, so a workspace running the first message never reads that it has none", async () => {
    await mount(fakeApi([API, WEB], [status(API), status(WEB)], [session("s1", "ws_a", { prompt: "hello" })]), "hello");
    // The transcript draws the sent message the moment it is sent; the runtime writes a row only once the agent
    // announces itself, which is seconds later.
    act(() => useStore.setState({ launches: { ws_b: { requestId: "r1", title: "read the port list", harness: "claude" } } }));
    const launched = document.querySelector<HTMLElement>("[data-thread-launch]")!;
    expect(launched.closest("li")!.previousElementSibling).toBeNull();
    expect(launched.querySelector("[data-thread-title]")?.textContent).toBe("read the port list");
    expect(launched.querySelector("[data-tile-where]")!.textContent).toBe(`the-project @ ${BOX_NAME}`);
    expect(threadState(launched)).toBe("Working");
    // The runtime has stamped no start yet, so the time counts from the send.
    expect(statusSlot(launched)!.querySelector("[aria-hidden]")!.textContent).toBe("0s");
    expect(launched.querySelector('svg[data-harness-mark="claude"]')).not.toBeNull();
    expect(launched.querySelector("canvas[data-crab]")).not.toBeNull();
    expect(launched.className).toContain("h-[68px]");
    expect(document.querySelectorAll("[data-thread-launch]")).toHaveLength(1);
  });
});

describe("search", () => {
  it("the row is the palette's door: a plain row with a glyph and the word Search, no chord, no fill and no hairline, and the compose glyph alone at the right edge; a click opens the palette, focus alone does not, and no field ever appears", async () => {
    await mount(fakeApi([API, WEB], [status(API), status(WEB)], [session("s1", "ws_a", { prompt: "hello" })]), "hello");
    const opened: boolean[] = [];
    const off = onOpenCommandPalette(detail => opened.push(detail.toggle === true));
    const row = screen.getByRole("button", { name: "Search" });
    expect(row.querySelector("svg.lucide-search")).not.toBeNull();
    expect(row.textContent).toBe("Search");
    expect(row.querySelector("kbd")).toBeNull();
    const compose = screen.getByRole("button", { name: "New thread" });
    expect(compose.closest("[data-sidebar-search]")).not.toBeNull();
    expect(compose.querySelector("svg.lucide-square-pen")).not.toBeNull();
    expect(row.contains(compose)).toBe(false);
    expect(row.className).toContain("pe-8");
    // The row is the kit's row and nothing more: no fill, no ring, no hairline of its own, the hover tint every other row has.
    expect(row.className).not.toMatch(/(^|\s)(bg-sidebar-row-selected|border-sidebar-border|ring-1|bg-background|bg-sidebar-control-surface)(\s|$)/);
    expect(row.className).toContain("hover:bg-sidebar-row-hover");
    expect(row.className).toContain("h-9");
    // The head sits under it in the same fixed header, over the tree.
    expect(head().closest("[data-sidebar-search]")).not.toBeNull();
    expect(head().closest("[data-slot=sidebar-content]")).toBeNull();
    const before = rowIds();
    // A real button: Tab onto it only focuses it; Enter and Space are the browser's own click, so the click is what opens.
    expect(row.tagName).toBe("BUTTON");
    act(() => row.focus());
    expect(document.activeElement).toBe(row);
    fireEvent.keyDown(row, { key: "Tab" });
    expect(opened).toEqual([]);
    fireEvent.click(row);
    expect(opened).toEqual([false]);
    expect(document.querySelector("input")).toBeNull();
    expect(screen.getByRole("button", { name: "Search" })).toBe(row);
    expect(rowIds()).toEqual(before);
    off();
  });
});

describe("the body before the first list has arrived, and on a wsp with no project", () => {
  it("says nothing at all while the store is not ready: no rows, no bars, not even the road to a project, and the head held", () => {
    render(<SidebarProvider defaultOpen><WorkspaceSidebar /></SidebarProvider>);
    expect(screen.queryByText(/No tasks yet/)).toBeNull();
    expect(rowIds()).toEqual([]);
    expect(document.querySelectorAll("[data-slot=skeleton]").length).toBe(0);
    expect(screen.queryByText(PROJECT_WORDS.add)).toBeNull();
    expect(screen.queryByText(PROJECT_WORDS.new)).toBeNull();
    expect(head().disabled).toBe(true);
    expect(head().textContent).toBe(SWITCHER_WORDS.all);
  });

  it("holds the head, held, and one row that opens Add a project once the lists have arrived and hold nothing: no sentence", async () => {
    render(<SidebarProvider defaultOpen><WorkspaceSidebar /></SidebarProvider>);
    act(() => useStore.setState({ ready: true, projectsRead: true }));
    const row = await screen.findByText(PROJECT_WORDS.new);
    expect(row.closest("button")!.dataset["k"]).toBe("new-project");
    expect(row.closest("button")!.className).toContain("h-9");
    expect(row.closest("button")!.querySelector("svg.lucide-plus")).not.toBeNull();
    expect(head().disabled).toBe(true);
    fireEvent.click(head());
    expect(menu()).toBeNull();
    // The empty line belongs to a project with no workspace; with no project at all the centre is the first run,
    // whose title says what is being made, so no second sentence stands here.
    expect(screen.queryByText(/No tasks yet/)).toBeNull();
    expect(screen.queryByText(/No projects yet/)).toBeNull();
    expect(screen.queryByText(/A project is a folder/)).toBeNull();
    expect(screen.queryByText(PROJECT_WORDS.add)).toBeNull();
    expect(rowIds()).toEqual([]);
    // The compose glyph stands, held: there is no workspace to open a thread in.
    expect(screen.getByRole("button", { name: "New thread" }).getAttribute("aria-disabled")).toBe("true");
    // Pressing the row opens the same Add a project dialog the first run's button opens.
    expect(document.querySelector("[data-k=add-project]")).toBeNull();
    fireEvent.click(row);
    await waitFor(() => expect(document.querySelector("[data-k=add-project]")).not.toBeNull());
  });

  it("a creation on its way holds the empty state off while the list is still coming", () => {
    render(<SidebarProvider defaultOpen><WorkspaceSidebar /></SidebarProvider>);
    act(() => useStore.setState({ creations: [{ key: "creating:1", name: "beta", askedAt: Date.now(), workspaceId: null, lines: [], failed: null }] }));
    expect(screen.getByText("beta")).toBeDefined();
    expect(screen.queryByText(/No tasks yet/)).toBeNull();
    expect(screen.queryByText(PROJECT_WORDS.new)).toBeNull();
  });
});

describe("keyboard navigation", () => {
  it("arrows walk every tile in order from the search row; Enter selects", async () => {
    await mount(fakeApi([API, WEB], [status(API), status(WEB)], [session("s1", "ws_a", { prompt: "hello", startedAt: iso(-60_000) })]), "hello");
    const search = screen.getByRole("button", { name: "Search" });
    act(() => search.focus());
    fireEvent.keyDown(search, { key: "ArrowDown" });
    expect(document.activeElement).toBe(rowOf("hello"));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(rowOf("web"));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(rowOf("web"));
    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    expect(document.activeElement).toBe(rowOf("hello"));
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(document.activeElement).toBe(rowOf("web"));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
    expect(document.activeElement).toBe(rowOf("hello"));
    fireEvent.click(document.activeElement!);
    expect(useStore.getState().selectedId).toBe("ws_a");
  });

  it("ArrowDown on the head opens the menu and moves no row focus; Escape shuts it and puts focus back on the head", async () => {
    await mount(fakeApi([API], [status(API)]), "api");
    act(() => head().focus());
    fireEvent.keyDown(head(), { key: "ArrowDown" });
    expect(menu()).not.toBeNull();
    expect(document.activeElement).not.toBe(rowOf("api"));
    fireEvent.keyDown(menu()!, { key: "Escape" });
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(head());
  });
});

describe("Solari out of reach from this computer", () => {
  it("a status whose probe never left this computer puts one muted mono line under the search row, and the line goes when a probe gets out again", async () => {
    await mount(fakeApi([API, WEB], [status(API), status(WEB)]), "api");
    expect(screen.queryByText(PROVIDER_UNREACHED_LINE)).toBeNull();
    act(() => useStore.getState().applyEvent({ type: "workspace.status", status: status(API, { reach: { state: "reachable", offline: true } }) }));
    const line = await screen.findByText(PROVIDER_UNREACHED_LINE);
    expect(line.closest("[data-sidebar-search]")).not.toBeNull();
    expect(line.className).toContain("font-mono");
    expect(line.className).not.toMatch(/border|bg-|badge|chip|destructive|warning|success/);
    expect(rowOf("api").textContent).not.toContain("Unreachable");
    // The line reads once, however many workspaces carry the flag.
    act(() => useStore.getState().applyEvent({ type: "workspace.status", status: status(WEB, { reach: { state: "napping", offline: true } }) }));
    expect(screen.getAllByText(PROVIDER_UNREACHED_LINE)).toHaveLength(1);
    act(() => useStore.getState().applyEvent({ type: "workspace.status", status: status(API) }));
    act(() => useStore.getState().applyEvent({ type: "workspace.status", status: status(WEB) }));
    await waitFor(() => expect(screen.queryByText(PROVIDER_UNREACHED_LINE)).toBeNull());
  });

  it("keeps the slot under the search row for the host's own two lines, never a workspace's link", async () => {
    await mount(fakeApi([API, WEB], [status(API), status(WEB)]), "api");
    // The workspace on screen has a link that nothing has answered on. Its sentence belongs to the pane that
    // asked and to the composer under the box, both of which sit beside the workspace they name.
    const wt = new WorkspaceTerminals({ request: async () => ({ ok: true }) });
    act(() => {
      wt.feedStatus("unanswered");
      provideTerminals(API.id, wt);
    });
    await waitFor(() => expect(rowOf("api")).toBeDefined());
    const slot = document.querySelector("[data-sidebar-search]")!;
    expect(slot.querySelector("[data-sidebar-link-down]")).toBeNull();
    expect(slot.textContent).not.toContain("Nothing has answered");
    provideTerminals(API.id, null);
    act(() => useStore.getState().applyEvent({ type: "workspace.status", status: status(API, { reach: { state: "reachable", offline: true } }) }));
    expect((await screen.findByText(PROVIDER_UNREACHED_LINE)).closest("[data-sidebar-search]")).not.toBeNull();
    act(() => useStore.getState().applyEvent({ type: "workspace.status", status: status(API) }));
  });
});

describe("a window on another computer while the wsp it shows is asleep", () => {
  const served = (here: boolean) => {
    (window as unknown as { __WSP__?: unknown }).__WSP__ = { wsPath: "/ws", paired: here, version: "0.0.0", ...(here ? { wsPort: 7788, tokenHash: "a".repeat(64) } : {}) };
  };

  afterEach(() => {
    delete (window as unknown as { __WSP__?: unknown }).__WSP__;
  });

  it("reads the asleep line under the search row in the prose mono, never as an alert, and only on a page the host did not serve on this computer", async () => {
    served(false);
    await mount(fakeApi([API], [status(API)]), "api");
    expect(screen.queryByText(HOST_ASLEEP_LINE)).toBeNull();
    act(() => useStore.getState().setConn("reconnecting"));
    const line = await screen.findByText(HOST_ASLEEP_LINE);
    expect(line.closest("[data-sidebar-search]")).not.toBeNull();
    expect(line.className).toContain("font-mono");
    expect(line.className).not.toMatch(/border|bg-|destructive|warning/);
    expect(line.getAttribute("role")).toBeNull();
    // The rows stay as they were last known: the workspaces are on their own computers and keep working.
    expect(rowOf("api")).toBeDefined();
    act(() => useStore.getState().setConn("live"));
    await waitFor(() => expect(screen.queryByText(HOST_ASLEEP_LINE)).toBeNull());
  });

  it("no tile carries a green whatever its machine is doing, and the tiles stay as they were last known while this computer sleeps", async () => {
    served(false);
    const MAC = { ...view("ws_mac", "this Mac"), kind: "local" as const };
    await mount(fakeApi([MAC, WEB], [status(MAC), status(WEB)]), "web");
    expect(document.querySelector("[data-app-sidebar] .text-success-foreground, [data-sidebar-row] .text-success-foreground, .lucide-laptop, .lucide-cloud, .lucide-server")).toBeNull();
    const before = rowIds();
    act(() => useStore.getState().setConn("reconnecting"));
    await screen.findByText(HOST_ASLEEP_LINE);
    expect(rowIds()).toEqual(before);
    act(() => useStore.getState().setConn("live"));
  });

  it("says nothing of the kind on the computer the host runs on, where the page carries the host's own token", async () => {
    served(true);
    await mount(fakeApi([API], [status(API)]), "api");
    act(() => useStore.getState().setConn("reconnecting"));
    await waitFor(() => expect(useStore.getState().conn).toBe("reconnecting"));
    expect(screen.queryByText(HOST_ASLEEP_LINE)).toBeNull();
  });
});

describe("the project switcher", () => {
  /** Two projects, one on this computer and one on the box, each with a workspace, so a pick has something to hide. */
  const two = async () => {
    const api = fakeApi([API, { ...WEB, project: { id: "pr_2", name: "wsp", path: "/Users/dev/wsp", computer: "here" } }], [status(API), status(WEB)], [session("s1", "ws_a", { prompt: "hello", threadId: "thr_1", startedAt: iso(-60_000) }), session("s2", "ws_b", { prompt: "world", threadId: "thr_2", startedAt: iso(-120_000) })]);
    api.projectsList = vi.fn(async () => [...PROJECTS, HERE_PROJECT]);
    await mount(api, "world");
    await waitFor(() => expect(head().disabled).toBe(false));
    return api;
  };

  it("reads All projects at rest with its folder and chevron, and no project row and no gear stands in the list", async () => {
    await two();
    expect(head().textContent).toBe(SWITCHER_WORDS.all);
    expect(head().disabled).toBe(false);
    expect(head().getAttribute("aria-haspopup")).toBe("listbox");
    expect(head().getAttribute("aria-expanded")).toBe("false");
    expect(head().querySelector("svg.lucide-folder")).not.toBeNull();
    expect(head().querySelector("svg.lucide-chevron-down")).not.toBeNull();
    expect(rowIds().filter(id => id?.startsWith("project:"))).toEqual([]);
    expect(document.querySelector("[data-sidebar-search] svg.lucide-settings, [data-sidebar-tree] svg.lucide-settings")).toBeNull();
  });

  it("opens on a click to a search field, All projects checked, one row per project and Add a project at the foot; typing filters the projects while the two ends stand", async () => {
    await two();
    fireEvent.click(head());
    expect(head().getAttribute("aria-expanded")).toBe("true");
    const list = within(menu()!);
    const options = () => list.getAllByRole("option").map(option => option.textContent);
    expect(options()).toEqual([SWITCHER_WORDS.all, `spoo-landing${BOX_NAME}`, "wsp"]);
    expect(list.getByRole("option", { name: SWITCHER_WORDS.all }).getAttribute("aria-selected")).toBe("true");
    expect(list.getByRole("option", { name: SWITCHER_WORDS.all }).querySelector("svg.lucide-check")).not.toBeNull();
    expect(list.getByRole("option", { name: /^wsp/ }).querySelector("svg.lucide-check")).toBeNull();
    expect(list.getByText(PROJECT_WORDS.add).closest("button")!.querySelector("svg.lucide-plus")).not.toBeNull();
    const field = list.getByLabelText(SWITCHER_WORDS.search) as HTMLInputElement;
    expect(field.placeholder).toBe(SWITCHER_WORDS.search);
    fireEvent.change(field, { target: { value: "SPOO" } });
    expect(options()).toEqual([SWITCHER_WORDS.all, `spoo-landing${BOX_NAME}`]);
    fireEvent.change(field, { target: { value: "nothing here" } });
    expect(options()).toEqual([SWITCHER_WORDS.all]);
    expect(list.getByText(PROJECT_WORDS.add)).toBeDefined();
    // No caps, no letter-spacing anywhere in the menu either.
    expect([...menu()!.querySelectorAll("*")].some(el => /uppercase|tracking-/.test(el.className))).toBe(false);
  });

  it("picking a project draws its tiles alone, names it in the head with its plus on hover, remembers the pick in this window, and All projects brings every tile back", async () => {
    await two();
    fireEvent.click(head());
    fireEvent.click(within(menu()!).getByRole("option", { name: /^wsp/ }));
    expect(menu()).toBeNull();
    expect(head().textContent).toBe("wsp");
    expect(head().getAttribute("aria-expanded")).toBe("false");
    expect(rowIds()).toEqual(["thread:thr_2"]);
    expect(depthOf(rowOf("world"))).toBe(0);
    expect(window.localStorage.getItem("wsp:sidebar-project")).toBe('"pr_2"');
    // The head stands in for the project's row: its plus is New workspace on that project.
    const plus = head().parentElement!.querySelector<HTMLElement>("[data-k=new-workspace]")!;
    expect(plus.dataset["project"]).toBe("pr_2");
    expect(plus.getAttribute("aria-label")).toBe(NEW_WORKSPACE);
    // Nothing at rest at every width, the phone's sheet included, where the kit alone would stand it up.
    expect(plus.className).toMatch(/(^|\s)opacity-0(\s|$)/);
    fireEvent.click(plus);
    const dialog = await screen.findByRole("dialog");
    expect(dialog.querySelector<HTMLElement>("[data-segment=pr_2]")!.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(within(dialog).getByRole("button", { name: /Cancel/ }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // Back to every project: the rows return and the pick leaves this window's storage.
    fireEvent.click(head());
    fireEvent.click(within(menu()!).getByRole("option", { name: SWITCHER_WORDS.all }));
    expect(rowIds()).toEqual(["thread:thr_1", "thread:thr_2"]);
    expect(window.localStorage.getItem("wsp:sidebar-project")).toBeNull();
    expect(head().parentElement!.querySelector("[data-k=new-workspace]")).toBeNull();
  });

  it("the keys walk the menu and stop there: ArrowDown moves the active row and names it to the field while focus stays on the field, Enter picks and shuts, and a stored pick for a project this host no longer holds reads as All projects", async () => {
    window.localStorage.setItem("wsp:sidebar-project", '"pr_gone"');
    await two();
    expect(head().textContent).toBe(SWITCHER_WORDS.all);
    expect(rowIds()).toContain("thread:thr_1");
    fireEvent.click(head());
    const field = within(menu()!).getByLabelText(SWITCHER_WORDS.search) as HTMLInputElement;
    act(() => field.focus());
    const active = () => menu()!.querySelector<HTMLElement>("[data-active]")!;
    expect(active().textContent).toBe(SWITCHER_WORDS.all);
    fireEvent.keyDown(field, { key: "ArrowDown" });
    expect(active().textContent).toBe(`spoo-landing${BOX_NAME}`);
    // The key stops at the menu: the sidebar's own walk under it never takes focus off the field, and the field
    // names the row the keys are on.
    expect(document.activeElement).toBe(field);
    expect(active().id).not.toBe("");
    expect(field.getAttribute("aria-activedescendant")).toBe(active().id);
    fireEvent.keyDown(field, { key: "ArrowDown" });
    fireEvent.keyDown(field, { key: "ArrowDown" });
    expect(active().textContent).toBe(PROJECT_WORDS.add);
    expect(document.activeElement).toBe(field);
    expect(field.getAttribute("aria-activedescendant")).toBe(active().id);
    fireEvent.keyDown(field, { key: "ArrowUp" });
    expect(document.activeElement).toBe(field);
    fireEvent.keyDown(field, { key: "Enter" });
    expect(menu()).toBeNull();
    expect(head().textContent).toBe("wsp");
    expect(rowIds()).toEqual(["thread:thr_2"]);
    expect(document.activeElement).toBe(head());
  });

  it("while a project is picked the palette's New workspace opens the dialog on that project, as the head's plus does", async () => {
    await two();
    fireEvent.click(head());
    fireEvent.click(within(menu()!).getByRole("option", { name: /^wsp/ }));
    act(() => requestNewWorkspace());
    const dialog = await screen.findByRole("dialog");
    expect(dialog.querySelector<HTMLElement>("[data-segment=pr_2]")!.getAttribute("aria-checked")).toBe("true");
    expect(dialog.querySelector<HTMLElement>("[data-segment=pr_1]")!.getAttribute("aria-checked")).toBe("false");
  });

  it("picking a project changes what the sidebar lists and nothing else: the selected thread stays open and the sidebar then draws no lifted row", async () => {
    await two();
    fireEvent.click(rowOf("hello"));
    expect(useStore.getState()).toMatchObject({ selectedId: "ws_a", selectedThreadId: "thr_1" });
    expect(document.querySelectorAll("[data-sidebar-row][data-active=true]")).toHaveLength(1);
    fireEvent.click(head());
    fireEvent.click(within(menu()!).getByRole("option", { name: /^wsp/ }));
    expect(useStore.getState()).toMatchObject({ selectedId: "ws_a", selectedThreadId: "thr_1" });
    expect(document.querySelectorAll("[data-sidebar-row][data-active=true]")).toHaveLength(0);
  });

  it("Add a project at the menu's foot opens the sheet, and no row at rest says it", async () => {
    await two();
    expect(screen.queryByText(PROJECT_WORDS.add)).toBeNull();
    fireEvent.click(head());
    fireEvent.click(within(menu()!).getByText(PROJECT_WORDS.add));
    const sheet = await screen.findByRole("dialog");
    expect(sheet.dataset["k"]).toBe("add-project");
    expect(menu()).toBeNull();
  });
});

describe("the computer switcher", () => {
  const computerHead = (): HTMLButtonElement => document.querySelector<HTMLButtonElement>("[data-k=computer-switcher]")!;
  const computerMenu = (): HTMLElement | null => document.querySelector<HTMLElement>("[data-computer-switcher-menu]");
  const HERE_NAME = placeName(PLACES[0]!);
  /** The two projects of the project switcher's cases, spoo-landing's workspace on the box and wsp's on this computer. */
  const two = async () => {
    const api = fakeApi([API, { ...WEB, place: "here", project: { id: "pr_2", name: "wsp", path: "/Users/dev/wsp", computer: "here" } }], [status(API), status(WEB)], [session("s1", "ws_a", { prompt: "hello", threadId: "thr_1" }), session("s2", "ws_b", { prompt: "world", threadId: "thr_2" })]);
    api.projectsList = vi.fn(async () => [...PROJECTS, HERE_PROJECT]);
    await mount(api, "world");
    await waitFor(() => expect(useStore.getState().places).toHaveLength(2));
    return api;
  };
  const pickComputer = (name: string | RegExp): void => {
    fireEvent.click(computerHead());
    fireEvent.click(within(computerMenu()!).getByRole("option", { name }));
  };

  it("stands under the project switcher reading All computers with the monitor and the chevron, and opens to a search field, All computers checked, one row per computer by its name with its glyph and gear, and Add a computer at the foot", async () => {
    await two();
    const heads = [...document.querySelectorAll<HTMLElement>("[data-sidebar-search] [data-k$=-switcher]")].map(el => el.dataset["k"]);
    expect(heads).toEqual(["project-switcher", "computer-switcher"]);
    expect(computerHead().textContent).toBe(COMPUTER_SWITCHER_WORDS.all);
    expect(computerHead().className).toBe(head().className);
    expect(computerHead().querySelector("svg.lucide-monitor")).not.toBeNull();
    expect(computerHead().querySelector("svg.lucide-chevron-down")).not.toBeNull();
    expect(computerHead().getAttribute("aria-haspopup")).toBe("listbox");
    fireEvent.click(computerHead());
    expect(computerHead().getAttribute("aria-expanded")).toBe("true");
    const list = within(computerMenu()!);
    const options = () => list.getAllByRole("option").map(option => option.textContent);
    expect(options()).toEqual([COMPUTER_SWITCHER_WORDS.all, HERE_NAME, BOX_NAME]);
    const all = list.getByRole("option", { name: COMPUTER_SWITCHER_WORDS.all });
    expect(all.getAttribute("aria-selected")).toBe("true");
    expect(all.querySelector("svg.lucide-check")).not.toBeNull();
    expect(all.querySelector("svg.lucide-monitor")).not.toBeNull();
    for (const place of PLACES) {
      const row = list.getByRole("option", { name: new RegExp(`^${placeName(place)}`) });
      expect(row.querySelector("[data-computer-glyph]")).not.toBeNull();
      expect(row.querySelector("[data-k=computer-settings]")!.getAttribute("aria-label")).toBe(COMPUTER_SWITCHER_WORDS.settingsOf(placeName(place)));
    }
    expect(list.getByRole("option", { name: new RegExp(`^${BOX_NAME}`) }).querySelector("svg.lucide-cloud")).not.toBeNull();
    const field = list.getByLabelText(COMPUTER_SWITCHER_WORDS.search) as HTMLInputElement;
    expect(field.placeholder).toBe(COMPUTER_SWITCHER_WORDS.search);
    fireEvent.change(field, { target: { value: BOX_NAME.toUpperCase() } });
    expect(options()).toEqual([COMPUTER_SWITCHER_WORDS.all, BOX_NAME]);
    expect(list.getByText(COMPUTER_SWITCHER_WORDS.add).closest("button")!.querySelector("svg.lucide-plus")).not.toBeNull();
    // The project switcher's menu stays shut: each head opens its own.
    expect(menu()).toBeNull();
  });

  it("picking a computer lists only the work on it, names it in the head, remembers it in this window, stacks with the project pick, and All computers brings every row back", async () => {
    await two();
    pickComputer(new RegExp(`^${BOX_NAME}`));
    expect(computerMenu()).toBeNull();
    expect(computerHead().textContent).toBe(BOX_NAME);
    expect(computerHead().querySelector("svg.lucide-cloud")).not.toBeNull();
    // The picked head takes the row's own ink, as a picked project's head does, where the menu's rows stay muted.
    expect(computerHead().querySelector("[data-computer-glyph]")!.getAttribute("class")).not.toContain("text-muted-foreground");
    fireEvent.click(computerHead());
    expect(within(computerMenu()!).getByRole("option", { name: new RegExp(`^${BOX_NAME}`) }).querySelector("[data-computer-glyph]")!.getAttribute("class")).toContain("text-muted-foreground");
    fireEvent.click(computerHead());
    expect(window.localStorage.getItem("wsp:sidebar-computer")).toBe('"box"');
    // wsp keeps nothing on the box and lives on this computer, so its tile goes with its workspace.
    expect(rowIds()).toEqual(["thread:thr_1"]);
    // The project pick stacks on it: wsp on the box is nothing, spoo-landing on the box is its one workspace.
    fireEvent.click(head());
    fireEvent.click(within(menu()!).getByRole("option", { name: /^wsp/ }));
    expect(head().textContent).toBe("wsp");
    expect(rowIds()).toEqual([]);
    fireEvent.click(head());
    fireEvent.click(within(menu()!).getByRole("option", { name: /^spoo-landing/ }));
    expect(rowIds()).toEqual(["thread:thr_1"]);
    pickComputer(new RegExp(`^${HERE_NAME}`));
    expect(rowIds()).toEqual([]);
    fireEvent.click(head());
    fireEvent.click(within(menu()!).getByRole("option", { name: SWITCHER_WORDS.all }));
    expect(rowIds()).toEqual(["thread:thr_2"]);
    pickComputer(COMPUTER_SWITCHER_WORDS.all);
    expect(computerHead().textContent).toBe(COMPUTER_SWITCHER_WORDS.all);
    expect(window.localStorage.getItem("wsp:sidebar-computer")).toBeNull();
    expect(rowIds()).toEqual(["thread:thr_1", "thread:thr_2"]);
  });

  it("a stored pick for a computer this host no longer holds reads as All computers", async () => {
    window.localStorage.setItem("wsp:sidebar-computer", '"gone"');
    await two();
    expect(computerHead().textContent).toBe(COMPUTER_SWITCHER_WORDS.all);
    expect(rowIds()).toContain("thread:thr_1");
    expect(rowIds()).toContain("thread:thr_2");
  });

  it("a computer's gear opens that computer's page in Settings without picking it, and Add a computer opens the add sheet", async () => {
    await two();
    fireEvent.click(computerHead());
    fireEvent.click(within(computerMenu()!).getByRole("option", { name: new RegExp(`^${BOX_NAME}`) }).querySelector<HTMLElement>("[data-k=computer-settings]")!);
    expect(useSettingsStore.getState().at).toEqual({ kind: "computer", id: "box" });
    expect(useStore.getState().settingsOpen).toBe(true);
    expect(computerHead().textContent).toBe(COMPUTER_SWITCHER_WORDS.all);
    expect(computerMenu()).toBeNull();
    useStore.setState({ settingsOpen: false, addComputerOpen: false });
    fireEvent.click(computerHead());
    fireEvent.click(within(computerMenu()!).getByText(COMPUTER_SWITCHER_WORDS.add));
    expect(computerMenu()).toBeNull();
    expect(useStore.getState()).toMatchObject({ settingsOpen: true, addComputerOpen: true });
  });
});

describe("the tree", () => {
  it("nests every thread an agent opened under its opener as deep as the opening went, a forked workspace's threads under the thread that forked it, and keeps an orphan a root", async () => {
    const fork = { ...view("ws_fork", "pricing table", "running", 30 * 60_000), parentThreadId: "th_build" };
    await mount(
      fakeApi(
        [API, fork],
        [status(API), status(fork)],
        [
          session("s1", "ws_a", { prompt: "retry the webhook queue", threadId: "th_lead", startedAt: iso(-60_000) }),
          session("s2", "ws_a", { prompt: "build the rows", threadId: "th_build", parentThreadId: "th_lead", startedBy: "agent", startedAt: iso(-50_000) }),
          session("s3", "ws_a", { prompt: "review the rows", threadId: "th_review", parentThreadId: "th_build", startedBy: "agent", startedAt: iso(-40_000), asking: "Write the review" }),
          session("s4", "ws_fork", { prompt: "move the pricing table", threadId: "th_move", startedBy: "agent", startedAt: iso(-30_000) }),
          session("s5", "ws_a", { prompt: "left behind", threadId: "th_orphan", parentThreadId: "th_nowhere", startedBy: "agent", startedAt: iso(-20_000) }),
        ],
      ),
      "move the pricing table",
    );
    expect(rowIds()).toEqual(["thread:th_orphan", "thread:th_lead", "thread:th_build", "thread:th_move", "thread:th_review"]);
    const depths = rowIds().map(id => Number(document.querySelector<HTMLElement>(`[data-row-id='${id}']`)!.dataset["depth"]));
    expect(depths).toEqual([0, 0, 1, 2, 2]);
    // Real nesting, item inside item: the builder's item holds the reviewer and the fork's thread.
    const build = rowOf("build the rows").closest("li[data-thread-item]")!;
    expect(build.contains(rowOf("review the rows"))).toBe(true);
    expect(build.contains(rowOf("move the pricing table"))).toBe(true);
    expect(rowOf("retry the webhook queue").closest("li[data-thread-item]")!.contains(build)).toBe(true);
    // Every child list is a list with its rail, and every item in one is a rail item; the top list has none.
    for (const title of ["build the rows", "review the rows", "move the pricing table"]) {
      const item = rowOf(title).closest("li")!;
      expect(item.className, title).toContain("before:w-px");
      expect(item.parentElement!.className, title).toContain("ml-3");
    }
    expect(rowOf("retry the webhook queue").closest("li")!.className).not.toContain("before:w-px");
    expect(threadState(rowOf("review the rows"))).toBe("Needs you");
    // The fork's tile names where the fork runs, which is its own copy.
    expect(rowOf("move the pricing table").querySelector("[data-tile-where]")!.textContent).toBe(`the-project @ ${BOX_NAME}`);
  });

  it("a thread an agent opened on another workspace hangs under its opener and names where it runs itself", async () => {
    const MAC = { ...view("ws_mac", "zingzy's Mac", "running", 3 * 60 * 60_000), kind: "local" as const };
    const BENCH = view("ws_bench", "spoo-bench", "running", 60 * 60_000);
    await mount(
      fakeApi(
        [MAC, BENCH],
        [status(MAC), status(BENCH)],
        [
          session("s1", "ws_mac", { prompt: "run the migration across the fleet", threadId: "th_lead", startedAt: iso(-60_000) }),
          session("s2", "ws_bench", { prompt: "benchmark the new index", startedBy: "agent", threadId: "th_bench", parentThreadId: "th_lead", startedAt: iso(-600_000) }),
        ],
      ),
      "benchmark the new index",
    );
    expect(rowIds()).toEqual(["thread:th_lead", "thread:th_bench"]);
    expect(depthOf(rowOf("benchmark the new index"))).toBe(1);
    expect(rowOf("benchmark the new index").querySelector("[data-tile-where]")!.textContent).toBe(`the-project @ ${BOX_NAME}`);
    expect(rowOf("run the migration across the fleet").querySelector("[data-tile-where]")!.textContent).toBe(`the-project @ ${placeName(PLACES[0]!)}`);
  });
});

describe("one lifted tile", () => {
  it("exactly one tile is lifted when a thread is selected, one when a workspace with no thread is, none when nothing is, and none when the selected thread sits in the shut Settled fold", async () => {
    await mount(
      fakeApi(
        [API, WEB],
        [status(API), status(WEB)],
        [session("s1", "ws_a", { prompt: "hello", threadId: "thr_1", startedAt: iso(-60_000) }), session("s2", "ws_a", { status: "completed", prompt: "done", threadId: "thr_2", startedAt: iso(-3 * 24 * 60 * 60_000), endedAt: iso(-2 * 24 * 60 * 60_000) })],
      ),
      "hello",
    );
    fireEvent.click(screen.getByRole("button", { name: "Settled 1" }));
    const lifted = () => [...document.querySelectorAll<HTMLElement>("[data-sidebar-row][data-active=true]")].map(row => row.dataset["rowId"]);
    act(() => useStore.getState().select(null));
    expect(lifted()).toEqual([]);
    fireEvent.click(rowOf("hello"));
    expect(lifted()).toEqual(["thread:thr_1"]);
    fireEvent.click(rowOf("web"));
    expect(lifted()).toEqual(["ws:ws_b"]);
    fireEvent.click(rowOf("done"));
    expect(lifted()).toEqual(["thread:thr_2"]);
    fireEvent.click(screen.getByRole("button", { name: "Settled" }));
    expect(lifted()).toEqual([]);
    // No card, no border, no shadow on any tile: the fill on the one selected tile is the only lift.
    for (const row of document.querySelectorAll<HTMLElement>("[data-sidebar-row]")) expect(row.className).not.toMatch(/(^|\s)(shadow[^\s]*|border-sidebar-border|bg-sidebar-control-surface)(\s|$)/);
  });
});

describe("the creation tile", () => {
  it("is a tile at the thread tile's height: where it will run, the name, the stage line cut with the whole on hover; a refused create says Failed in the slot", async () => {
    await mount(fakeApi([COPIED], [status(COPIED)]), "api");
    const long = "Forking the image, which takes a moment on a computer that has never made a copy of this project before.";
    act(() =>
      useStore.setState({
        creations: [
          { key: "creating:1", name: "beta", askedAt: Date.now(), project: "pr_1", workspaceId: null, lines: [{ stage: "fork-requested", message: long, at: "t", elapsedMs: 0 }], failed: null },
          { key: "creating:2", name: "gamma", askedAt: Date.now(), project: "pr_1", workspaceId: null, lines: [], failed: { title: "Could not create the workspace", detail: "the disk is full" } },
        ],
      } as never),
    );
    const beta = rowOf("beta");
    const gamma = rowOf("gamma");
    expect(rowIds()).toEqual(["ws:ws_a", "creating:1", "creating:2"]);
    for (const row of [beta, gamma]) {
      expect(row.className).toBe(rowOf("api").className);
      expect(row.querySelector("[data-tile-where]")!.textContent).toBe(`spoo-landing @ ${BOX_NAME}`);
      expect(row.querySelector(".rounded-full, .bg-destructive")).toBeNull();
    }
    expect(beta.getAttribute("aria-busy")).toBe("true");
    expect(beta.querySelector("[data-thread-status]")).toBeNull();
    const line = beta.querySelector<HTMLElement>("[data-creation-line]")!;
    expect(line.textContent).toBe(long);
    expect(beta.getAttribute("title")).toContain(long);
    expect(line.className).toContain("truncate");
    expect(gamma.getAttribute("aria-busy")).toBeNull();
    expect(threadState(gamma)).toBe("Failed");
    expect(gamma.querySelector("[data-creation-line]")!.textContent).toBe("Could not create the workspace");
  });
});
