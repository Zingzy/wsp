// SPDX-License-Identifier: AGPL-3.0-only
// The workspace sidebar over the fixture wire: rows from the store's
// workspaces, statuses, costs and sessions; grouping; search; keyboard
// traversal; the new-workspace dialog; the zombie rebuild and the gone forget.
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { cloneElement, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DAEMON_UPDATE_FAILED, DAEMON_UPDATING, DEFAULT_PREFERENCES, DEFAULT_THEME, FREE_WORD, HOSTNAME_KEPT, HOST_ASLEEP_LINE, PROVIDER_UNREACHED_LINE, exportFromLine, harmonyDots, importIntoLine, registeredLine, type PlaceView, type ProjectView, type SessionView, type WorkspaceLook, type WorkspaceStatus, type WorkspaceTheme, type WorkspaceView } from "@wsp/protocol";
import { WORKSPACE_WORDS } from "../src/actions/format.js";
import { onOpenCommandPalette } from "../src/commandPaletteBus.js";
import { SidebarProvider } from "../src/components/ui/sidebar.js";
import { getLive, resetLive } from "../src/machine/live.js";
import { RequestError, type Api } from "../src/protocol/client.js";
import { useStore } from "../src/protocol/store.js";
import { CLOSE_TOAST_LABEL, TOAST_MS } from "../src/sidebar/toastLife.js";
import { SETTINGS_WORDS } from "../src/settings/format.js";
import { statusOf } from "./workspace-status.js";
import { onNewThreadRequest, requestProjectTrip, requestRenameWorkspace } from "../src/shell/shellRequests.js";
import { glyphStateClass } from "../src/sidebar/workspaceRows.js";
import { WorkspaceSidebar } from "../src/sidebar/WorkspaceSidebar.js";
import { caps } from "./caps.js";
import { noDaemonApi } from "./fake-daemon-api.js";
import { WorkspaceTerminals, provideTerminals } from "../src/terminal/link.js";

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
    placesList: vi.fn(async () => PLACES),
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

beforeEach(() => {
  window.localStorage.clear();
  useStore.setState({ places: [], projects: [], api: null, conn: "live", capabilities: null, workspaces: [], statuses: {}, costs: {}, spending: {}, toast: null, toastAction: null, setupOpen: false, selectedId: null, selectedThreadId: null, creations: [], sessions: {}, launches: {}, ready: false, preferences: { ...DEFAULT_PREFERENCES, labs: true }, settingsOpen: false });
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
const stateSlot = (row: HTMLElement): HTMLElement => row.querySelector<HTMLElement>("[data-workspace-state]")!;
/** A thread row's state, which is one muted mono word and never a dot; null on a row that carries none. */
const threadState = (row: HTMLElement): string | null => row.querySelector<HTMLElement>("[data-thread-state]")?.textContent ?? null;
const metaOf = (row: HTMLElement): HTMLElement => row.querySelector<HTMLElement>("[data-workspace-meta]")!;
const spaceHeader = (): HTMLElement | null => document.querySelector<HTMLElement>("[data-space-header]");
const headerLines = (): string[] => Array.from(document.querySelectorAll<HTMLElement>("[data-space-header] [data-space-meta]")).map(l => l.textContent ?? "");
const icons = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>("[data-space-icon]"));
const panes = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>("[data-space-pane]"));
const paneNames = (): string[] => Array.from(document.querySelectorAll<HTMLElement>("[data-space-pane] [data-space-name]")).map(n => n.textContent ?? "");
/** What React says when one body is drawn as both panes: the one console line the reversal case is about. */
const DUPLICATE_KEY = "two children with the same key";
/** The name in the header of the body that is staying: the pane not marked as the one on its way out. */
const spaceName = (): string => document.querySelector<HTMLElement>("[data-space-pane]:not([data-space-leaving]) [data-space-name]")?.textContent ?? "";
const workspaceRowIds = (): string[] => Array.from(document.querySelectorAll<HTMLElement>("[data-row-id^='ws:']")).map(r => r.dataset["rowId"] ?? "");

const API = view("ws_a", "api");
const WEB = view("ws_b", "web", "napping");

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

describe("rows from the fixture wire", () => {
  it("first level is the workspaces, second level their sessions titled by prompt with a relative time", async () => {
    await mount(
      fakeApi(
        [API, WEB],
        [status(API), status(WEB)],
        [
          session("s1", "ws_a", { prompt: "fix the port list", startedAt: iso(-3 * 60_000) }),
          session("s2", "ws_a", { status: "completed", prompt: "upgrade node", startedAt: iso(-60 * 60_000), endedAt: iso(-50 * 60_000) }),
          session("s3", "ws_b", { status: "failed", claudeSessionId: "59094224-bb3d", startedAt: iso(-2 * 24 * 60 * 60_000 - 60_000), endedAt: iso(-2 * 24 * 60 * 60_000) }),
        ],
      ),
      "api",
    );
    await waitFor(() => expect(screen.getByText("fix the port list")).toBeDefined());
    // The one idle two days is past the archive threshold, so it sits in the Archived group nested in its
    // workspace's shelf, shut, rather than as a row on the shelf itself.
    expect(rowIds()).toEqual(["ws:ws_a", "thread:s1", "settled:ws_a", "thread:s2", "ws:ws_b", "settled:ws_b", "archived:ws_b"]);
    expect(rowOf("fix the port list").textContent).toContain("3m");
    expect(rowOf("upgrade node").textContent).toContain("50m");
    fireEvent.click(screen.getByRole("button", { name: "Archived (1)" }));
    // a session without a prompt falls back to the harness session id
    expect(rowOf("59094224-bb3d").textContent).toContain("2d");
    // status pills: the running one works, the one that never settled failed, the idle one is plain
    expect(threadState(rowOf("fix the port list"))).toBe("Working");
    expect(threadState(rowOf("59094224-bb3d"))).toBe("Failed");
    expect(within(rowOf("upgrade node")).queryByLabelText(/Idle|Completed/)).toBeNull();
    // Both workspaces head their shelf, whether or not one of their threads is working: ws_b's holds nothing but
    // the nested archive, and a shelf that holds only that is still a shelf.
    expect(screen.getAllByRole("button", { name: "Idle" })).toHaveLength(2);
    expect(screen.queryByText(/Settled/)).toBeNull();
  });

  it("a thread stopped on a permission prompt says so on its row and on its workspace's third line, and goes back to working when it is answered", async () => {
    const asking = "Permission for Bash: Check wsp version";
    await mount(fakeApi([API], [status(API)], [session("s1", "ws_a", { prompt: "fix the port list", startedAt: iso(-3 * 60_000), asking })]), "api");
    await waitFor(() => expect(screen.getByText("fix the port list")).toBeDefined());
    expect(threadState(rowOf("fix the port list"))).toBe("Needs you");
    expect(threadState(rowOf("fix the port list"))).not.toBe("Working");
    // The workspace's own row carries the sentence a person is waiting on, cut at the row's cap.
    expect(rowOf("api").textContent).toContain("Permission for Bash: Check");
    act(() => useStore.setState({ sessions: { ws_a: [session("s1", "ws_a", { prompt: "fix the port list", startedAt: iso(-3 * 60_000) })] } }));
    await waitFor(() => expect(threadState(rowOf("fix the port list"))).toBe("Working"));
    expect(rowOf("api").textContent).not.toContain("Permission for Bash");
  });

  it("three workspaces in mixed states stand in the order they were made, whatever each machine is doing; a creating row waits at the foot", async () => {
    const gone = view("ws_gone", "scratch", "running", 3 * 24 * 60 * 60_000);
    const paused = view("ws_nap", "spike", "napping", 2 * 60 * 60_000);
    const running = view("ws_run", "dev", "running", 60_000);
    await mount(fakeApi([gone, paused, running], [status(gone, { machineState: "gone", reach: { state: "gone" } }), status(paused), status(running)]), "dev");
    await waitFor(() => expect(rowIds()).toEqual(["ws:ws_gone", "ws:ws_nap", "ws:ws_run"]));
    // The state slot: the running row says nothing in words (the dot says it); every other state's word sits in it.
    expect(rowOf("dev").textContent).not.toContain("Running");
    expect(stateSlot(rowOf("dev")).textContent).toBe("");
    expect(stateSlot(rowOf("spike")).textContent).toBe("Stopped");
    expect(stateSlot(rowOf("scratch")).textContent).toBe("Gone");
    for (const name of ["dev", "spike", "scratch"]) {
      const slot = stateSlot(rowOf(name));
      // The slot is the last thing on the name's line, in the muted mono every row's meta wears, whether or not it holds a word.
      expect(slot.parentElement!.lastElementChild).toBe(slot);
      expect(slot.parentElement!.contains(screen.getByText(name))).toBe(true);
      expect(slot.className).toContain("font-mono");
      expect(slot.className).toContain("shrink-0");
      expect(slot.className).not.toMatch(/success|emerald|green/);
    }
    // The one being made is the newest thing here, so it waits where it will stand once it is a workspace.
    act(() => useStore.setState({ creations: [{ key: "creating:1", name: "beta", askedAt: Date.now(), workspaceId: null, lines: [], failed: null }] }));
    expect(rowIds()).toEqual(["ws:ws_gone", "ws:ws_nap", "ws:ws_run", "creating:1"]);
  });

  it("every thread row carries the agent's own mark in its colour and who opened it in muted mono, with the agent named on hover", async () => {
    await mount(
      fakeApi(
        [API],
        [status(API)],
        [
          session("s1", "ws_a", { prompt: "fix the port list", startedBy: "cli" }),
          session("s2", "ws_a", { prompt: "upgrade node", harness: "codex", startedBy: "person" }),
          session("s3", "ws_a", { prompt: "before provenance" }),
          session("s4", "ws_a", { prompt: "from the director", startedBy: "agent" }),
        ],
      ),
      "api",
    );
    await waitFor(() => expect(screen.getByText("fix the port list")).toBeDefined());
    const provenance = (title: string): HTMLElement => rowOf(title).querySelector<HTMLElement>("[data-thread-provenance]")!;
    const reads = (title: string) => {
      const mark = provenance(title).querySelector("[data-harness-mark]")!;
      // The brand hue is a token of its own; a monochrome mark inherits the row's foreground from the span it sits in,
      // while the opener word beside it stays the meta line's muted grey.
      const tone = [...mark.classList].find(c => c.startsWith("text-"));
      expect(provenance(title).className).toContain("text-sidebar-foreground");
      expect(mark.nextElementSibling?.className).toContain("text-[var(--top-row-meta)]");
      return { label: provenance(title).getAttribute("aria-label"), text: provenance(title).textContent, mark: mark.getAttribute("data-harness-mark"), svg: mark.tagName, tone, size: [...mark.classList].find(c => c.startsWith("size-")) };
    };
    expect(reads("fix the port list")).toEqual({ label: "Claude Code · the-project · cli", text: "·the-project·cli", mark: "claude", svg: "svg", tone: "text-agent-claude", size: "size-[13px]" });
    expect(reads("upgrade node")).toEqual({ label: "Codex · the-project · you", text: "·the-project·you", mark: "codex", svg: "svg", tone: undefined, size: "size-[13px]" });
    expect(reads("before provenance")).toEqual({ label: "Claude Code · the-project · you", text: "·the-project·you", mark: "claude", svg: "svg", tone: "text-agent-claude", size: "size-[13px]" });
    expect(reads("from the director")).toEqual({ label: "Claude Code · the-project · agent", text: "·the-project·agent", mark: "claude", svg: "svg", tone: "text-agent-claude", size: "size-[13px]" });
    const line = provenance("fix the port list").closest<HTMLElement>("[data-thread-meta]")!;
    expect(line.className).toContain("font-mono");
    expect(line.className).toContain("text-[var(--top-row-meta)]");
  });

  it("a thread row's second line carries its workspace's project beside the agent's mark, in the meta line's muted mono, and every row keeps the same height and grammar", async () => {
    const project = { id: "pr_spoo", name: "spoo", path: "/root/spoo", computer: "default" };
    await mount(
      fakeApi(
        [{ ...API, project }],
        [status({ ...API, project })],
        [
          session("s1", "ws_a", { prompt: "fix the port list", startedBy: "cli", cwd: "/root/spoo" }),
          session("s2", "ws_a", { prompt: "upgrade node", harness: "codex", startedBy: "person", cwd: "/root/wsp/packages/host" }),
          session("s3", "ws_a", { prompt: "no project", cwd: "/root" }),
        ],
      ),
      "api",
    );
    await waitFor(() => expect(screen.getByText("fix the port list")).toBeDefined());
    const provenance = (title: string): HTMLElement => rowOf(title).querySelector<HTMLElement>("[data-thread-provenance]")!;
    const word = (title: string): HTMLElement | null => rowOf(title).querySelector<HTMLElement>("[data-thread-word]");
    // A workspace is one project's copy, so every thread on it carries that project whatever folder it ran in.
    expect(word("fix the port list")!.textContent).toBe("spoo");
    expect(word("upgrade node")!.textContent).toBe("spoo");
    expect(word("no project")!.textContent).toBe("spoo");
    // Mark, then the project, then who opened it: `✳ · spoo · cli`, the dots drawn as text and not as chips.
    expect(provenance("fix the port list").textContent).toBe("·spoo·cli");
    expect(provenance("fix the port list").getAttribute("aria-label")).toBe("Claude Code · spoo · cli");
    expect(provenance("no project").textContent).toBe("·spoo·you");
    expect(provenance("no project").getAttribute("aria-label")).toBe("Claude Code · spoo · you");
    const line = word("fix the port list")!.closest<HTMLElement>("[data-thread-meta]")!;
    expect(line.className).toContain("font-mono");
    expect(word("fix the port list")!.className).toContain("truncate");
    expect(provenance("fix the port list").querySelectorAll("[data-slot=badge], .rounded-full, .border")).toHaveLength(0);
    expect(rowOf("fix the port list").className).toBe(rowOf("no project").className);
  });

  it("a long title shares its line with the age only; state, agent and opener sit under it, and every row is one height", async () => {
    const LONG = "Now reply with exactly the word pong.";
    const SHORT = "Reply with exactly the word hi.";
    await mount(
      fakeApi(
        [API],
        [status(API)],
        [
          session("s1", "ws_a", { prompt: LONG, startedBy: "person", startedAt: iso(-48 * 60_000) }),
          session("s2", "ws_a", { status: "completed", prompt: SHORT, startedBy: "cli", startedAt: iso(-30 * 60_000), endedAt: iso(-24 * 60_000) }),
        ],
      ),
      "api",
    );
    await waitFor(() => expect(screen.getByText(LONG)).toBeDefined());
    const title = screen.getByText(LONG);
    expect(title.className).toContain("truncate");
    expect(title.parentElement!.children).toHaveLength(2);
    expect(title.nextElementSibling!.textContent).toBe("48m");
    const meta = rowOf(LONG).querySelector<HTMLElement>("[data-thread-meta]")!;
    expect(meta.contains(title)).toBe(false);
    expect(meta.textContent).toBe("Working··the-project·you");
    expect(meta.className).toContain("font-mono");
    expect(rowOf(SHORT).querySelector("[data-thread-meta]")!.textContent).toBe("·the-project·cli");
    expect(rowOf(SHORT).className).toBe(rowOf(LONG).className);
  });

  it("the idle shelf collapses per workspace and remembers it: the workspace beside it keeps its rows", async () => {
    await mount(
      fakeApi(
        [API, WEB],
        [status(API), status(WEB)],
        [
          session("s1", "ws_a", { prompt: "fix the port list", startedAt: iso(-3 * 60_000) }),
          session("s2", "ws_a", { status: "completed", prompt: "upgrade node", startedAt: iso(-60_000), endedAt: iso(-1_000) }),
          session("s3", "ws_b", { status: "completed", prompt: "bump the lockfile", startedAt: iso(-120_000), endedAt: iso(-2_000) }),
        ],
      ),
      "api",
    );
    const toggle = (id: string): HTMLElement => document.querySelector<HTMLElement>(`[data-row-id='settled:${id}']`)!;
    await waitFor(() => expect(toggle("ws_a")).toBeDefined());
    expect(toggle("ws_a").getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(toggle("ws_a"));
    expect(screen.queryByText("upgrade node")).toBeNull();
    expect(toggle("ws_a").textContent).toContain("Idle (1)");
    expect(toggle("ws_b").getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("bump the lockfile")).toBeDefined();
    expect(window.localStorage.getItem("wsp:sidebar-settled-collapsed")).toBe('["ws_a"]');
    fireEvent.click(toggle("ws_a"));
    expect(screen.getByText("upgrade node")).toBeDefined();
    expect(window.localStorage.getItem("wsp:sidebar-settled-collapsed")).toBe("[]");
  });

  it("a remembered collapse shuts only the workspace it names", async () => {
    window.localStorage.setItem("wsp:sidebar-settled-collapsed", '["ws_a"]');
    await mount(
      fakeApi(
        [API, WEB],
        [status(API), status(WEB)],
        [
          session("s1", "ws_a", { status: "completed", prompt: "upgrade node", startedAt: iso(-60_000), endedAt: iso(-1_000) }),
          session("s2", "ws_a", { status: "completed", prompt: "drop the old shim", startedAt: iso(-120_000), endedAt: iso(-2_000) }),
          session("s3", "ws_b", { status: "completed", prompt: "bump the lockfile", startedAt: iso(-180_000), endedAt: iso(-3_000) }),
        ],
      ),
      "api",
    );
    await waitFor(() => expect(screen.getByText("bump the lockfile")).toBeDefined());
    expect(rowIds()).toEqual(["ws:ws_a", "settled:ws_a", "ws:ws_b", "settled:ws_b", "thread:s3"]);
    expect(screen.getByRole("button", { name: "Idle (2)" })).toBeDefined();
  });

  it("a workspace whose threads are all idle still lists them under the Idle header, and the header collapses them", async () => {
    await mount(
      fakeApi(
        [API],
        [status(API)],
        [
          session("s1", "ws_a", { status: "completed", prompt: "upgrade node", startedAt: iso(-60_000), endedAt: iso(-1_000) }),
          session("s2", "ws_a", { status: "completed", prompt: "bump the lockfile", startedAt: iso(-120_000), endedAt: iso(-2_000) }),
          session("s3", "ws_a", { status: "interrupted", prompt: "drop the old shim", startedAt: iso(-180_000), endedAt: iso(-3_000) }),
        ],
      ),
      "api",
    );
    await waitFor(() => expect(screen.getByText("upgrade node")).toBeDefined());
    expect(rowIds()).toEqual(["ws:ws_a", "settled:ws_a", "thread:s1", "thread:s2", "thread:s3"]);
    fireEvent.click(screen.getByRole("button", { name: /^Idle/ }));
    expect(screen.queryByText("upgrade node")).toBeNull();
    expect(screen.getByRole("button", { name: "Idle (3)" })).toBeDefined();
  });

  it("threads idle past the archive threshold fold into an Archived group under Idle, shut, carrying their count", async () => {
    await mount(
      fakeApi(
        [API],
        [status(API)],
        [
          session("s1", "ws_a", { status: "completed", prompt: "upgrade node", startedAt: iso(-60_000), endedAt: iso(-1_000) }),
          session("s2", "ws_a", { status: "completed", prompt: "bump the lockfile", startedAt: iso(-2 * 24 * 60 * 60_000), endedAt: iso(-25 * 60 * 60_000) }),
          session("s3", "ws_a", { status: "interrupted", prompt: "drop the old shim", startedAt: iso(-9 * 24 * 60 * 60_000), endedAt: iso(-8 * 24 * 60 * 60_000) }),
        ],
      ),
      "api",
    );
    await waitFor(() => expect(screen.getByText("upgrade node")).toBeDefined());
    // The archive sits under the idle shelf, shut, and the two threads quiet for over a day are not drawn.
    expect(rowIds()).toEqual(["ws:ws_a", "settled:ws_a", "thread:s1", "archived:ws_a"]);
    const archived = (): HTMLElement => document.querySelector<HTMLElement>("[data-row-id='archived:ws_a']")!;
    expect(archived().getAttribute("aria-expanded")).toBe("false");
    expect(archived().textContent).toContain("Archived (2)");
    expect(screen.queryByText("bump the lockfile")).toBeNull();
    // One click opens it, and the rows arrive newest end first, as the shelf orders its own.
    fireEvent.click(archived());
    expect(rowIds()).toEqual(["ws:ws_a", "settled:ws_a", "thread:s1", "archived:ws_a", "thread:s2", "thread:s3"]);
    expect(archived().textContent).toContain("Archived");
    expect(archived().textContent).not.toContain("(2)");
    expect(window.localStorage.getItem("wsp:sidebar-archived-open")).toBe('["ws_a"]');
    fireEvent.click(archived());
    expect(screen.queryByText("bump the lockfile")).toBeNull();
    expect(window.localStorage.getItem("wsp:sidebar-archived-open")).toBe("[]");
  });

  it("one click on an archived thread's row opens that thread", async () => {
    await mount(
      fakeApi(
        [API],
        [status(API)],
        [
          session("s1", "ws_a", { status: "completed", prompt: "upgrade node", startedAt: iso(-60_000), endedAt: iso(-1_000) }),
          session("s2", "ws_a", { status: "completed", prompt: "bump the lockfile", threadId: "thr_old", startedAt: iso(-3 * 24 * 60 * 60_000), endedAt: iso(-2 * 24 * 60 * 60_000) }),
        ],
      ),
      "api",
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "Archived (1)" })).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: "Archived (1)" }));
    fireEvent.click(rowOf("bump the lockfile"));
    expect(useStore.getState().selectedId).toBe("ws_a");
    expect(useStore.getState().selectedThreadId).toBe("thr_old");
  });

  it("a workspace whose threads are every one archived still draws the group rather than an empty workspace", async () => {
    await mount(
      fakeApi(
        [API],
        [status(API)],
        [session("s1", "ws_a", { status: "completed", prompt: "upgrade node", startedAt: iso(-9 * 24 * 60 * 60_000), endedAt: iso(-8 * 24 * 60 * 60_000) })],
      ),
      "api",
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "Archived (1)" })).toBeDefined());
    // The shelf still heads them even with nothing of its own to draw, since the archive nests inside it and has
    // to hang from something; shutting it counts the archived thread it takes away.
    expect(rowIds()).toEqual(["ws:ws_a", "settled:ws_a", "archived:ws_a"]);
    fireEvent.click(screen.getByRole("button", { name: "Idle" }));
    expect(rowIds()).toEqual(["ws:ws_a", "settled:ws_a"]);
    expect(screen.getByRole("button", { name: "Idle (1)" })).toBeDefined();
  });

  it("the archive nests inside the idle shelf: shutting the shelf hides the archived header and its rows too", async () => {
    await mount(
      fakeApi(
        [API],
        [status(API)],
        [
          session("s1", "ws_a", { status: "completed", prompt: "upgrade node", startedAt: iso(-60_000), endedAt: iso(-1_000) }),
          session("s2", "ws_a", { status: "completed", prompt: "bump the lockfile", startedAt: iso(-26 * 60 * 60_000), endedAt: iso(-25 * 60 * 60_000) }),
        ],
      ),
      "api",
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "Archived (1)" })).toBeDefined());
    // Open the archive first, so what the shelf hides is a group that was showing its rows.
    fireEvent.click(screen.getByRole("button", { name: "Archived (1)" }));
    expect(rowIds()).toEqual(["ws:ws_a", "settled:ws_a", "thread:s1", "archived:ws_a", "thread:s2"]);
    // Shutting the shelf takes the archive down with it: no thread row of either kind, and no archived header.
    fireEvent.click(screen.getByRole("button", { name: /^Idle/ }));
    expect(rowIds()).toEqual(["ws:ws_a", "settled:ws_a"]);
    expect(screen.queryByText("upgrade node")).toBeNull();
    expect(screen.queryByText("bump the lockfile")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Archived/ })).toBeNull();
    // The shelf counts every thread it hides, the archived one included.
    expect(screen.getByRole("button", { name: "Idle (2)" })).toBeDefined();
    // Opening it again gives the archive back as it was left, open.
    fireEvent.click(screen.getByRole("button", { name: /^Idle/ }));
    expect(rowIds()).toEqual(["ws:ws_a", "settled:ws_a", "thread:s1", "archived:ws_a", "thread:s2"]);
  });

  it("an idle thread's title reads in the muted foreground; a working one's does not", async () => {
    await mount(
      fakeApi(
        [API],
        [status(API)],
        [
          session("s1", "ws_a", { prompt: "fix the port list", startedAt: iso(-3 * 60_000) }),
          session("s2", "ws_a", { status: "completed", prompt: "upgrade node", startedAt: iso(-60_000), endedAt: iso(-1_000) }),
        ],
      ),
      "api",
    );
    await waitFor(() => expect(screen.getByText("upgrade node")).toBeDefined());
    const title = (text: string): HTMLElement => rowOf(text).querySelector<HTMLElement>("[data-thread-title]")!;
    expect(title("upgrade node").className).toContain("text-sidebar-muted-foreground");
    expect(title("fix the port list").className).not.toContain("text-sidebar-muted-foreground");
  });

  it("a workspace row's third line is the branch its copy stands on, cut at the row's cap with the whole of it in its title, and no figure of any kind", async () => {
    const copied = { ...API, copy: { road: "clonefile" as const, path: "/Users/dev/spoo-api", source: "/Users/dev/spoo", base: "abc", branch: "agent/api-port-list", carried: "deps-and-config" as const }, portBase: 3100 };
    await mount(
      fakeApi([copied, WEB], [status(copied, { idleAt: iso(14.5 * 60_000), reach: { state: "slow" } }), status(WEB)]),
      "api",
    );
    await waitFor(() => expect(metaOf(rowOf("api")).textContent).toBe("agent/api-port-list"));
    expect(stateSlot(rowOf("api")).textContent).toBe("");
    expect(stateSlot(rowOf("web")).textContent).toBe("Stopped");
    // A fork carries no copy of a folder, so its third line is empty rather than a figure.
    expect(metaOf(rowOf("web")).textContent).toBe("");
    const meta = metaOf(rowOf("api"));
    expect(meta.className).toContain("font-mono");
    expect(meta.className).toContain("truncate");
    // The meter ticks and nothing on the row moves: spend belongs to the computer's row in Settings.
    act(() =>
      useStore.getState().applyEvent({ type: "workspace.cost", workspaceId: "ws_a", phase: "running", rateUsdPerHour: 0.11, awakeMs: 120_000, accruedUsd: 0.29, at: new Date(NOW).toISOString() }),
    );
    expect(metaOf(rowOf("api")).textContent).toBe("agent/api-port-list");
    expect(rowOf("api").textContent).not.toContain("$");
  });

  it("this computer's own daemon down: the row says No daemon, and the glyph beside it is the start its line names", async () => {
    const MAC: WorkspaceView = { ...view("ws_m", "zingzy-mac"), kind: "local", machineId: "local", project: { id: "pr_1", name: "the-project", path: "/root", computer: "default" }, golden: "" };
    const asked: string[] = [];
    const api = fakeApi([MAC], [{ ...status(MAC), kind: "local", size: { cpu: 10, memMb: 16384 }, rateUsdPerHour: 0, reach: { state: "unreachable" } }]);
    api.restartDaemon = vi.fn(async (id: string) => void asked.push(id));
    await mount(api, "zingzy-mac");
    const row = () => rowOf("zingzy-mac");
    await waitFor(() => expect(stateSlot(row()).textContent).toBe("No daemon"));
    expect(metaOf(row()).textContent).toBe("daemon not running · start it");
    // The line says start it, so the row's own glyph is that start: it used to say it with nothing to press.
    const start = screen.getByRole("button", { name: "Start the daemon of zingzy-mac" });
    expect(screen.queryByRole("button", { name: "New thread in zingzy-mac" })).toBeNull();
    await act(async () => void fireEvent.click(start));
    expect(asked).toEqual(["ws_m"]);
    // And the daemon answering gives the row back its own glyph, with nothing left to start.
    act(() => useStore.getState().applyEvent({ type: "workspace.status", status: { ...status(MAC), kind: "local", size: { cpu: 10, memMb: 16384 }, rateUsdPerHour: 0 } }));
    await waitFor(() => expect(screen.getByRole("button", { name: "New thread in zingzy-mac" })).toBeDefined());
    expect(screen.queryByRole("button", { name: "Start the daemon of zingzy-mac" })).toBeNull();
  });

  it("every workspace row is one three-line height, every thread row one two-line height with no glyph before its title, and the Idle row is the kit row", async () => {
    await mount(
      fakeApi(
        [API],
        [status(API)],
        [
          session("s1", "ws_a", { prompt: "fix the port list", startedAt: iso(-3 * 60_000) }),
          session("s2", "ws_a", { status: "completed", prompt: "upgrade node", startedAt: iso(-60_000), endedAt: iso(-1_000) }),
        ],
      ),
      "api",
    );
    await waitFor(() => expect(screen.getByText("upgrade node")).toBeDefined());
    const heightOf = (row: HTMLElement) => [...row.classList].filter(c => /^(h-|min-h-|py-)/.test(c)).sort();
    // Four lines of room for the row's three slots: the made-of line takes two of them at the sidebar's width.
    expect(heightOf(rowOf("api"))).toEqual(["h-20", "py-1.5"]);
    expect(heightOf(rowOf("fix the port list"))).toEqual(["h-11", "py-1.5"]);
    expect(heightOf(rowOf("upgrade node"))).toEqual(["h-11", "py-1.5"]);
    // A button centres its text unless told otherwise; a short title starts where a long one does.
    for (const row of [rowOf("api"), rowOf("fix the port list")]) expect(row.className).toContain("text-left");
    const idle = screen.getByRole("button", { name: /^Idle/ });
    expect([...idle.classList].filter(c => /^(h-|my-)/.test(c))).toEqual(["h-8"]);
    // The thread title takes the line up to a fixed mono time column at the right, nothing else beside it.
    const title = rowOf("fix the port list").querySelector<HTMLElement>("[data-thread-title]")!;
    expect(title.className).toContain("flex-1");
    expect(title.className).toContain("truncate");
    const time = title.nextElementSibling as HTMLElement;
    expect(title.parentElement!.children).toHaveLength(2);
    expect(time.textContent).toBe("3m");
    expect(time.className).toContain("font-mono");
    expect(time.className).toContain("w-[3ch]");
    expect(time.className).not.toContain("min-w-");
    expect(time.className).toContain("text-right");
    expect(time.className).toContain("shrink-0");
    // Every row in the list is a thread, so nothing leads the title: the title's column is the row's first child.
    expect(rowOf("fix the port list").firstElementChild!.contains(title)).toBe(true);
    expect(rowOf("fix the port list").querySelector("svg.lucide-message-square")).toBeNull();
    expect(rowOf("api").firstElementChild!.getAttribute("aria-hidden")).toBe("true");
  });

  it("while the runtime replaces the machine's helper the row says only that, and goes back to the branch when it lands", async () => {
    const copied = { ...API, copy: { road: "clonefile" as const, path: "/Users/dev/spoo-api", source: "/Users/dev/spoo", base: "abc", branch: "agent/api-port-list", carried: "deps-and-config" as const } };
    await mount(fakeApi([copied, WEB], [status(copied), status(WEB)]), "api");
    await waitFor(() => expect(metaOf(rowOf("api")).textContent).toBe("agent/api-port-list"));

    act(() => useStore.getState().applyEvent({ type: "workspace.status", status: { ...status(copied), daemonNote: DAEMON_UPDATING } }));
    await waitFor(() => expect(metaOf(rowOf("api")).textContent).toBe(DAEMON_UPDATING));
    // The one thing on the row worth waiting for takes the line; the branch waits its turn.
    expect(rowOf("api").textContent).not.toContain("agent/api-port-list");
    expect(stateSlot(rowOf("api")).textContent).toBe("");
    expect(rowOf("web").textContent).not.toContain(DAEMON_UPDATING);

    act(() => useStore.getState().applyEvent({ type: "workspace.status", status: { ...status(copied), daemonNote: DAEMON_UPDATE_FAILED } }));
    await waitFor(() => expect(metaOf(rowOf("api")).textContent).toBe(DAEMON_UPDATE_FAILED));
    // The reason a deploy gave is in the host's log, never on the row: it names the daemon and runs to hundreds of characters.
    expect(rowOf("api").textContent).not.toContain("NPM_FAIL");

    act(() => useStore.getState().applyEvent({ type: "workspace.status", status: status(copied) }));
    await waitFor(() => expect(metaOf(rowOf("api")).textContent).toBe("agent/api-port-list"));
  });

  it("clicking a thread selects it under its workspace; clicking a workspace selects it with no thread pinned", async () => {
    await mount(fakeApi([API, WEB], [status(API), status(WEB)], [session("s1", "ws_b", { prompt: "hello", threadId: "thr_1" })]), "api");
    await waitFor(() => expect(screen.getByText("hello")).toBeDefined());
    fireEvent.click(rowOf("hello"));
    expect(useStore.getState()).toMatchObject({ selectedId: "ws_b", selectedThreadId: "thr_1" });
    expect(rowOf("hello").getAttribute("data-active")).toBe("true");
    expect(rowOf("web").getAttribute("data-active")).toBe("false");
    fireEvent.click(rowOf("api"));
    expect(useStore.getState()).toMatchObject({ selectedId: "ws_a", selectedThreadId: null });
    expect(rowOf("api").getAttribute("data-active")).toBe("true");
    expect(rowOf("hello").getAttribute("data-active")).toBe("false");
  });

  it("clicking a thread row without a thread id selects its workspace with no thread pinned", async () => {
    await mount(fakeApi([API, WEB], [status(API), status(WEB)], [session("s1", "ws_b", { prompt: "before threads" })]), "api");
    await waitFor(() => expect(screen.getByText("before threads")).toBeDefined());
    fireEvent.click(rowOf("before threads"));
    expect(useStore.getState()).toMatchObject({ selectedId: "ws_b", selectedThreadId: null });
    expect(rowOf("web").getAttribute("data-active")).toBe("true");
    expect(rowOf("before threads").getAttribute("data-active")).toBe("false");
  });

  it("a thread's end addressed to me shows as the store toast; one addressed to a thread shows nothing here", async () => {
    await mount(fakeApi([API, WEB], [status(API), status(WEB)], [session("s1", "ws_a", { prompt: "hello" })]), "api");
    const line = "thread c452d1e8 finished (completed, 8m 12s, $1.94): all green";
    useStore.getState().applyEvent({ type: "session.notify", workspaceId: "ws_a", sessionId: "s1", turnId: "t1", threadId: "thr_child", notify: "thr_parent", text: line });
    expect(useStore.getState().toast).toBeNull();
    useStore.getState().applyEvent({ type: "session.notify", workspaceId: "ws_a", sessionId: "s1", turnId: "t1", threadId: "thr_child", notify: "me", text: line });
    expect(useStore.getState().toast).toBe(line);
    expect(await screen.findByRole("status", { name: line })).toBeDefined();
  });

  it("an empty fleet says so; a store toast shows and can be dismissed", async () => {
    const api = fakeApi([], []);
    api.watchStatuses = vi.fn(async () => { throw new Error("runtime unreachable"); });
    useStore.getState().bind(api);
    render(<SidebarProvider defaultOpen><WorkspaceSidebar /></SidebarProvider>);
    await waitFor(() => expect(screen.getByText(/No workspaces yet/)).toBeDefined());
    const toast = await screen.findByRole("status", { name: /runtime unreachable/ });
    fireEvent.click(toast);
    expect(useStore.getState().toast).toBeNull();
    // A toast with no action of its own carries no button, so nothing to press appears beside a plain sentence.
    expect(toast.querySelector("[data-toast-action]")).toBeNull();
  });

  it("carries a close of its own and leaves after a few seconds, so nothing a person did not ask for follows them across pages", async () => {
    const api = fakeApi([], []);
    useStore.getState().bind(api);
    render(<SidebarProvider defaultOpen><WorkspaceSidebar /></SidebarProvider>);
    act(() => useStore.setState({ toast: "runtime unreachable" }));
    const toast = await screen.findByRole("status", { name: /runtime unreachable/ });
    // The whole box was the target before, which is nothing a person can see; the glyph says what it does.
    fireEvent.click(within(toast).getByRole("button", { name: CLOSE_TOAST_LABEL }));
    expect(useStore.getState().toast).toBeNull();

    // And one nobody closes goes on its own: one sat in a corner for four minutes, another for a whole session.
    act(() => useStore.setState({ toast: "runtime unreachable" }));
    await waitFor(() => expect(screen.queryByRole("status")).not.toBeNull());
    await waitFor(() => expect(useStore.getState().toast).toBeNull(), { timeout: TOAST_MS + 2_000 });
  });

  it("a build that needs the person says so in the toast once, with an Open that opens the setup sheet; a later toast takes the slot and its action goes with it", async () => {
    const api = fakeApi([], []);
    useStore.getState().bind(api);
    render(<SidebarProvider defaultOpen><WorkspaceSidebar /></SidebarProvider>);
    await waitFor(() => expect(screen.getByText(/No workspaces yet/)).toBeDefined());
    act(() => useStore.getState().applyEvent({ type: "job.needs-you", jobId: "init_1", needsYou: { what: "sign in to GitHub CLI login", since: 1_760_000_000_000 } }));
    const toast = await screen.findByRole("status", { name: "wsp needs you: sign in to GitHub CLI login" });
    expect(toast.textContent).toContain("wsp needs you: sign in to GitHub CLI login");
    expect(useStore.getState().setupOpen).toBe(false);
    expect(toast.querySelector<HTMLElement>("[data-toast-action]")!.textContent).toBe("Open");

    // A toast said from anywhere else takes the slot, and the Open the need's sentence had does not come with it.
    act(() => useStore.setState({ toast: "runtime unreachable" }));
    const plain = await screen.findByRole("status", { name: "runtime unreachable" });
    expect(plain.querySelector("[data-toast-action]")).toBeNull();

    // The need again, and its Open opens the sheet and clears the sentence it belonged to.
    act(() => useStore.getState().applyEvent({ type: "job.needs-you", jobId: "init_1", needsYou: { what: "sign in to Claude Code login", since: 1_760_000_001_000 } }));
    const again = await screen.findByRole("status", { name: "wsp needs you: sign in to Claude Code login" });
    fireEvent.click(again.querySelector<HTMLElement>("[data-toast-action]")!);
    expect(useStore.getState().setupOpen).toBe(true);
    expect(useStore.getState().toast).toBeNull();
  });
});

describe("new thread", () => {
  it("the plus on a workspace row raises a new-thread request for that workspace and selects it", async () => {
    await mount(fakeApi([API, WEB], [status(API), status(WEB)], [session("s1", "ws_a", { prompt: "hello" })]), "api");
    const seen: string[] = [];
    const off = onNewThreadRequest(d => seen.push(d.workspaceId));
    fireEvent.click(rowOf("api"));
    expect(useStore.getState().selectedId).toBe("ws_a");
    fireEvent.click(screen.getByRole("button", { name: "New thread in web" }));
    expect(seen).toEqual(["ws_b"]);
    expect(useStore.getState().selectedId).toBe("ws_b");
    // The collapse chevron keeps its slot beside the plus on a row with threads.
    expect(screen.getByRole("button", { name: "New thread in api" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Collapse api" })).toBeDefined();
    off();
  });

  it("a workspace with no threads says so under its row, and the line starts a thread too", async () => {
    await mount(fakeApi([API, WEB], [status(API), status(WEB)], [session("s1", "ws_a", { prompt: "hello" })]), "api");
    const seen: string[] = [];
    const off = onNewThreadRequest(d => seen.push(d.workspaceId));
    const item = (row: HTMLElement) => row.closest<HTMLElement>('[data-sidebar="menu-item"]')!;
    const line = screen.getByText(/No threads yet/);
    // Flowing text, not a truncating row: the sentence wraps rather than cuts at a narrow sidebar.
    expect(line.className).not.toMatch(/truncate|whitespace-nowrap/);
    expect(item(line)).toBe(item(rowOf("web")));
    expect(within(item(rowOf("api"))).queryByText(/No threads yet/)).toBeNull();
    fireEvent.click(within(line).getByRole("button", { name: /New thread/ }));
    expect(seen).toEqual(["ws_b"]);
    off();
  });

  it("a send in flight is a row of its own, so a workspace running the first message never reads that it has none", async () => {
    await mount(fakeApi([API, WEB], [status(API), status(WEB)], [session("s1", "ws_a", { prompt: "hello" })]), "api");
    const item = (row: HTMLElement) => row.closest<HTMLElement>('[data-sidebar="menu-item"]')!;
    expect(within(item(rowOf("web"))).queryByText(/No threads yet/)).not.toBeNull();

    // The transcript draws the sent message the moment it is sent; the runtime writes a row only once the agent
    // announces itself, which is seconds later. The line and the row may not both be true at once.
    act(() => useStore.setState({ launches: { ws_b: { requestId: "r1", title: "read the port list", harness: "claude" } } }));
    expect(within(item(rowOf("web"))).queryByText(/No threads yet/)).toBeNull();
    const launched = item(rowOf("web")).querySelector<HTMLElement>("[data-thread-launch]")!;
    expect(launched.querySelector("[data-thread-title]")?.textContent).toBe("read the port list");
    expect(launched.querySelector("[data-thread-meta]")?.textContent).toContain("Working");
    // No time yet: nothing has started to count, and the slot stands at its width all the same.
    expect(launched.querySelectorAll("[data-thread-title] ~ span")[0]?.textContent).toBe("");
    expect(launched.querySelector('svg[data-harness-mark="claude"]')).not.toBeNull();

    // The workspace that has its own rows keeps them; the send belongs to the workspace it was made on.
    expect(item(rowOf("api")).querySelector("[data-thread-launch]")).toBeNull();
  });

  it("no row carries a project glyph, with or without the export op; a live row's glyphs are its chevron and its plus", async () => {
    const api = fakeApi([API, WEB], [status(API), status(WEB)], [session("s1", "ws_a", { prompt: "hello" })]);
    api.exportProject = vi.fn();
    await mount(api, "api");
    expect(screen.queryByRole("button", { name: /Import a project/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Export a project/ })).toBeNull();
    expect(document.querySelector("svg.lucide-folder-input, svg.lucide-folder-output")).toBeNull();
    const glyphs = (row: HTMLElement) => Array.from(row.parentElement!.querySelectorAll<HTMLElement>("[data-sidebar=menu-action]")).map(b => b.getAttribute("aria-label"));
    expect(glyphs(rowOf("api"))).toEqual(["Collapse api", "New thread in api"]);
    expect(glyphs(rowOf("web"))).toEqual(["New thread in web"]);
    // A live row's text runs to its own inset whatever its glyphs, which land in the state slot on hover; the slot yields to them.
    const endPadding = (row: HTMLElement) => [...row.classList].filter(c => /pe-\d/.test(c));
    expect(endPadding(rowOf("api"))).toEqual(endPadding(rowOf("web")));
    expect(endPadding(rowOf("api"))).toEqual(["group-has-data-[sidebar=menu-action]/menu-item:pe-2"]);
    for (const name of ["api", "web"]) {
      expect(stateSlot(rowOf(name)).className).toContain("min-w-[74px]");
      expect(stateSlot(rowOf(name)).className).toContain("group-hover/menu-item:opacity-0");
    }
  });


  it("a zombie row offers the rebuild and no new thread", async () => {
    await mount(fakeApi([API], [status(API, { reach: { state: "zombie" } })]), "api");
    await waitFor(() => expect(screen.getByRole("button", { name: "Rebuild api" })).toBeDefined());
    expect(screen.queryByRole("button", { name: "New thread in api" })).toBeNull();
  });
});


describe("search", () => {
  it("the row is the palette's door: a glyph and the word Search, no chord on its face, and the compose glyph alone at the right edge; a click opens the palette, focus alone does not, and no field ever appears", async () => {
    await mount(fakeApi([API, WEB], [status(API), status(WEB)], [session("s1", "ws_a", { prompt: "hello" })]), "api");
    const opened: boolean[] = [];
    const off = onOpenCommandPalette(detail => opened.push(detail.toggle === true));
    const row = screen.getByRole("button", { name: "Search" });
    expect(row.querySelector("svg.lucide-search")).not.toBeNull();
    expect(row.textContent).toBe("Search");
    expect(row.querySelector("kbd")).toBeNull();
    const compose = screen.getByRole("button", { name: "New thread" });
    expect(compose.closest("[data-sidebar-search]")).not.toBeNull();
    expect(row.contains(compose)).toBe(false);
    expect(row.className).toContain("pe-8");
    // The row is the kit's row on the selected row's surface with the sidebar's hairline: no fill or ring of its own, the hover tint every other row has.
    expect(row.className).toContain("bg-sidebar-row-selected");
    expect(row.className).toContain("border-sidebar-border");
    expect(row.className).not.toMatch(/ring-1|bg-background|bg-sidebar-control-surface/);
    expect(row.className).toContain("hover:bg-sidebar-row-hover");
    expect(row.className).toContain("h-8");
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


describe("the group before the first list has arrived", () => {
  it("says nothing at all while the store is not ready: no rows, no bars, not even the road to a project", () => {
    render(<SidebarProvider defaultOpen><WorkspaceSidebar /></SidebarProvider>);
    expect(screen.queryByText(/No workspaces yet/)).toBeNull();
    expect(rowIds()).toEqual([]);
    expect(document.querySelectorAll("[data-slot=skeleton]").length).toBe(0);
    expect(screen.queryByLabelText("Add a project")).toBeNull();
  });

  it("holds one row once the list has arrived and holds nothing: the road to a project, with no empty state of its own", async () => {
    render(<SidebarProvider defaultOpen><WorkspaceSidebar /></SidebarProvider>);
    act(() => useStore.setState({ ready: true }));
    expect(await screen.findByLabelText("Add a project")).toBeDefined();
    // The empty line belongs to a project with no workspace; with no project at all the centre is the first run.
    expect(screen.queryByText(/No workspaces yet/)).toBeNull();
    expect(rowIds()).toEqual([]);
  });

  it("a creation on its way holds the empty state off while the list is still coming", () => {
    render(<SidebarProvider defaultOpen><WorkspaceSidebar /></SidebarProvider>);
    act(() => useStore.setState({ creations: [{ key: "creating:1", name: "beta", askedAt: Date.now(), workspaceId: null, lines: [], failed: null }] }));
    expect(screen.getByText("beta")).toBeDefined();
    expect(screen.queryByText(/No workspaces yet/)).toBeNull();
  });
});

describe("keyboard navigation", () => {
  it("arrows walk every row in order from the search row; Enter selects", async () => {
    await mount(fakeApi([API, WEB], [status(API), status(WEB)], [session("s1", "ws_a", { prompt: "hello" })]), "api");
    await waitFor(() => expect(screen.getByText("hello")).toBeDefined());
    const search = screen.getByRole("button", { name: "Search" });
    act(() => search.focus());
    fireEvent.keyDown(search, { key: "ArrowDown" });
    expect(document.activeElement).toBe(rowOf("api"));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(rowOf("hello"));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(rowOf("web"));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(rowOf("web"));
    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    expect(document.activeElement).toBe(rowOf("api"));
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(document.activeElement).toBe(rowOf("web"));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
    expect(document.activeElement).toBe(rowOf("hello"));
    fireEvent.click(document.activeElement!);
    expect(useStore.getState().selectedId).toBe("ws_a");
  });
});


describe("gone machines", () => {
  const OLD: WorkspaceView = { ...view("ws_c", "old", "gone"), gone: "machine m_ws_c is gone at the provider: Not found" };

  it("a gone row reads Gone with no rate or countdown, offers the rebuild with the provider's words, and no new thread", async () => {
    await mount(fakeApi([OLD], [status(OLD, { machineState: "gone", reach: { state: "gone" }, reason: OLD.gone! })]), "old");
    const row = rowOf("old");
    expect(row.textContent).toContain("Gone");
    expect(row.textContent).not.toContain("/hr");
    expect(row.textContent).not.toContain("naps");
    expect(row.textContent).not.toContain("active");
    expect(screen.getByRole("button", { name: "Rebuild old" }).getAttribute("title")).toBe("machine m_ws_c is gone at the provider: Not found");
    expect(screen.queryByRole("button", { name: "New thread in old" })).toBeNull();
  });

  it("a record still saying running whose status found the machine gone reads Gone, and no figure reaches the row whatever the meter says", async () => {
    const gone = status(API, { machineState: "gone", reach: { state: "gone" }, idleAt: NOW + 17 * 60_000, rateUsdPerHour: 0.11, reason: "machine m_ws_a is gone at the provider: the status poll found it gone at 2026-09-06T10:21:04Z" });
    await mount(fakeApi([API], [gone]), "api");
    act(() => useStore.getState().applyEvent({ type: "workspace.cost", workspaceId: "ws_a", phase: "running", rateUsdPerHour: 0.11, awakeMs: 60_000, accruedUsd: 0.18, at: new Date(NOW).toISOString() }));
    const row = rowOf("api");
    await waitFor(() => expect(row.textContent).toContain("Gone"));
    expect(row.textContent).not.toContain("/hr");
    expect(row.textContent).not.toContain("naps");
    expect(row.textContent).not.toContain("active");
    // What a machine costs is its computer's row in Settings; no row here carries a figure.
    expect(row.textContent).not.toContain("$0.18");
    expect(screen.getByRole("button", { name: "Rebuild api" }).getAttribute("title")).toBe(gone.reason!);
  });

  it("a gone row offers forget beside the rebuild; confirming names what goes, calls the api once, and the row leaves on workspace.deleted", async () => {
    const api = await mount(fakeApi([OLD], [status(OLD)], [session("s1", "ws_c", { prompt: "fix the port list", status: "completed" })]), "old");
    await waitFor(() => expect(stateSlot(rowOf("old")).textContent).toBe("Gone"));
    // The two recovery glyphs sit in the row's two right-edge slots, forget before rebuild, on hover like every
    // row's glyphs: the resting row carries its word alone, and the word yields to them so nothing moves.
    const recovery = Array.from(rowOf("old").parentElement!.querySelectorAll<HTMLElement>("[data-sidebar=menu-action]"));
    expect(recovery.map(b => b.getAttribute("aria-label"))).toEqual(["Forget old", "Rebuild old"]);
    expect(recovery.map(b => [...b.classList].find(c => c.startsWith("right-")))).toEqual(["right-7", "right-2"]);
    for (const glyph of recovery) expect(glyph.className).toContain("md:opacity-0");
    expect(stateSlot(rowOf("old")).className).toContain("group-hover/menu-item:opacity-0");
    expect([...rowOf("old").classList].filter(c => /pe-\d/.test(c))).toEqual(["group-has-data-[sidebar=menu-action]/menu-item:pe-2"]);
    fireEvent.click(screen.getByRole("button", { name: "Forget old" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("Forget old?");
    expect(dialog.textContent).toContain("Its record and 1 thread leave this computer; the computer it ran on is already gone.");
    expect(api.forget).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Forget" }));
    await waitFor(() => expect(api.forget).toHaveBeenCalledTimes(1));
    expect(api.forget).toHaveBeenCalledWith("ws_c");
    act(() => useStore.getState().applyEvent({ type: "workspace.deleted", workspaceId: "ws_c" }));
    await waitFor(() => expect(screen.queryByText("old")).toBeNull());
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("the host's refusal shows in the dialog and the row stays", async () => {
    const api = await mount(fakeApi([OLD], [status(OLD)]), "old");
    const reason = "old's machine m_ws_c is still running; pause it or delete it at the provider first";
    api.forget.mockRejectedValueOnce(new RequestError(reason, "conflict"));
    fireEvent.click(screen.getByRole("button", { name: "Forget old" }));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Forget" }));
    await waitFor(() => expect(screen.getByText(reason)).toBeDefined());
    expect(rowOf("old").textContent).toContain("Gone");
  });
});

describe("a machine that stopped answering with memory near full", () => {
  it("the row's second line is the short form with the last figures, and clears when the link is back", async () => {
    const GiB = 1024 ** 3;
    resetLive();
    await mount(fakeApi([API], [status(API, { reach: { state: "unreachable" } })]), "api");
    act(() => {
      getLive("ws_a").feedStatus("live");
      getLive("ws_a").feedSample({ type: "sys.sample", cpu: 99, load1: 6.4, mem: { used: 3.59 * GiB, total: 3.94 * GiB }, disk: { used: 1, total: 10 }, at: 1 });
    });
    const meta = () => rowOf("api").querySelector("[data-workspace-meta]")?.textContent ?? "";
    expect(meta()).not.toContain("Out of memory");
    act(() => getLive("ws_a").feedStatus("connecting"));
    await waitFor(() => expect(meta()).toBe("out of memory, 3.6 of 3.9 GB"));
    expect(rowOf("api").textContent).toContain("Unreachable");
    act(() => getLive("ws_a").feedStatus("live"));
    await waitFor(() => expect(meta()).not.toContain("Out of memory"));
  });
});

describe("the row's third line after a bring back", () => {
  it("is drawn whole, cut by the slot's own width and by no count of characters, with the host's note on the hover", async () => {
    await mount(fakeApi([API], [status(API)]), "api");
    const note = "no signed-in command line for github.com is on this computer; the branch is pushed and the pull request waits for one";
    act(() => useStore.setState({ broughtBack: { ws_a: { branch: "agent/readme-badge", base: "main", ahead: 1, uncommitted: 0, stat: [], note } } }));
    const meta = () => metaOf(rowOf("api"));
    // 44 characters, over the cap a row used to cut every line three at; the slot wears truncate and the width
    // decides, so at a wider sidebar the whole of it reads.
    await waitFor(() => expect(meta().textContent).toBe("agent/readme-badge · pushed, no pull request"));
    expect(meta().className.split(" ")).toContain("truncate");
    expect(meta().getAttribute("title")).toBe(`agent/readme-badge · pushed, no pull request: ${note}`);
  });
});

describe("zombie machines", () => {
  it("reads as its own state with the reason on hover and a one-shot rebuild", async () => {
    const zombie = status(API, { reach: { state: "zombie" }, reason: "exec probe failed after 3 tries; slow since 12:01" });
    const api = await mount(fakeApi([API], [zombie]), "api");
    await waitFor(() => expect(rowOf("api").textContent).toContain("Unreachable"));
    expect(rowOf("api").textContent).not.toContain("Running");
    const rebuild = screen.getByRole("button", { name: "Rebuild api" });
    expect(rebuild.getAttribute("title")).toContain("exec probe failed");
    fireEvent.click(rebuild);
    fireEvent.click(rebuild);
    await waitFor(() => expect(api.rebuild).toHaveBeenCalledTimes(1));
    expect(api.rebuild).toHaveBeenCalledWith("ws_a");
    expect(screen.getByRole("button", { name: "Rebuild api" }).hasAttribute("disabled")).toBe(true);
    act(() => useStore.getState().applyEvent({ type: "workspace.status", status: { ...status(API), machineId: "m_rebuilt" } }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Rebuild api" })).toBeNull());
    expect(stateSlot(rowOf("api")).textContent).toBe("");
  });
});

describe("Solari out of reach from this computer", () => {
  it("a status whose probe never left this computer puts one muted mono line under the search row, leaves every row's word alone, and the line goes when a probe gets out again", async () => {
    await mount(fakeApi([API, WEB], [status(API), status(WEB)]), "api");
    await waitFor(() => expect(stateSlot(rowOf("web")).textContent).toBe("Stopped"));
    expect(stateSlot(rowOf("api")).textContent).toBe("");
    expect(screen.queryByText(PROVIDER_UNREACHED_LINE)).toBeNull();

    act(() => useStore.getState().applyEvent({ type: "workspace.status", status: status(API, { reach: { state: "reachable", offline: true } }) }));
    const line = await screen.findByText(PROVIDER_UNREACHED_LINE);
    expect(line.closest("[data-sidebar-search]")).not.toBeNull();
    expect(line.className).toContain("font-mono");
    expect(line.className).not.toMatch(/border|bg-|badge|chip|destructive|warning|success/);
    expect(stateSlot(rowOf("api")).textContent).toBe("");
    expect(rowOf("api").textContent).not.toContain("Unreachable");
    expect(stateSlot(rowOf("web")).textContent).toBe("Stopped");
    // The line reads once, however many rows carry the flag.
    act(() => useStore.getState().applyEvent({ type: "workspace.status", status: status(WEB, { reach: { state: "napping", offline: true } }) }));
    expect(screen.getAllByText(PROVIDER_UNREACHED_LINE)).toHaveLength(1);

    act(() => useStore.getState().applyEvent({ type: "workspace.status", status: status(API) }));
    act(() => useStore.getState().applyEvent({ type: "workspace.status", status: status(WEB) }));
    await waitFor(() => expect(screen.queryByText(PROVIDER_UNREACHED_LINE)).toBeNull());
  });

  it("keeps the slot under the search row for the host's own two lines, never a workspace's link", async () => {
    await mount(fakeApi([API, WEB], [status(API), status(WEB)]), "api");
    await waitFor(() => expect(rowOf("api")).toBeDefined());
    // The workspace on screen has a link that nothing has answered on. Its sentence belongs to the pane that
    // asked and to the composer under the box, both of which sit beside the workspace they name; drawn here, in
    // the opposite corner, it read as a line about nothing and named no workspace.
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
    // The two the slot does carry stay: this computer asleep, and a poll that never left it.
    act(() => useStore.getState().applyEvent({ type: "workspace.status", status: status(API, { reach: { state: "reachable", offline: true } }) }));
    expect((await screen.findByText(PROVIDER_UNREACHED_LINE)).closest("[data-sidebar-search]")).not.toBeNull();
    act(() => useStore.getState().applyEvent({ type: "workspace.status", status: status(API) }));
  });

  it("names where it runs in the meta line's mono, drops the workspace it shares with the row above it, and stands without the word Working while it works", async () => {
    const lead = session("s1", "ws_a", { prompt: "ship the search rewrite", startedBy: "person", threadId: "th_lead" });
    await mount(
      fakeApi(
        [API],
        // The provider the record carries is what the row names, never the id the provider minted for the machine.
        [status(API, { machineId: "sb_9f2c1d8a", project: { id: "pr_1", name: "the-project", path: "/root", computer: "default" }, provider: "solari" })],
        [
          lead,
          session("s2", "ws_a", { prompt: "write the migration", startedBy: "agent", threadId: "th_mig", parentThreadId: "th_lead" }),
          session("s3", "ws_a", { status: "failed", prompt: "review the diff", startedBy: "agent", threadId: "th_rev", parentThreadId: "th_lead" }),
        ],
      ),
      "api",
    );
    await waitFor(() => expect(screen.getByText("write the migration")).toBeDefined());
    const meta = (title: string): HTMLElement => rowOf(title).querySelector<HTMLElement>("[data-thread-meta]")!;
    // The workspace it runs in is the one it is drawn under, so the slot holds where that workspace runs and nothing else.
    expect(meta("write the migration").textContent).toBe("·solari");
    expect(meta("write the migration").className).toContain("font-mono");
    // The dot alone says it works, the rule a workspace row already follows; a row that failed keeps its word.
    expect(meta("write the migration").textContent).not.toContain("Working");
    expect(meta("review the diff").textContent).toBe("Failed··solari");
    // The opener word is dropped on a spawned row: the indent says an agent opened it. The row above keeps both.
    expect(meta("write the migration").textContent).not.toContain("agent");
    expect(meta("ship the search rewrite").textContent).toBe("Working··the-project·you");
    expect(rowOf("write the migration").className).toContain("pl-5");
    expect(rowOf("write the migration").querySelector("[data-thread-provenance]")!.getAttribute("aria-label")).toBe("Claude Code · solari");
  });
});

describe("a thread an agent opened on another workspace", () => {
  // The orchestrator's own workspace is this computer and the builder it opened runs on a fork at a provider; the
  // sidebar files each thread under the workspace its session belongs to, which is what used to part the two.
  const MAC = { ...view("ws_mac", "zingzy's Mac", "running", 3 * 60 * 60_000), kind: "local" as const };
  const BENCH = view("ws_bench", "spoo-bench", "running", 60 * 60_000);

  const opened = async () =>
    mount(
      fakeApi(
        [MAC, BENCH],
        [status(MAC), status(BENCH, { machineId: "sb_9f2c1d8a", project: { id: "pr_1", name: "the-project", path: "/root", computer: "default" }, provider: "ascii" })],
        [
          session("s1", "ws_mac", { prompt: "run the migration across the fleet", startedBy: "person", threadId: "th_lead", startedAt: iso(-60_000) }),
          session("s2", "ws_bench", { prompt: "benchmark the new index", startedBy: "agent", threadId: "th_bench", parentThreadId: "th_lead", startedAt: iso(-600_000) }),
        ],
      ),
      "zingzy's Mac",
    );

  it("is drawn one step in under the thread that opened it, not under the workspace its session is filed against", async () => {
    await opened();
    await waitFor(() => expect(screen.getByText("benchmark the new index")).toBeDefined());
    expect(rowIds()).toEqual(["ws:ws_mac", "thread:th_lead", "thread:th_bench", "ws:ws_bench"]);
    expect(rowOf("benchmark the new index").className).toContain("pl-5");
  });

  it("names the workspace it runs in and then where that workspace runs, the two facts the row above it does not carry", async () => {
    await opened();
    await waitFor(() => expect(screen.getByText("benchmark the new index")).toBeDefined());
    const meta = (title: string): HTMLElement => rowOf(title).querySelector<HTMLElement>("[data-thread-meta]")!;
    expect(meta("benchmark the new index").textContent).toBe("·spoo-bench·ascii");
    // A spawned row at work says no word at all, and the opener word is dropped: the indent already says both.
    expect(meta("benchmark the new index").textContent).not.toContain("Working");
    expect(meta("benchmark the new index").textContent).not.toContain("agent");
    expect(meta("run the migration across the fleet").textContent).toBe("Working··the-project·you");
    expect(rowOf("benchmark the new index").querySelector("[data-thread-provenance]")!.getAttribute("aria-label")).toBe("Claude Code · spoo-bench · ascii");
  });
});

describe("the row's third line", () => {
  it("is handed over whole for the slot's own width to cut, with the whole sentence on the row's hover text", async () => {
    // A sentence the runtime writes, longer than the row's room: the slot truncates it at the width the person
    // has, and the same string is the hover, so a wider sidebar reads more of it and none of it is decided here.
    const note = "putting the helper back on this machine";
    await mount(fakeApi([API], [status(API, { daemonNote: note })]), "api");
    const line = () => metaOf(rowOf("api"));
    await waitFor(() => expect(line().textContent).toBe(note));
    expect(line().className.split(" ")).toContain("truncate");
    expect(line().getAttribute("title")).toBe(note);
    // A line inside the room is left whole, and its title is the same words.
    act(() => useStore.getState().applyEvent({ type: "workspace.status", status: status(API, { daemonNote: "updating the helper" }) }));
    await waitFor(() => expect(line().textContent).toBe("updating the helper"));
    expect(line().getAttribute("title")).toBe("updating the helper");
    // A nap that saved no backup never takes this line: it is a note on a step already taken, and this slot is the
    // workspace's state and its spend. The verdict reads on the pane's own backup line.
    act(() => useStore.getState().applyEvent({ type: "workspace.status", status: status(API, { vaultedAt: "2026-09-08T07:10:04.444Z", vaultRefused: "the export was 646 MB, over the 200 MB cap" }) }));
    await waitFor(() => expect(line().textContent).not.toBe("updating the helper"));
    expect(rowOf("api").textContent).not.toContain("backup");
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

  it("the rows on the sleeping computer take no green and keep an empty state slot, while a workspace at a provider keeps the word it was last known by", async () => {
    served(false);
    const MAC = { ...view("ws_mac", "this Mac"), kind: "local" as const };
    await mount(fakeApi([MAC, WEB], [status(MAC), status(WEB)]), "this Mac");
    const glyph = (name: string) => [...rowOf(name).querySelector("[data-workspace-lead] svg")!.classList];
    await waitFor(() => expect(glyph("this Mac")).toContain("text-success-foreground"));
    act(() => useStore.getState().setConn("reconnecting"));
    await screen.findByText(HOST_ASLEEP_LINE);
    // Its computer is the one asleep, so nothing here knows what it is doing: no green, and no word in its slot.
    expect(glyph("this Mac")).not.toContain("text-success-foreground");
    expect(stateSlot(rowOf("this Mac")).textContent).toBe("");
    // A workspace at a provider keeps running while that computer sleeps, so its row is left as it was.
    expect(stateSlot(rowOf("web")).textContent).toBe("Stopped");
    act(() => useStore.getState().setConn("live"));
    await waitFor(() => expect(glyph("this Mac")).toContain("text-success-foreground"));
  });

  it("says nothing of the kind on the computer the host runs on, where the page carries the host's own token", async () => {
    served(true);
    await mount(fakeApi([API], [status(API)]), "api");
    act(() => useStore.getState().setConn("reconnecting"));
    await waitFor(() => expect(useStore.getState().conn).toBe("reconnecting"));
    expect(screen.queryByText(HOST_ASLEEP_LINE)).toBeNull();
  });
});
