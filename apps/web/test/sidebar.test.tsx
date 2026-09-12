// SPDX-License-Identifier: AGPL-3.0-only
// The workspace sidebar over the fixture wire: rows from the store's
// workspaces, statuses, costs and sessions; grouping; search; keyboard
// traversal; the new-workspace dialog; the zombie rebuild and the gone forget.
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { cloneElement, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DAEMON_UPDATE_FAILED, DAEMON_UPDATING, DEFAULT_PREFERENCES, DEFAULT_THEME, DROP_A_FOLDER_LINE, FREE_WORD, HOST_ASLEEP_LINE, PROVIDER_UNREACHED_LINE, exportFromLine, harmonyDots, importIntoLine, registerRequest, registeredLine, type SessionView, type WorkspaceLook, type WorkspaceStatus, type WorkspaceTheme, type WorkspaceView } from "@wsp/protocol";
import { WORKSPACE_WORDS } from "../src/actions/format.js";
import { onOpenCommandPalette } from "../src/commandPaletteBus.js";
import { SidebarProvider } from "../src/components/ui/sidebar.js";
import { getLive, resetLive } from "../src/machine/live.js";
import { RequestError, type Api } from "../src/protocol/client.js";
import { useStore } from "../src/protocol/store.js";
import { SETTINGS_WORDS } from "../src/settings/format.js";
import { statusOf } from "./workspace-status.js";
import { onNewThreadRequest, requestProjectTrip, requestRenameWorkspace } from "../src/shell/shellRequests.js";
import { useSpaceTheme } from "../src/sidebar/sidebarMode.js";
import { SWIPE_GAP_MS } from "../src/sidebar/spaceSwipe.js";
import { glyphStateClass, leadDimClass } from "../src/sidebar/workspaceRows.js";
import { WorkspaceSidebar } from "../src/sidebar/WorkspaceSidebar.js";
import { caps } from "./caps.js";
import { noDaemonApi } from "./fake-daemon-api.js";

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

const view = (id: string, name: string, phase: WorkspaceView["phase"] = "running"): WorkspaceView => ({
  id,
  name,
  machineId: `m_${id}`,
  phase,
  golden: "snap_g",
  createdAt: new Date(NOW - 60 * 60_000).toISOString(),
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
  createFromGoldenHead: ReturnType<typeof vi.fn>;
  rebuild: ReturnType<typeof vi.fn>;
  forget: ReturnType<typeof vi.fn>;
  watchStatuses: ReturnType<typeof vi.fn>;
};

function fakeApi(workspaces: WorkspaceView[], statuses: WorkspaceStatus[], sessions: SessionView[] = []): FakeApi {
  return {
    listWorkspaces: vi.fn(async () => workspaces),
    getWorkspace: vi.fn(async id => workspaces.find(w => w.id === id)!),
    createWorkspace: vi.fn(async () => workspaces[0]!),
    createFromGoldenHead: vi.fn(async (name: string) => view("ws_new", name)),
    watchStatuses: vi.fn(async () => statuses),
    nap: vi.fn(async (id: string) => view(id, "?", "napping")),
    wake: vi.fn(async (id: string) => view(id, "?", "running")),
    rebuild: vi.fn(async (id: string) => ({ ...view(id, "?", "running"), machineId: "m_rebuilt" })),
    forget: vi.fn(async (_id: string) => {}),
    upgrade: vi.fn(async (id: string) => view(id, "?", "running")),
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

beforeEach(() => {
  window.localStorage.clear();
  useStore.setState({ api: null, conn: "live", capabilities: null, workspaces: [], statuses: {}, costs: {}, spending: {}, toast: null, toastAction: null, setupOpen: false, selectedId: null, selectedThreadId: null, creations: [], sessions: {}, ready: false, preferences: { ...DEFAULT_PREFERENCES, labs: true }, settingsOpen: false });
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
    // status pills: the running one works, the one that never settled ended, the idle one is plain
    expect(within(rowOf("fix the port list")).getByLabelText("Working")).toBeDefined();
    expect(within(rowOf("59094224-bb3d")).getByLabelText("Ended")).toBeDefined();
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
    expect(within(rowOf("fix the port list")).getByLabelText("Needs you")).toBeDefined();
    expect(within(rowOf("fix the port list")).queryByLabelText("Working")).toBeNull();
    // The workspace's own row carries the sentence a person is waiting on, cut at the row's cap.
    expect(rowOf("api").textContent).toContain("Permission for Bash: Check");
    act(() => useStore.setState({ sessions: { ws_a: [session("s1", "ws_a", { prompt: "fix the port list", startedAt: iso(-3 * 60_000) })] } }));
    await waitFor(() => expect(within(rowOf("fix the port list")).getByLabelText("Working")).toBeDefined());
    expect(rowOf("api").textContent).not.toContain("Permission for Bash");
  });

  it("three workspaces in mixed states: the running one leads, then the paused, then the gone, whatever order they were created in; a creating row sits above them all", async () => {
    const gone = { ...view("ws_gone", "scratch"), createdAt: new Date(NOW - 3 * 24 * 60 * 60_000).toISOString() };
    const paused = { ...view("ws_nap", "spike", "napping"), createdAt: new Date(NOW - 2 * 60 * 60_000).toISOString() };
    const running = { ...view("ws_run", "dev"), createdAt: new Date(NOW - 60_000).toISOString() };
    await mount(fakeApi([gone, paused, running], [status(gone, { machineState: "gone", reach: { state: "gone" } }), status(paused), status(running)]), "dev");
    await waitFor(() => expect(rowIds()).toEqual(["ws:ws_run", "ws:ws_nap", "ws:ws_gone"]));
    // The state slot: the running row says nothing in words (the dot says it); every other state's word sits in it.
    expect(rowOf("dev").textContent).not.toContain("Running");
    expect(stateSlot(rowOf("dev")).textContent).toBe("");
    expect(stateSlot(rowOf("spike")).textContent).toBe("Paused");
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
    act(() => useStore.setState({ creations: [{ key: "creating:1", name: "beta", workspaceId: null, lines: [], failed: null }] }));
    expect(rowIds()).toEqual(["creating:1", "ws:ws_run", "ws:ws_nap", "ws:ws_gone"]);
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
    expect(reads("fix the port list")).toEqual({ label: "Claude Code · cli", text: "·cli", mark: "claude", svg: "svg", tone: "text-agent-claude", size: "size-[13px]" });
    expect(reads("upgrade node")).toEqual({ label: "Codex · you", text: "·you", mark: "codex", svg: "svg", tone: undefined, size: "size-[13px]" });
    expect(reads("before provenance")).toEqual({ label: "Claude Code · you", text: "·you", mark: "claude", svg: "svg", tone: "text-agent-claude", size: "size-[13px]" });
    expect(reads("from the director")).toEqual({ label: "Claude Code · agent", text: "·agent", mark: "claude", svg: "svg", tone: "text-agent-claude", size: "size-[13px]" });
    const line = provenance("fix the port list").closest<HTMLElement>("[data-thread-meta]")!;
    expect(line.className).toContain("font-mono");
    expect(line.className).toContain("text-[var(--top-row-meta)]");
  });

  it("a thread row's second line carries the project its folder sits in beside the agent's mark, in the meta line's muted mono, and a row without one keeps the same height and grammar", async () => {
    const projects = [{ name: "spoo", dest: "/root/spoo", importedAt: "2026-09-01T00:00:00Z" }, { name: "wsp", dest: "/root/wsp", importedAt: "2026-09-02T00:00:00Z" }];
    await mount(
      fakeApi(
        [{ ...API, projects }],
        [status({ ...API, projects })],
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
    expect(word("fix the port list")!.textContent).toBe("spoo");
    expect(word("upgrade node")!.textContent).toBe("wsp");
    expect(word("no project")!.textContent).toBe("you");
    // Mark, then the project, then who opened it: `✳ · spoo · cli`, the dots drawn as text and not as chips.
    expect(provenance("fix the port list").textContent).toBe("·spoo·cli");
    expect(provenance("fix the port list").getAttribute("aria-label")).toBe("Claude Code · spoo · cli");
    expect(provenance("no project").textContent).toBe("·you");
    expect(provenance("no project").getAttribute("aria-label")).toBe("Claude Code · you");
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
    expect(meta.textContent).toBe("Working··you");
    expect(meta.className).toContain("font-mono");
    expect(rowOf(SHORT).querySelector("[data-thread-meta]")!.textContent).toBe("·cli");
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

  it("a workspace row's meta line is one mono line in a fixed order: cost today, the edge note, the nap countdown last, cut at the row's cap with the whole of it in its title", async () => {
    await mount(
      fakeApi(
        [API, WEB],
        [status(API, { idleAt: iso(14.5 * 60_000), reach: { state: "slow" } }), status(WEB)],
      ),
      "api",
    );
    // The cost leads before the meter's first tick too: a paused row is never a blank line.
    await waitFor(() => expect(metaOf(rowOf("api")).textContent).toBe("$0.00 today · edge slow…"));
    expect(stateSlot(rowOf("api")).textContent).toBe("");
    expect(stateSlot(rowOf("web")).textContent).toBe("Paused");
    expect(metaOf(rowOf("web")).textContent).toBe("$0.00 today");
    act(() =>
      useStore.getState().applyEvent({ type: "workspace.cost", workspaceId: "ws_a", phase: "running", rateUsdPerHour: 0.11, awakeMs: 120_000, accruedUsd: 0.29, at: new Date(NOW).toISOString() }),
    );
    await waitFor(() => expect(metaOf(rowOf("api")).textContent).toBe("$0.29 today · edge slow…"));
    const meta = metaOf(rowOf("api"));
    // What was cut is on the row's hover text whole, so nothing a person needs is only half said.
    expect(meta.getAttribute("title")).toBe("$0.29 today · edge slow · naps in 14m");
    expect(meta.className).toContain("font-mono");
    expect(meta.className).toContain("truncate");
    // The whole line is one span: the width cuts it from the right, nothing decides what to leave out.
    expect(meta.children).toHaveLength(0);
    act(() => useStore.getState().applyEvent({ type: "workspace.status", status: status(API) }));
    await waitFor(() => expect(metaOf(rowOf("api")).textContent).toBe("$0.29 today · active"));
  });

  it("every row leads with its kind's glyph and no state dot: the laptop for this computer, the cloud for a fork, green while the machine runs and muted otherwise; line two says what the machine is, line three what it costs, and the state is a word on the right", async () => {
    const MAC: WorkspaceView = { ...view("ws_m", "zingzy-mac"), kind: "local", machineId: "local", golden: "" };
    const OLD = view("ws_c", "old", "gone");
    await mount(fakeApi([API, WEB, MAC, OLD], [status(API, { idleAt: iso(14.5 * 60_000) }), status(WEB), { ...status(MAC), kind: "local", size: { cpu: 10, memMb: 16384 }, rateUsdPerHour: 0 }, status(OLD, { machineState: "gone", reach: { state: "gone" } })]), "api");
    await waitFor(() => expect(rowOf("zingzy-mac")).toBeDefined());
    await waitFor(() => expect(rowOf("old")).toBeDefined());
    const lead = (row: HTMLElement) => row.querySelector<HTMLElement>("[data-workspace-lead]")!;
    const glyphClass = (row: HTMLElement) => lead(row).querySelector("svg")!.getAttribute("class") ?? "";
    const glyphClasses = (row: HTMLElement) => glyphClass(row).split(" ");
    expect(glyphClass(rowOf("zingzy-mac"))).toContain("lucide-laptop");
    expect(glyphClass(rowOf("api"))).toContain("lucide-cloud");
    expect(glyphClass(rowOf("web"))).toContain("lucide-cloud");
    for (const name of ["zingzy-mac", "api", "web", "old"]) {
      expect(lead(rowOf(name)).querySelector(".rounded-full")).toBeNull();
      expect(glyphClass(rowOf(name))).not.toMatch(/destructive|warning|info/);
    }
    // The glyph's hue is the machine's state and only that: the success green while it runs, on a fork and on this
    // computer alike, in place of the muted ink; paused dims the muted ink to half; gone keeps it whole. One rule.
    for (const name of ["api", "zingzy-mac"]) {
      expect(glyphClasses(rowOf(name))).toContain(glyphStateClass({ state: "running" }));
      expect(glyphClasses(rowOf(name))).not.toContain("text-muted-foreground/60");
      expect(glyphClasses(rowOf(name))).not.toContain("opacity-50");
    }
    for (const name of ["web", "old"]) {
      expect(glyphClasses(rowOf(name))).toContain("text-muted-foreground/60");
      expect(glyphClasses(rowOf(name))).not.toContain(glyphStateClass({ state: "running" }));
    }
    expect(glyphClasses(rowOf("web"))).toContain("opacity-50");
    expect(glyphClasses(rowOf("old"))).not.toContain("opacity-50");
    // The class the glyph wears is the only thing that changes with the state: the box it sits in is one for every row.
    const glyphBox = (row: HTMLElement) => glyphClasses(row).filter(c => /^(size-|mt-)/.test(c)).sort();
    for (const name of ["zingzy-mac", "web", "old"]) expect(glyphBox(rowOf(name))).toEqual(glyphBox(rowOf("api")));
    const machineOf = (row: HTMLElement) => row.querySelector<HTMLElement>("[data-workspace-machine]")!;
    // This computer's second line is its cores and memory, in the grammar a fork's row reads its size in.
    expect(machineOf(rowOf("zingzy-mac")).textContent).toBe("10 cores · 16 GB");
    expect(machineOf(rowOf("api")).textContent).toBe("2 vCPU · 4 GB");
    expect(metaOf(rowOf("zingzy-mac")).textContent).toBe(FREE_WORD);
    expect(stateSlot(rowOf("zingzy-mac")).textContent).toBe("");
    // The cloud rows beside it: the spend, the countdown and the paused word all read in their own slots.
    expect(metaOf(rowOf("api")).textContent).toBe("$0.00 today · naps in 14m");
    expect(stateSlot(rowOf("web")).textContent).toBe("Paused");
    for (const name of ["zingzy-mac", "api", "web", "old"]) {
      expect(machineOf(rowOf(name)).className).toContain("font-mono");
      expect(machineOf(rowOf(name)).getAttribute("title")).toBe(machineOf(rowOf(name)).textContent);
    }
    // One row grammar for both kinds: the same lead slot and the same height.
    const boxOf = (row: HTMLElement) => [...row.firstElementChild!.classList].filter(c => /^(size-|mt-)/.test(c)).sort();
    expect(boxOf(rowOf("zingzy-mac"))).toEqual(boxOf(rowOf("api")));
    const heightOf = (row: HTMLElement) => [...row.classList].filter(c => /^(h-|py-)/.test(c)).sort();
    expect(heightOf(rowOf("zingzy-mac"))).toEqual(heightOf(rowOf("api")));
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
    expect(heightOf(rowOf("api"))).toEqual(["h-15", "py-1.5"]);
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

  it("while the runtime replaces the machine's helper the row says only that, and clears when it lands", async () => {
    await mount(fakeApi([API, WEB], [status(API, { idleAt: iso(14.5 * 60_000) }), status(WEB)]), "api");
    await waitFor(() => expect(rowOf("api").textContent).toContain("naps in 14m"));

    act(() => useStore.getState().applyEvent({ type: "workspace.status", status: { ...status(API, { idleAt: iso(14.5 * 60_000) }), daemonNote: DAEMON_UPDATING } }));
    await waitFor(() => expect(rowOf("api").textContent).toContain(DAEMON_UPDATING));
    // The one thing on the row worth waiting for takes the line; the rate and the countdown wait their turn.
    expect(rowOf("api").textContent).not.toContain("naps in 14m");
    expect(rowOf("api").textContent).not.toContain("$0.110/hr");
    expect(stateSlot(rowOf("api")).textContent).toBe("");
    expect(rowOf("web").textContent).not.toContain(DAEMON_UPDATING);

    act(() => useStore.getState().applyEvent({ type: "workspace.status", status: { ...status(API, { idleAt: iso(14.5 * 60_000) }), daemonNote: DAEMON_UPDATE_FAILED } }));
    await waitFor(() => expect(rowOf("api").textContent).toContain(DAEMON_UPDATE_FAILED));
    // The reason a deploy gave is in the host's log, never on the row: it names the daemon and runs to hundreds of characters.
    expect(rowOf("api").textContent).not.toContain("NPM_FAIL");

    act(() => useStore.getState().applyEvent({ type: "workspace.status", status: status(API, { idleAt: iso(14.5 * 60_000) }) }));
    await waitFor(() => expect(rowOf("api").textContent).toContain("naps in 14m"));
    expect(rowOf("api").textContent).not.toContain("helper");
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

  it("no row carries an import or export glyph, with or without the project ops; a live row's glyphs are its chevron and its plus", async () => {
    const api = fakeApi([API, WEB], [status(API), status(WEB)], [session("s1", "ws_a", { prompt: "hello" })]);
    api.planProject = vi.fn(async () => ({ source: "/private/var/proj", repo: true, files: 3, bytes: 900, secrets: [], excluded: [], skipped: [], agents: [] }));
    api.importProject = vi.fn();
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
      expect(stateSlot(rowOf(name)).className).toContain("min-w-11");
      expect(stateSlot(rowOf(name)).className).toContain("group-hover/menu-item:opacity-0");
    }
  });

  it("the import and the export are asked for through the registry's request, and the dialog opens for that workspace", async () => {
    const api = fakeApi([API, WEB], [status(API), status(WEB)]);
    api.planProject = vi.fn(async () => ({ source: "/private/var/proj", repo: true, files: 3, bytes: 900, secrets: [], excluded: [], skipped: [], agents: [] }));
    api.importProject = vi.fn();
    api.exportProject = vi.fn();
    await mount(api, "api");
    act(() => requestProjectTrip({ workspaceId: "ws_b", trip: "import" }));
    const importing = await screen.findByRole("dialog", { name: "Import a project" });
    expect(within(importing).getByText(importIntoLine("web"))).toBeDefined();
    fireEvent.click(within(importing).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    act(() => requestProjectTrip({ workspaceId: "ws_b", trip: "export" }));
    const exporting = await screen.findByRole("dialog", { name: "Export a project" });
    expect(within(exporting).getByText(exportFromLine("web"))).toBeDefined();
    fireEvent.click(within(exporting).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("a zombie row offers the rebuild and no new thread", async () => {
    await mount(fakeApi([API], [status(API, { reach: { state: "zombie" } })]), "api");
    await waitFor(() => expect(screen.getByRole("button", { name: "Rebuild api" })).toBeDefined());
    expect(screen.queryByRole("button", { name: "New thread in api" })).toBeNull();
  });
});

describe("a folder dragged from the desktop", () => {
  const MAC: WorkspaceView = { ...view("ws_m", "zingzy-mac"), kind: "local", machineId: "local", golden: "" };
  const PLAN = { source: "/Users/dev/spoo", repo: true, files: 3, bytes: 900, secrets: [], excluded: [], skipped: [], agents: [] };
  /** A drag event as the window sees one: jsdom builds no DragEvent, so the transfer rides the event as a property. */
  const drag = (type: string, dataTransfer: Record<string, unknown>): Event => Object.assign(new Event(type, { bubbles: true, cancelable: true }), { dataTransfer });
  const carrying = { types: ["Files"], items: [{ kind: "file", type: "" }] };
  const folder = (name: string) => ({ types: ["Files"], files: [new File([], name)], items: [{ kind: "file", type: "", webkitGetAsEntry: () => ({ isDirectory: true }) }] });
  const tiles = (): string[] => Array.from(document.querySelectorAll<HTMLElement>("[data-drop-tile]")).map(t => t.textContent ?? "");
  const tileOf = (id: string): HTMLElement => document.querySelector<HTMLElement>(`[data-drop-tile][data-row-id="ws:${id}"]`)!;

  async function mountWithBridge() {
    window.wsp = { droppedPath: file => `/Users/dev/${file.name}` };
    const api = fakeApi([API, WEB, MAC], [status(API), status(WEB), { ...status(MAC), kind: "local", rateUsdPerHour: 0 }]);
    api.planProject = vi.fn(async () => PLAN);
    api.importProject = vi.fn(async (o: { dest: string }) => ({ dest: o.dest, files: 3, bytes: 900, parts: 0, cut: [], rewritten: [], agents: [] }));
    await mount(api, "api");
    return api;
  }
  afterEach(() => {
    delete window.wsp;
  });

  it("turns every workspace row into a dotted drop tile in the row's muted mono with the kind's words, and gives the rows back when the drag leaves the window or drops", async () => {
    await mountWithBridge();
    expect(tiles()).toEqual([]);
    act(() => void window.dispatchEvent(drag("dragenter", carrying)));
    expect(tiles().sort()).toEqual(["import to api", "import to web", "register on this computer"]);
    const tile = tileOf("ws_a");
    expect(tile.className).toContain("border-dashed");
    expect(tile.className).toContain("font-mono");
    expect(tile.className).toContain("h-15");
    expect(tile.dataset["sidebarRow"]).toBeDefined();
    expect(screen.queryByText("api")).toBeNull();
    // A drag walks into child elements and out again: only leaving the last one it entered ends it.
    act(() => void window.dispatchEvent(drag("dragenter", carrying)));
    act(() => void window.dispatchEvent(drag("dragleave", carrying)));
    expect(tiles()).toHaveLength(3);
    act(() => void window.dispatchEvent(drag("dragleave", carrying)));
    expect(tiles()).toEqual([]);
    expect(screen.getByText("api")).toBeDefined();
    act(() => void window.dispatchEvent(drag("dragenter", carrying)));
    expect(tiles()).toHaveLength(3);
    act(() => void window.dispatchEvent(drag("drop", carrying)));
    expect(tiles()).toEqual([]);
  });

  it("a drag that carries no files, text say, moves nothing", async () => {
    await mountWithBridge();
    act(() => void window.dispatchEvent(drag("dragenter", { types: ["text/plain"], items: [{ kind: "string", type: "text/plain" }] })));
    expect(tiles()).toEqual([]);
  });

  it("dropped on a box's tile the folder opens the import dialog already reading it; on this computer's it is registered at once with no plan, and the toast says so; a file is refused in the toast", async () => {
    const api = await mountWithBridge();
    act(() => void window.dispatchEvent(drag("dragenter", carrying)));
    fireEvent(tileOf("ws_b"), drag("drop", folder("spoo")));
    const importing = await screen.findByRole("dialog", { name: "Import a project" });
    expect(within(importing).getByText(importIntoLine("web"))).toBeDefined();
    await waitFor(() => expect(api.planProject).toHaveBeenCalledWith("/Users/dev/spoo"));
    expect(api.importProject).not.toHaveBeenCalled();
    expect(tiles()).toEqual([]);
    fireEvent.click(within(importing).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    act(() => void window.dispatchEvent(drag("dragenter", carrying)));
    fireEvent(tileOf("ws_m"), drag("drop", folder("spoo")));
    await waitFor(() => expect(api.importProject).toHaveBeenCalledWith({ workspaceId: "ws_m", ...registerRequest("/Users/dev/spoo") }));
    expect(api.planProject).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(useStore.getState().toast).toBe(registeredLine("/Users/dev/spoo")));
    expect(screen.queryByRole("dialog")).toBeNull();

    act(() => void window.dispatchEvent(drag("dragenter", carrying)));
    fireEvent(tileOf("ws_a"), drag("drop", { types: ["Files"], files: [new File(["x"], "notes.txt")], items: [{ kind: "file", type: "text/plain", webkitGetAsEntry: () => ({ isDirectory: false }) }] }));
    await waitFor(() => expect(useStore.getState().toast).toBe(DROP_A_FOLDER_LINE));
    expect(api.importProject).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("a browser tab cannot read a dropped folder's path, so its rows stay rows", async () => {
    const api = fakeApi([API, WEB], [status(API), status(WEB)]);
    api.planProject = vi.fn(async () => PLAN);
    api.importProject = vi.fn();
    await mount(api, "api");
    act(() => void window.dispatchEvent(drag("dragenter", carrying)));
    expect(tiles()).toEqual([]);
    expect(screen.getByText("api")).toBeDefined();
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

describe("the Workspaces section row", () => {
  it("collapses every workspace behind its chevron and shows how many it hides", async () => {
    await mount(fakeApi([API, WEB], [status(API), status(WEB)], [session("s1", "ws_a", { prompt: "hello" })]), "api");
    const row = screen.getByRole("button", { name: "Workspaces" });
    expect(row.getAttribute("aria-expanded")).toBe("true");
    expect(row.querySelector("svg.lucide-chevron-down")).not.toBeNull();
    expect(row.className).toContain("h-8");
    expect(row.className).toContain("hover:bg-sidebar-row-hover");
    expect(rowIds()).toEqual(["ws:ws_a", "thread:s1", "ws:ws_b"]);
    fireEvent.click(row);
    expect(rowIds()).toEqual([]);
    expect(row.getAttribute("aria-expanded")).toBe("false");
    expect(row.textContent).toBe("Workspaces2");
    expect(screen.queryByText(/No workspaces yet/)).toBeNull();
    fireEvent.click(row);
    expect(rowIds()).toEqual(["ws:ws_a", "thread:s1", "ws:ws_b"]);
    expect(row.textContent).toBe("Workspaces");
  });

  it("the label is a caps mono zone label, not row type", async () => {
    await mount(fakeApi([API], [status(API)]), "api");
    const label = screen.getByText("Workspaces");
    expect(label.className).toContain("font-mono");
    expect(label.className).toContain("uppercase");
    expect(label.className).toMatch(/tracking-/);
    expect(label.className).not.toContain("text-sm");
  });

  it("the new-workspace glyph sits at the row's right edge and opens the dialog; the footer holds the Settings row and no New workspace one", async () => {
    await mount(fakeApi([API], [status(API)]), "api");
    const buttons = screen.getAllByRole("button", { name: "New workspace" });
    expect(buttons).toHaveLength(1);
    const glyph = buttons[0]!;
    expect(glyph.closest("[data-slot=sidebar-footer]")).toBeNull();
    expect(glyph.closest("[data-slot=sidebar-group]")).not.toBeNull();
    expect(glyph.querySelector("svg.lucide-plus")).not.toBeNull();
    expect(glyph.textContent).toBe("");
    // Quiet at rest like the rows' own glyphs; the hover brings it up.
    expect(glyph.className).toContain("text-sidebar-muted-foreground");
    // The footer is the Settings row's home and nothing else's here: the door a person finds without the chord.
    expect(document.querySelector("[data-slot=sidebar-footer]")!.textContent).toBe(`${SETTINGS_WORDS.title}⌘,`);
    expect(document.querySelector("[data-slot=sidebar-footer] [data-k=settings-row]")).not.toBeNull();
    fireEvent.click(glyph);
    expect(await screen.findByRole("dialog", { name: "New workspace" })).toBeDefined();
  });
});

describe("the group before the first list has arrived", () => {
  it("says nothing at all while the store is not ready: no empty state, no rows, no bars", () => {
    render(<SidebarProvider defaultOpen><WorkspaceSidebar /></SidebarProvider>);
    expect(screen.queryByText(/No workspaces yet/)).toBeNull();
    expect(rowIds()).toEqual([]);
    expect(document.querySelectorAll("[data-slot=skeleton]").length).toBe(0);
    expect(document.querySelector("[data-slot=sidebar-group-content]")!.textContent).toBe("");
  });

  it("says the fleet is empty once the list has arrived and holds nothing", async () => {
    render(<SidebarProvider defaultOpen><WorkspaceSidebar /></SidebarProvider>);
    expect(screen.queryByText(/No workspaces yet/)).toBeNull();
    act(() => useStore.setState({ ready: true }));
    expect(await screen.findByText(/No workspaces yet/)).toBeDefined();
    expect(screen.getByText("Add a computer or connect a provider, then create one.")).toBeDefined();
  });

  it("a creation on its way holds the empty state off while the list is still coming", () => {
    render(<SidebarProvider defaultOpen><WorkspaceSidebar /></SidebarProvider>);
    act(() => useStore.setState({ creations: [{ key: "creating:1", name: "beta", workspaceId: null, lines: [], failed: null }] }));
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

describe("new workspace dialog", () => {
  const openDialog = async () => {
    fireEvent.click(screen.getByRole("button", { name: "New workspace" }));
    const dialog = await screen.findByRole("dialog");
    return { dialog, input: within(dialog).getByLabelText("Name") as HTMLInputElement };
  };

  it("a create that made room shows the notice as a toast, the way a failure shows its line", async () => {
    const api = fakeApi([API], [status(API)]);
    api.createFromGoldenHead = vi.fn(async (name: string) => ({ ...view("ws_new", name), notice: "Stopped the builder kept from golden v1 to make room at the machine cap." }));
    await mount(api, "api");
    const { input } = await openDialog();
    fireEvent.keyDown(input, { key: "Enter" });
    await screen.findByRole("status", { name: /Stopped the builder kept from golden v1/ });
    expect(useStore.getState().toast).toBe("Stopped the builder kept from golden v1 to make room at the machine cap.");
  });

  it("offers the provider's sizes with the golden's checked, and a picked size reaches the create; left alone, none does", async () => {
    vi.stubGlobal("PointerEvent", class extends MouseEvent {});
    const api = fakeApi([API], [status(API)]);
    api.capabilities = vi.fn(async () => (caps({ resize: false, sizes: [{ cpu: 2, memMb: 4096, rateUsdPerHour: 0.11 }, { cpu: 2, memMb: 8192, rateUsdPerHour: 0.15 }] })));
    api.getGolden = async () => ({ head: 1, versions: [{ version: 1, snapshotId: "snap_g", baseTemplate: "t", setupSha: "s", createdAt: "c", smoke: { cmd: "true", exitCode: 0 }, size: { cpu: 2, memMb: 4096 } }] });
    api.createFromGoldenHead = vi.fn(async (name: string) => view("ws_new", name));
    await mount(api, "api");
    const { dialog, input } = await openDialog();
    const group = within(dialog).getByRole("radiogroup", { name: "Size" });
    await waitFor(() => expect(within(group).getAllByRole("radio").map(r => r.getAttribute("aria-checked"))).toEqual(["true", "false"]));
    fireEvent.change(input, { target: { value: "beta" } });
    fireEvent.click(within(group).getByRole("radio", { name: /8\u00a0GB/ }));
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(api.createFromGoldenHead).toHaveBeenCalledWith("beta", { cpu: 2, memMb: 8192 }));

    const again = await openDialog();
    fireEvent.change(again.input, { target: { value: "gamma" } });
    fireEvent.keyDown(again.input, { key: "Enter" });
    await waitFor(() => expect(api.createFromGoldenHead).toHaveBeenCalledWith("gamma", undefined));
    vi.unstubAllGlobals();
  });

  it("offers a default name, creates on Enter, selects the creating row, shows its current stage whole, and swaps to the workspace on workspace.created", async () => {
    let finish!: (w: WorkspaceView) => void;
    const api = fakeApi([API], [status(API)]);
    api.createFromGoldenHead = vi.fn(() => new Promise<WorkspaceView>(resolve => { finish = resolve; }));
    await mount(api, "api");
    const { input } = await openDialog();
    expect(input.value).toBe("workspace-1");
    fireEvent.change(input, { target: { value: "beta" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(api.createFromGoldenHead).toHaveBeenCalledWith("beta", undefined);
    const pending = await screen.findByText("beta");
    const row = pending.closest<HTMLElement>("[data-sidebar-row]")!;
    expect(row.getAttribute("aria-busy")).toBe("true");
    expect(row.getAttribute("data-active")).toBe("true");
    expect(useStore.getState().selectedId).toMatch(/^creating:/);
    const stage = { type: "workspace.creating" as const, workspaceId: "ws_beta", name: "beta", elapsedMs: 0 };
    act(() => useStore.getState().applyEvent({ ...stage, stage: "fork-requested", message: "Fork of the golden image requested." }));
    act(() => useStore.getState().applyEvent({ ...stage, stage: "machine-booting", message: "Machine m7 is booting.", elapsedMs: 4_200 }));
    const line = within(rowOf("beta")).getByText("Machine m7 is booting.");
    expect(line.className).toContain("whitespace-normal");
    expect(line.className).not.toContain("truncate");
    expect(within(rowOf("beta")).queryByText("Fork of the golden image requested.")).toBeNull();
    const created = view("ws_beta", "beta");
    act(() => useStore.getState().applyEvent({ type: "workspace.created", workspace: created }));
    await waitFor(() => expect(rowOf("beta").getAttribute("aria-busy")).toBeNull());
    expect(rowOf("beta").getAttribute("data-active")).toBe("true");
    expect(useStore.getState().selectedId).toBe("ws_beta");
    expect(useStore.getState().creations).toEqual([]);
    await act(async () => { finish(created); });
    expect(screen.getAllByText("beta").length).toBe(1);
    expect(useStore.getState().workspaces.filter(w => w.id === "ws_beta")).toHaveLength(1);
  });

  it("while the image is still building the Create keycap is held, so Enter forks nothing and no row is written", async () => {
    const api = fakeApi([API], [status(API)]);
    api.getGolden = async () => undefined;
    api.createFromGoldenHead = vi.fn(async (name: string) => view("ws_new", name));
    await mount(api, "api");
    await waitFor(() => expect(useStore.getState().hasGolden).toBe(false));
    act(() =>
      useStore.getState().applyEvent({
        type: "init.job",
        job: { id: "init_1", road: "manual", phase: "building", keys: { solari: true }, step: 0, stoppable: true, screens: [], rows: [{ id: "stage/creating", kind: "stage", label: "Creating the machine", state: "done" }, { id: "stage/ready", kind: "stage", label: "Waiting for the machine", state: "running" }], progress: { done: 1, total: 2 }, log: [] },
      }),
    );
    const { dialog, input } = await openDialog();
    const create = within(dialog).getByRole("button", { name: "Create" });
    await waitFor(() => expect(create.hasAttribute("disabled")).toBe(true));
    fireEvent.change(input, { target: { value: "beta" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(create);
    expect(api.createFromGoldenHead).not.toHaveBeenCalled();
    expect(useStore.getState().creations).toEqual([]);
    expect(useStore.getState().toast).toBeNull();
    expect(screen.queryByText(/wspx|golden build/)).toBeNull();
    // The seal frees the keycap under the open dialog: the person presses Create where they already are.
    act(() => useStore.getState().applyEvent({ type: "init.job", job: { id: "init_1", road: "manual", phase: "done", keys: { solari: true }, step: 0, stoppable: false, screens: [], rows: [], progress: { done: 2, total: 2 }, log: [] } }));
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Create" }).hasAttribute("disabled")).toBe(false));
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(api.createFromGoldenHead).toHaveBeenCalledWith("beta", undefined));
  });

  it("a refusal keeps the row, names the refusal on it, and reopens no dialog", async () => {
    const api = fakeApi([API], [status(API)]);
    api.createFromGoldenHead = vi.fn(async () => { throw new RequestError("Sandbox limit reached", "concurrency"); });
    await mount(api, "api");
    const { input } = await openDialog();
    fireEvent.change(input, { target: { value: "gamma" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(rowOf("gamma").textContent).toMatch(/no more workspaces/i));
    expect(rowOf("gamma").getAttribute("aria-busy")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(useStore.getState().toast).toBeNull();
    // The next default name skips the row that is still there.
    fireEvent.click(screen.getByRole("button", { name: "New workspace" }));
    const again = within(await screen.findByRole("dialog")).getByLabelText("Name") as HTMLInputElement;
    expect(again.value).toBe("workspace-1");
    fireEvent.change(again, { target: { value: "gamma" } });
    fireEvent.keyDown(again, { key: "Enter" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(useStore.getState().creations.map(c => c.name)).toEqual(["gamma", "gamma"]);
  });

  it("the second choice creates, then opens the import dialog for the workspace the runtime made", async () => {
    vi.stubGlobal("PointerEvent", class extends MouseEvent {});
    const api = fakeApi([API], [status(API)]);
    api.planProject = vi.fn(async () => ({ source: "/private/var/proj", repo: true, files: 3, bytes: 900, secrets: [], excluded: [], skipped: [], agents: [] }));
    api.importProject = vi.fn();
    api.createFromGoldenHead = vi.fn(async (name: string) => view("ws_beta", name));
    await mount(api, "api");
    const { dialog, input } = await openDialog();
    fireEvent.change(input, { target: { value: "beta" } });
    fireEvent.click(within(dialog).getByRole("radio", { name: /^Import a project/ }));
    fireEvent.keyDown(input, { key: "Enter" });
    const importDialog = await screen.findByRole("dialog", { name: "Import a project" });
    expect(within(importDialog).getByText(importIntoLine("beta"))).toBeDefined();
    expect(useStore.getState().selectedId).toBe("ws_beta");
    vi.unstubAllGlobals();
  });

  it("Escape cancels without creating; a blank name cannot be submitted", async () => {
    const api = await mount(fakeApi([API], [status(API)]), "api");
    const { input } = await openDialog();
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(api.createFromGoldenHead).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeDefined();
    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(api.createFromGoldenHead).not.toHaveBeenCalled();
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

  it("a record still saying running whose status found the machine gone reads Gone with no rate and no countdown, even while the status carries both", async () => {
    const gone = status(API, { machineState: "gone", reach: { state: "gone" }, idleAt: NOW + 17 * 60_000, rateUsdPerHour: 0.11, reason: "machine m_ws_a is gone at the provider: the status poll found it gone at 2026-09-06T10:21:04Z" });
    await mount(fakeApi([API], [gone]), "api");
    act(() => useStore.getState().applyEvent({ type: "workspace.cost", workspaceId: "ws_a", phase: "running", rateUsdPerHour: 0.11, awakeMs: 60_000, accruedUsd: 0.18, at: new Date(NOW).toISOString() }));
    const row = rowOf("api");
    await waitFor(() => expect(row.textContent).toContain("Gone"));
    expect(row.textContent).not.toContain("/hr");
    expect(row.textContent).not.toContain("naps");
    expect(row.textContent).not.toContain("active");
    expect(row.textContent).toContain("$0.18 today");
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
    await waitFor(() => expect(stateSlot(rowOf("web")).textContent).toBe("Paused"));
    expect(stateSlot(rowOf("api")).textContent).toBe("");
    expect(screen.queryByText(PROVIDER_UNREACHED_LINE)).toBeNull();

    act(() => useStore.getState().applyEvent({ type: "workspace.status", status: status(API, { reach: { state: "reachable", offline: true } }) }));
    const line = await screen.findByText(PROVIDER_UNREACHED_LINE);
    expect(line.closest("[data-sidebar-search]")).not.toBeNull();
    expect(line.className).toContain("font-mono");
    expect(line.className).not.toMatch(/border|bg-|badge|chip|destructive|warning|success/);
    expect(stateSlot(rowOf("api")).textContent).toBe("");
    expect(rowOf("api").textContent).not.toContain("Unreachable");
    expect(stateSlot(rowOf("web")).textContent).toBe("Paused");
    // The line reads once, however many rows carry the flag.
    act(() => useStore.getState().applyEvent({ type: "workspace.status", status: status(WEB, { reach: { state: "napping", offline: true } }) }));
    expect(screen.getAllByText(PROVIDER_UNREACHED_LINE)).toHaveLength(1);

    act(() => useStore.getState().applyEvent({ type: "workspace.status", status: status(API) }));
    act(() => useStore.getState().applyEvent({ type: "workspace.status", status: status(WEB) }));
    await waitFor(() => expect(screen.queryByText(PROVIDER_UNREACHED_LINE)).toBeNull());
  });

  it("a row that was Unreachable stays Unreachable through the computer's offline spell", async () => {
    await mount(fakeApi([API], [status(API, { reach: { state: "unreachable" } })]), "api");
    await waitFor(() => expect(stateSlot(rowOf("api")).textContent).toBe("Unreachable"));
    act(() => useStore.getState().applyEvent({ type: "workspace.status", status: status(API, { reach: { state: "unreachable", offline: true } }) }));
    await screen.findByText(PROVIDER_UNREACHED_LINE);
    expect(stateSlot(rowOf("api")).textContent).toBe("Unreachable");
  });
});

/** What the shell reads to wash its own surface, mounted beside the body so one render answers for both. */
/** The first dot's angle of the theme the shell would paint, or none. */
function ThemeProbe() {
  return <span data-theme-probe>{useSpaceTheme()?.dots[0]?.angle ?? "none"}</span>;
}
const themed = (angle: number): WorkspaceTheme => ({ ...DEFAULT_THEME, dots: harmonyDots({ angle, radius: 0.5 }, "complementary"), harmony: "complementary" });

describe("a workspace's own theme and glyph", () => {
  const THEMED: WorkspaceView = { ...view("ws_a", "api"), theme: themed(200), glyph: "flask" };
  const PLAIN = view("ws_b", "web", "napping");
  const MAC: WorkspaceView = { ...view("ws_m", "zingzy-mac"), kind: "local", machineId: "local", golden: "" };
  const all = () => [{ ...THEMED }, { ...PLAIN }, { ...MAC }];
  const threads = () => [session("s1", "ws_a", { prompt: "fix the port list", startedAt: iso(-3 * 60_000) }), session("s2", "ws_b", { prompt: "bump the lockfile", startedAt: iso(-4 * 60_000) })];
  const leadOf = (el: HTMLElement): HTMLElement => el.querySelector<HTMLElement>("span[aria-hidden]")!;

  async function mountSpaces(api: FakeApi): Promise<FakeApi> {
    useStore.setState({ preferences: { ...DEFAULT_PREFERENCES, labs: true, sidebarMode: "spaces" } });
    useStore.getState().bind(api);
    render(
      <SidebarProvider defaultOpen>
        <ThemeProbe />
        <WorkspaceSidebar />
      </SidebarProvider>,
    );
    await waitFor(() => expect(spaceHeader()).not.toBeNull());
    return api;
  }

  it("the space bar is one icon per workspace and a plus: the kind's glyph by default, the picked icon where one is, the current one in the theme's ink, the others muted, a paused one dimmed, no state colour on any glyph, and no name on any of them", async () => {
    await mountSpaces(fakeApi(all(), [status(THEMED), status(PLAIN), { ...status(MAC), kind: "local", size: { cpu: 10, memMb: 16384 }, rateUsdPerHour: 0 }], threads()));
    await waitFor(() => expect(icons()).toHaveLength(3));
    // The sidebar's own order: the running ones first, so this computer sits before the paused fork.
    const [api, mac, web] = icons() as [HTMLElement, HTMLElement, HTMLElement];
    expect(icons().map(i => i.getAttribute("aria-label"))).toEqual(["api", "zingzy-mac", "web"]);
    expect(icons().map(i => i.textContent)).toEqual(["", "", ""]);
    expect(api.querySelector("[data-space-glyph='flask']")).not.toBeNull();
    expect(web.querySelector("[data-space-kind-glyph]")!.getAttribute("class")).toContain("lucide-cloud");
    expect(mac.querySelector("[data-space-kind-glyph]")!.getAttribute("class")).toContain("lucide-laptop");
    expect(api.getAttribute("aria-current")).toBe("true");
    expect(api.className).toContain("--space-tint");
    expect(web.className).not.toContain("--space-tint");
    expect(web.className).toContain("text-sidebar-muted-foreground");
    // The paused fork dims by the one rule its row's lead dims by, and that is all the state does here: the bar's
    // colour is the space's own, so no glyph in it wears the row's running green.
    expect(leadDimClass({ state: "paused" })).toBe("opacity-50");
    expect(leadDimClass({ state: "running" })).toBeUndefined();
    expect(web.className.split(" ")).toContain(leadDimClass({ state: "paused" }));
    expect(mac.className.split(" ")).not.toContain("opacity-50");
    const glyphClasses = (icon: HTMLElement) => icon.querySelector("svg")!.getAttribute("class")!.split(" ");
    for (const icon of [api, mac, web]) expect(glyphClasses(icon)).not.toContain(glyphStateClass({ state: "running" }));
    // One row of one height, centred, and the plus at its right end makes a new workspace. The icons sit in a
    // group of their own that scrolls sideways once they outgrow the footer, and the plus stays outside it, so
    // neither the first icon nor the plus is ever cut.
    const bar = document.querySelector<HTMLElement>("[data-space-bar]")!;
    expect(bar.className).toContain("justify-center");
    expect(bar.className).toContain("h-7");
    for (const icon of icons()) expect(icon.className).toContain("size-7");
    const group = bar.querySelector<HTMLElement>("[data-space-icons]")!;
    expect(group.className).toContain("overflow-x-auto");
    expect(Array.from(group.querySelectorAll("[data-space-icon]"))).toEqual(icons());
    expect(bar.lastElementChild!.hasAttribute("data-space-new")).toBe(true);
    expect(group.contains(bar.lastElementChild)).toBe(false);
    expect(screen.queryByRole("button", { name: "Workspaces" })).toBeNull();
    fireEvent.click(bar.querySelector("[data-space-new]")!);
    expect(await screen.findByRole("dialog")).toBeDefined();
  });

  it("the header's lead is the glyph in the theme's ink, and the state dot moves to the state slot so running is still said", async () => {
    await mountSpaces(fakeApi(all(), [status(THEMED), status(PLAIN)], threads()));
    const header = spaceHeader()!;
    expect(leadOf(header).querySelector("[data-space-glyph='flask']")!.getAttribute("class")).toContain("--space-tint");
    const state = header.querySelector<HTMLElement>("[data-space-state]")!;
    expect(state.querySelector(".bg-success-foreground")).not.toBeNull();
    expect(state.textContent).toBe("");
  });

  it("a workspace with no glyph keeps the state dot in the lead and nothing in the state slot but its word", async () => {
    useStore.setState({ selectedId: "ws_b" });
    await mountSpaces(fakeApi(all(), [status(THEMED), status(PLAIN)], threads()));
    await waitFor(() => expect(within(spaceHeader()!).getByText("web")).toBeDefined());
    const header = spaceHeader()!;
    expect(leadOf(header).querySelector("[data-space-glyph]")).toBeNull();
    expect(leadOf(header).querySelector("span")).not.toBeNull();
    expect(header.querySelector("[data-space-state]")!.querySelector("span[aria-hidden]")).toBeNull();
  });

  // The store keeps its workspaces sorted by id; the sidebar draws the running ones first, so a napping workspace
  // whose id sorts first parts the two orders. A creation in flight holds its own key as the selection, which is in
  // neither order, and both fall back to a first row: the shell's theme has to be the header's workspace even then.
  it("the theme the shell paints and the header the body draws are the same workspace when the two orders differ", async () => {
    const napping: WorkspaceView = { ...view("ws_aaa", "old", "napping"), theme: themed(100) };
    const running: WorkspaceView = { ...view("ws_zzz", "api"), theme: themed(300) };
    const api = fakeApi([napping, running], [status(napping), status(running)]);
    api.createFromGoldenHead.mockImplementation(() => new Promise(() => {}));
    await mountSpaces(api);
    await act(async () => void useStore.getState().createWorkspace("fresh"));
    await waitFor(() => expect(useStore.getState().selectedId).toBe(useStore.getState().creations[0]!.key));
    expect(useStore.getState().workspaces.map(w => w.id)).toEqual(["ws_aaa", "ws_zzz"]);
    expect(within(spaceHeader()!).getByText("api")).toBeDefined();
    expect(document.querySelector("[data-theme-probe]")!.textContent).toBe("300");
  });

  it("in the list body no workspace's colour reaches the chrome: the shell paints no theme and the rows carry no glyph", async () => {
    useStore.getState().bind(fakeApi(all(), [status(THEMED), status(PLAIN)], threads()));
    render(
      <SidebarProvider defaultOpen>
        <ThemeProbe />
        <WorkspaceSidebar />
      </SidebarProvider>,
    );
    await waitFor(() => expect(workspaceRowIds()).toEqual(["ws:ws_a", "ws:ws_m", "ws:ws_b"]));
    expect(document.querySelector("[data-theme-probe]")!.textContent).toBe("none");
    // The paused row's lead glyph dims by the same rule the bar's icon does, and the running one is green, which the bar's never is.
    expect(rowOf("web").querySelector("[data-workspace-lead] svg")!.getAttribute("class")!.split(" ")).toContain(leadDimClass({ state: "paused" }));
    expect(rowOf("api").querySelector("[data-workspace-lead] svg")!.getAttribute("class")!.split(" ")).toContain(glyphStateClass({ state: "running" }));
    expect(document.querySelector("[data-space-glyph], [data-space-icon], [data-space-bar]")).toBeNull();
  });
});

describe("Spaces mode", () => {
  const THREE = [API, WEB, view("ws_c", "old", "gone")];
  const statuses = () => [status(API, { idleAt: iso(15.5 * 60_000) }), status(WEB), status(THREE[2]!, { machineState: "gone" as const, reach: { state: "gone" as const } })];

  // The current workspace's name reads twice on screen, in the header and on its own dot, so the shared mount's
  // one-name wait cannot be used here; the header arriving is what says the body is up.
  async function mountSpaces(api: FakeApi): Promise<FakeApi> {
    useStore.setState({ preferences: { ...DEFAULT_PREFERENCES, labs: true, sidebarMode: "spaces" } });
    useStore.getState().bind(api);
    render(
      <SidebarProvider defaultOpen>
        <WorkspaceSidebar />
      </SidebarProvider>,
    );
    await waitFor(() => expect(spaceHeader()).not.toBeNull());
    return api;
  }

  it("the list is what the sidebar draws with nothing remembered: every workspace's row under the Workspaces header, and no space header or bar", async () => {
    await mount(fakeApi(THREE, statuses()), "api");
    await waitFor(() => expect(workspaceRowIds()).toEqual(["ws:ws_a", "ws:ws_b", "ws:ws_c"]));
    expect(spaceHeader()).toBeNull();
    expect(icons()).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Workspaces" })).toBeDefined();
  });

  it("a remembered Spaces pick draws one workspace's rows under its header with no Workspaces header over it, the others only as icons on the bar", async () => {
    await mountSpaces(
      fakeApi(THREE, statuses(), [
        session("s1", "ws_a", { prompt: "fix the port list", startedAt: iso(-3 * 60_000) }),
        session("s2", "ws_b", { prompt: "bump the lockfile", startedAt: iso(-30 * 60_000) }),
      ]),
    );
    // No workspace row at all: the header stands in for the one on screen, wearing its id, the dots for the rest.
    expect(workspaceRowIds()).toEqual(["ws:ws_a"]);
    expect(within(spaceHeader()!).getByText("api")).toBeDefined();
    // Only that workspace's threads, in the list's own grammar, under the header the walk starts on.
    expect(rowIds()).toEqual(["ws:ws_a", "thread:s1"]);
    expect(screen.queryByText("bump the lockfile")).toBeNull();
    expect(icons().map(d => d.getAttribute("aria-label"))).toEqual(["api", "web", "old"]);
    // The name is on the header alone; no icon carries one.
    expect(icons().map(d => d.textContent)).toEqual(["", "", ""]);
    expect(icons()[0]!.getAttribute("aria-current")).toBe("true");
    expect(icons()[1]!.getAttribute("aria-current")).toBeNull();
    // One workspace is on screen, so the collapse header and its chevron are gone; the plus is on the bar.
    expect(screen.queryByRole("button", { name: "Workspaces" })).toBeNull();
    expect(document.querySelector("[data-space-bar] [data-space-new]")).not.toBeNull();
  });

  it("the header's lines are the machine, what it cost today with its rate, and the nap countdown only when one is set", async () => {
    await mountSpaces(fakeApi(THREE, statuses()));
    await waitFor(() => expect(headerLines()).toEqual(["2 vCPU · 4 GB", "$0.00 today · $0.110/hr", "naps in 15m"]));
    act(() =>
      useStore.getState().applyEvent({ type: "workspace.cost", workspaceId: "ws_a", phase: "running", rateUsdPerHour: 0.11, awakeMs: 120_000, accruedUsd: 0.29, at: new Date(NOW).toISOString() }),
    );
    await waitFor(() => expect(headerLines()[1]).toBe("$0.29 today · $0.110/hr"));
    // Every line is muted mono, cut from the right and whole in its title; the state word takes the name's line, as a row's does.
    for (const line of document.querySelectorAll<HTMLElement>("[data-space-header] [data-space-meta]")) {
      expect(line.className).toContain("font-mono");
      expect(line.className).toContain("truncate");
      expect(line.className).not.toMatch(/border|bg-|badge|chip|rounded/);
      expect(line.getAttribute("title")).toBe(line.textContent);
    }
    expect(spaceHeader()!.querySelector("[data-space-state]")!.textContent).toBe("");
    // With no nap scheduled the line is gone rather than reading "active"; a paused machine bills nothing, so no rate.
    act(() => useStore.getState().applyEvent({ type: "workspace.status", status: status(API) }));
    await waitFor(() => expect(headerLines()).toEqual(["2 vCPU · 4 GB", "$0.29 today · $0.110/hr"]));
  });

  it("a paused workspace's header drops the rate, and its state word takes the name's line", async () => {
    useStore.setState({ selectedId: "ws_b" });
    await mountSpaces(fakeApi(THREE, statuses()));
    await waitFor(() => expect(within(spaceHeader()!).getByText("web")).toBeDefined());
    expect(headerLines()).toEqual(["2 vCPU · 4 GB", "$0.00 today"]);
    expect(spaceHeader()!.querySelector("[data-space-state]")!.textContent).toBe("Paused");
  });

  it("a click on another workspace's icon moves the body to it", async () => {
    await mountSpaces(fakeApi(THREE, statuses(), [session("s2", "ws_b", { prompt: "bump the lockfile", startedAt: iso(-30 * 60_000) })]));
    fireEvent.click(icons()[1]!);
    await waitFor(() => expect(within(spaceHeader()!).getByText("web")).toBeDefined());
    expect(useStore.getState().selectedId).toBe("ws_b");
    expect(screen.getByText("bump the lockfile")).toBeDefined();
    expect(icons().map(d => d.getAttribute("aria-current"))).toEqual([null, "true", null]);
  });

  it("this computer's header reads its cores and memory where a fork's size reads, through the one machine line, and free where a fork's spend reads", async () => {
    const MAC: WorkspaceView = { ...view("ws_m", "zingzy-mac"), kind: "local", machineId: "local", golden: "" };
    useStore.setState({ selectedId: "ws_m" });
    await mountSpaces(fakeApi([API, MAC], [status(API), { ...status(MAC), kind: "local", size: { cpu: 10, memMb: 16384 }, rateUsdPerHour: 0 }]));
    await waitFor(() => expect(within(spaceHeader()!).getByText("zingzy-mac")).toBeDefined());
    // The machine words and the word free: nothing wsp pays for, so no figure and no rate under them.
    expect(headerLines()).toEqual(["10 cores · 16 GB", FREE_WORD]);
    expect(spaceHeader()!.querySelector("[data-space-state]")!.textContent).toBe("");
    // A tick on this computer's meter changes nothing there either.
    act(() =>
      useStore.getState().applyEvent({ type: "workspace.cost", workspaceId: "ws_m", phase: "running", rateUsdPerHour: 0, awakeMs: 120_000, accruedUsd: 0, at: new Date(NOW).toISOString() }),
    );
    await waitFor(() => expect(headerLines()).toEqual(["10 cores · 16 GB", FREE_WORD]));
    // The fork beside it keeps every line it had: the size, then the spend with its rate. Both bodies carry a
    // header while one travels out, so the lines are read once the body asked for is there alone.
    fireEvent.click(icons()[0]!);
    await waitFor(() => expect(within(spaceHeader()!).getByText("api")).toBeDefined());
    await waitFor(() => expect(headerLines()).toEqual(["2 vCPU · 4 GB", "$0.00 today · $0.110/hr"]));
  });

  it("a space asked for while the body is still travelling turns it around and never draws one workspace twice", async () => {
    const errors: string[] = [];
    const console_ = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      const line = args.map(String).join(" ");
      if (line.includes(DUPLICATE_KEY)) errors.push(line);
    });
    try {
      await mountSpaces(fakeApi(THREE, statuses()));
      fireEvent.click(icons()[1]!);
      expect(paneNames()).toEqual(["api", "web"]);
      // Straight back while that travel is still running: React says "two children with the same key" if the
      // workspace now on screen is still the one the travel calls the leaver.
      fireEvent.click(icons()[0]!);
      expect(errors).toEqual([]);
      expect(paneNames()).toEqual(["api", "web"]);
      expect(document.querySelector<HTMLElement>("[data-space-leaving] [data-space-name]")!.textContent).toBe("web");
      await waitFor(() => expect(panes()).toHaveLength(1));
      expect(spaceName()).toBe("api");
      expect(errors).toEqual([]);
    } finally {
      console_.mockRestore();
    }
  });

  it("a two-finger swipe across the body moves a space, out one way and back the other", async () => {
    await mountSpaces(fakeApi(THREE, statuses(), [session("s2", "ws_b", { prompt: "bump the lockfile", startedAt: iso(-30 * 60_000) })]));
    const body = (): HTMLElement => document.querySelector<HTMLElement>("[data-space-slide]")!;
    fireEvent.wheel(body(), { deltaX: 80, deltaY: 0 });
    expect(useStore.getState().selectedId).toBe("ws_b");
    // The workspace that left is still drawn while the body travels, out of the keyboard's reach and off the
    // accessibility tree, and it is gone once the travel is over.
    const leaving = document.querySelector<HTMLElement>("[data-space-leaving]")!;
    expect(panes()).toHaveLength(2);
    expect(within(leaving).getByText("api")).toBeDefined();
    expect(leaving.getAttribute("aria-hidden")).toBe("true");
    expect(leaving.hasAttribute("inert")).toBe(true);
    expect(spaceName()).toBe("web");
    await waitFor(() => expect(panes()).toHaveLength(1));
    expect(screen.getByText("bump the lockfile")).toBeDefined();
    expect(icons().map(d => d.getAttribute("aria-current"))).toEqual([null, "true", null]);
    // The quiet after the fingers lift ends the gesture, so the next swipe is read as its own.
    await act(async () => new Promise(resolve => setTimeout(resolve, SWIPE_GAP_MS + 10)));
    fireEvent.wheel(body(), { deltaX: -80, deltaY: 0 });
    expect(useStore.getState().selectedId).toBe("ws_a");
    await waitFor(() => expect(panes()).toHaveLength(1));
    expect(spaceName()).toBe("api");
  });

  it("one swipe moves one space however long the fingers keep going, and a scroll down the sidebar moves nothing", async () => {
    await mountSpaces(fakeApi(THREE, statuses()));
    const body = (): HTMLElement => document.querySelector<HTMLElement>("[data-space-slide]")!;
    for (const deltaX of [80, 80, 80]) fireEvent.wheel(body(), { deltaX, deltaY: 0 });
    expect(useStore.getState().selectedId).toBe("ws_b");
    await waitFor(() => expect(panes()).toHaveLength(1));
    expect(spaceName()).toBe("web");
    // A gesture of its own, straight down the rows: nothing moves.
    await act(async () => new Promise(resolve => setTimeout(resolve, SWIPE_GAP_MS + 10)));
    for (const deltaY of [120, 120]) fireEvent.wheel(body(), { deltaX: 0, deltaY });
    expect(useStore.getState().selectedId).toBe("ws_b");
    expect(panes()).toHaveLength(1);
  });

  it("the whole sidebar carries the swipe: the empty room under the rows, the space bar and the search row all move a space, and the list body never does", async () => {
    await mountSpaces(fakeApi(THREE, statuses()));
    const rest = async (): Promise<void> => {
      await waitFor(() => expect(panes()).toHaveLength(1));
      await act(async () => new Promise(resolve => setTimeout(resolve, SWIPE_GAP_MS + 10)));
    };
    // The scroll area under the rows, where a hand lands when the space has few threads.
    fireEvent.wheel(document.querySelector<HTMLElement>("[data-slot=sidebar-content]")!, { deltaX: 80, deltaY: 0 });
    expect(useStore.getState().selectedId).toBe("ws_b");
    await rest();
    fireEvent.wheel(document.querySelector<HTMLElement>("[data-space-bar]")!, { deltaX: 80, deltaY: 0 });
    expect(useStore.getState().selectedId).toBe("ws_c");
    await rest();
    fireEvent.wheel(document.querySelector<HTMLElement>("[data-sidebar-search]")!, { deltaX: -80, deltaY: 0 });
    expect(useStore.getState().selectedId).toBe("ws_b");
    await rest();
    // The list body has no spaces to move between, so the same push over it is a scroll and nothing more.
    await act(async () => {
      await useStore.getState().setPreferences({ sidebarMode: "list" });
    });
    await waitFor(() => expect(workspaceRowIds()).toHaveLength(3));
    fireEvent.wheel(document.querySelector<HTMLElement>("[data-slot=sidebar-content]")!, { deltaX: 80, deltaY: 0 });
    expect(useStore.getState().selectedId).toBe("ws_b");
  });

  it("before the first status the header carries no machine line: nothing draws a size it does not have", async () => {
    await mountSpaces(fakeApi([API], []));
    await waitFor(() => expect(headerLines()).toEqual(["$0.00 today"]));
  });

  it("the two lines the row gives a whole line to lead the header's, and the rest stay under them", async () => {
    await mountSpaces(fakeApi(THREE, statuses()));
    await waitFor(() => expect(headerLines()[0]).toBe("2 vCPU · 4 GB"));
    act(() => useStore.getState().applyEvent({ type: "workspace.status", status: { ...status(API, { idleAt: iso(15.5 * 60_000) }), daemonNote: DAEMON_UPDATING } }));
    await waitFor(() => expect(headerLines()).toEqual([DAEMON_UPDATING, "2 vCPU · 4 GB", "$0.00 today · $0.110/hr", "naps in 15m"]));
    act(() => useStore.getState().applyEvent({ type: "workspace.status", status: status(API, { idleAt: iso(15.5 * 60_000) }) }));
    await waitFor(() => expect(headerLines()[0]).toBe("2 vCPU · 4 GB"));
  });

  it("a machine that stopped answering with memory near full says so at the top of its header", async () => {
    const GiB = 1024 ** 3;
    resetLive();
    await mountSpaces(fakeApi([API], [status(API, { reach: { state: "unreachable" } })]));
    act(() => {
      getLive("ws_a").feedStatus("live");
      getLive("ws_a").feedSample({ type: "sys.sample", cpu: 99, load1: 6.4, mem: { used: 3.59 * GiB, total: 3.94 * GiB }, disk: { used: 1, total: 10 }, at: 1 });
      getLive("ws_a").feedStatus("connecting");
    });
    await waitFor(() => expect(headerLines()[0]).toBe("out of memory, 3.6 of 3.9 GB"));
    expect(headerLines()).toContain("2 vCPU · 4 GB");
    act(() => getLive("ws_a").feedStatus("live"));
    await waitFor(() => expect(headerLines()[0]).toBe("2 vCPU · 4 GB"));
  });

  it("the header is a stop in the arrow walk, and the walk carries on into the space's threads", async () => {
    await mountSpaces(
      fakeApi(THREE, statuses(), [
        session("s1", "ws_a", { prompt: "fix the port list", startedAt: iso(-3 * 60_000) }),
        session("s4", "ws_a", { prompt: "read the log", startedAt: iso(-9 * 60_000) }),
      ]),
    );
    await waitFor(() => expect(rowIds()).toEqual(["ws:ws_a", "thread:s1", "thread:s4"]));
    spaceHeader()!.focus();
    expect(document.activeElement).toBe(spaceHeader());
    fireEvent.keyDown(spaceHeader()!, { key: "ArrowDown" });
    expect((document.activeElement as HTMLElement).dataset["rowId"]).toBe("thread:s1");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
    expect(document.activeElement).toBe(spaceHeader());
    fireEvent.keyDown(spaceHeader()!, { key: "End" });
    expect((document.activeElement as HTMLElement).dataset["rowId"]).toBe("thread:s4");
  });

  it("is the rows' own button, so what activates a row activates it, and it opens the workspace as its row does in the list", async () => {
    const asked: string[] = [];
    const off = onNewThreadRequest(request => asked.push(request.workspaceId));
    try {
      await mountSpaces(fakeApi(THREE, statuses(), [session("s1", "ws_a", { prompt: "fix the port list", startedAt: iso(-3 * 60_000) })]));
      // A real button is what makes Space and Enter both activate it, which jsdom cannot deliver for itself.
      expect(spaceHeader()!.tagName).toBe("BUTTON");
      expect(spaceHeader()!.getAttribute("type")).toBe("button");
      expect(spaceHeader()!.tabIndex).toBe(0);
      act(() => useStore.getState().select("ws_a", "s1"));
      await waitFor(() => expect(useStore.getState().selectedThreadId).toBe("s1"));
      expect(spaceHeader()!.getAttribute("data-active")).toBe("false");
      fireEvent.click(spaceHeader()!);
      // The list's own row does exactly this on a click, and the same key road reaches both.
      await waitFor(() => expect(useStore.getState().selectedThreadId).toBeNull());
      expect(useStore.getState().selectedId).toBe("ws_a");
      // Selecting leaves it plain: the one workspace on screen has nothing to say by being tinted, and the bar's
      // current icon is where the sidebar says which workspace this is. The list's rows keep their own tint.
      expect(spaceHeader()!.getAttribute("data-active")).toBe("false");
      // Opening a thread stays on its own roads: the menu, the palette and the new-thread chord.
      expect(asked).toEqual([]);
    } finally {
      off();
    }
  });

  it("hands the name box a plain box to sit in, since an input may not sit inside a button", async () => {
    const api = { ...fakeApi(THREE, statuses()), renameWorkspace: vi.fn(async (id: string, name: string) => ({ ...view(id, name) })) };
    await mountSpaces(api);
    act(() => requestRenameWorkspace("ws_a"));
    await screen.findByRole("textbox", { name: WORKSPACE_WORDS.rename });
    expect(spaceHeader()!.tagName).toBe("DIV");
  });

  it("the header grows the sidebar's one name box: the palette's ask and a double-click both open it in the name's slot", async () => {
    const api = { ...fakeApi(THREE, statuses()), renameWorkspace: vi.fn(async (id: string, name: string) => ({ ...view(id, name) })) };
    await mountSpaces(api);
    act(() => requestRenameWorkspace("ws_a"));
    const asked = (await screen.findByRole("textbox", { name: WORKSPACE_WORDS.rename })) as HTMLInputElement;
    expect(asked.value).toBe("api");
    expect(asked.closest("[data-space-header]")).not.toBeNull();
    fireEvent.keyDown(asked, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull());
    fireEvent.doubleClick(document.querySelector("[data-space-name]")!);
    const typed = (await screen.findByRole("textbox", { name: WORKSPACE_WORDS.rename })) as HTMLInputElement;
    fireEvent.change(typed, { target: { value: "renamed in spaces" } });
    fireEvent.keyDown(typed, { key: "Enter" });
    await waitFor(() => expect(api.renameWorkspace).toHaveBeenCalledWith("ws_a", "renamed in spaces"));
    await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull());
  });
});

describe("a thread another thread's agent opened", () => {
  it("names where it runs in the meta line's mono, drops the workspace it shares with the row above it, and stands without the word Working while it works", async () => {
    const lead = session("s1", "ws_a", { prompt: "ship the search rewrite", startedBy: "person", threadId: "th_lead" });
    await mount(
      fakeApi(
        [API],
        // The provider the record carries is what the row names, never the id the provider minted for the machine.
        [status(API, { machineId: "sb_9f2c1d8a", provider: "solari" })],
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
    expect(meta("write the migration").textContent).toBe("··solari");
    expect(meta("write the migration").className).toContain("font-mono");
    // The dot alone says it works, the rule a workspace row already follows; a row that failed keeps its word.
    expect(meta("write the migration").textContent).not.toContain("Working");
    expect(meta("review the diff").textContent).toBe("Ended··solari");
    // The opener word is dropped on a spawned row: the indent says an agent opened it. The row above keeps both.
    expect(meta("write the migration").textContent).not.toContain("agent");
    expect(meta("ship the search rewrite").textContent).toBe("Working··you");
    expect(rowOf("write the migration").className).toContain("pl-5");
    expect(rowOf("write the migration").querySelector("[data-thread-provenance]")!.getAttribute("aria-label")).toBe("Claude Code · solari");
  });
});

describe("a thread an agent opened on another workspace", () => {
  // The orchestrator's own workspace is this computer and the builder it opened runs on a fork at a provider; the
  // sidebar files each thread under the workspace its session belongs to, which is what used to part the two.
  const MAC = { ...view("ws_mac", "zingzy's Mac"), kind: "local" as const };
  const BENCH = view("ws_bench", "spoo-bench");

  const opened = async () =>
    mount(
      fakeApi(
        [MAC, BENCH],
        [status(MAC), status(BENCH, { machineId: "sb_9f2c1d8a", provider: "ascii" })],
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
    expect(meta("benchmark the new index").textContent).toBe("··spoo-bench·ascii");
    // The dot alone says it works on a spawned row, and the opener word is dropped: the indent already says it.
    expect(meta("benchmark the new index").textContent).not.toContain("Working");
    expect(meta("benchmark the new index").textContent).not.toContain("agent");
    expect(meta("run the migration across the fleet").textContent).toBe("Working··you");
    expect(rowOf("benchmark the new index").querySelector("[data-thread-provenance]")!.getAttribute("aria-label")).toBe("Claude Code · spoo-bench · ascii");
  });
});

describe("the row's third line", () => {
  it("is cut at the sidebar's cap with the whole sentence on the row's hover text", async () => {
    // A sentence the runtime writes, longer than the row's room: the cut is what keeps the half a person can act
    // on from being decided by the width.
    const note = "putting the helper back on this machine";
    await mount(fakeApi([API], [status(API, { daemonNote: note })]), "api");
    const line = () => metaOf(rowOf("api"));
    await waitFor(() => expect(line().textContent).toBe("putting the helper back on…"));
    expect(line().textContent!.length).toBeLessThanOrEqual(30);
    expect(line().getAttribute("title")).toBe(note);
    // A line inside the room is left whole, and its title is the same words.
    act(() => useStore.getState().applyEvent({ type: "workspace.status", status: status(API, { vaultedAt: "2026-09-08T07:10:04.444Z", vaultRefused: "the export was 646 MB, over the 200 MB cap" }) }));
    await waitFor(() => expect(line().textContent).toBe("no backup since 2026-09-08"));
    expect(line().getAttribute("title")).toBe("no backup since 2026-09-08");
  });
});

describe("a window on another computer while the wsp it shows is asleep", () => {
  const served = (token: string | undefined) => {
    (window as unknown as { __WSP__?: unknown }).__WSP__ = { wsPort: 7788, wsPath: "/ws", paired: true, version: "0.0.0", ...(token === undefined ? {} : { token }) };
  };

  afterEach(() => {
    delete (window as unknown as { __WSP__?: unknown }).__WSP__;
  });

  it("reads the asleep line under the search row in the prose mono, never as an alert, and only on a page the host did not serve on this computer", async () => {
    served(undefined);
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
    served(undefined);
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
    expect(stateSlot(rowOf("web")).textContent).toBe("Paused");
    act(() => useStore.getState().setConn("live"));
    await waitFor(() => expect(glyph("this Mac")).toContain("text-success-foreground"));
  });

  it("says nothing of the kind on the computer the host runs on, where the page carries the host's own token", async () => {
    served("t_local");
    await mount(fakeApi([API], [status(API)]), "api");
    act(() => useStore.getState().setConn("reconnecting"));
    await waitFor(() => expect(useStore.getState().conn).toBe("reconnecting"));
    expect(screen.queryByText(HOST_ASLEEP_LINE)).toBeNull();
  });
});
