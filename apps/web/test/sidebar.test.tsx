// SPDX-License-Identifier: AGPL-3.0-only
// The workspace sidebar over the fixture wire: rows from the store's
// workspaces, statuses, costs and sessions; grouping; search; keyboard
// traversal; the new-workspace dialog; the zombie rebuild and the gone forget.
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DAEMON_UPDATE_FAILED, DAEMON_UPDATING, exportFromLine, importIntoLine, type SessionView, type WorkspaceStatus, type WorkspaceView } from "@wsp/protocol";
import { onOpenCommandPalette } from "../src/commandPaletteBus.js";
import { SidebarProvider } from "../src/components/ui/sidebar.js";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "../src/keybindingDefaults.js";
import { shortcutLabelForCommand } from "../src/keybindings.js";
import { getLive, resetLive } from "../src/machine/live.js";
import { RequestError, type Api } from "../src/protocol/client.js";
import { useStore } from "../src/protocol/store.js";
import { statusOf } from "./workspace-status.js";
import { onNewThreadRequest } from "../src/shell/shellRequests.js";
import { WorkspaceSidebar } from "../src/sidebar/WorkspaceSidebar.js";

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
    capabilities: vi.fn(async () => ({ liveCloneForks: true, ramPreservingPause: true, resize: true, previewUrls: true, signedUrls: true, containers: true, callbackRelay: true, snapshotListing: true, sizes: [] })),
    startSession: vi.fn(async (o: { workspaceId: string }) => session("s_x", o.workspaceId)),
    portReach: vi.fn(async (_id: string, port: number) => ({ url: `https://m1-${port}.preview.example/?pt_token=e`, expiresAt: NOW + 3_600_000 })),
    daemonReach: vi.fn(async () => ({ url: "ws://127.0.0.1:1", expiresAt: 0 })),
    sessionHistory: vi.fn(async () => []),
    listSnapshots: vi.fn(async () => ({ name: "default", head: null, versions: [] })),
    snapshotStorage: async () => null,
    rollbackSnapshot: vi.fn(async () => ({ lineage: { name: "default", head: null, versions: [] }, existingWorkspaces: "untouched" as const })),
    listSessions: vi.fn(async () => sessions),
    subscribe: vi.fn(() => () => {}),
    getGolden: async () => undefined,
  };
}

beforeEach(() => {
  window.localStorage.clear();
  useStore.setState({ api: null, conn: "live", capabilities: null, workspaces: [], statuses: {}, costs: {}, spending: {}, toast: null, selectedId: null, selectedThreadId: null, creations: [], sessions: {}, ready: false });
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

  it("the lockup starts at the sidebar content inset, where the search row does", async () => {
    useStore.getState().bind(fakeApi([], []));
    await act(async () => {
      render(
        <SidebarProvider defaultOpen>
          <WorkspaceSidebar />
        </SidebarProvider>,
      );
    });
    const lockup = screen.getByRole("img", { name: "wsp" }).parentElement!;
    expect(lockup.className).toContain("ml-[var(--sidebar-content-inset)]");
    expect(lockup.className).not.toContain("titlebar");
    expect(screen.getByRole("button", { name: "Search" }).parentElement!.className).toContain("px-[var(--sidebar-content-inset)]");
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
    // Every workspace with an idle thread gets the Idle header, whether or not one of its threads is working.
    expect(rowIds()).toEqual(["ws:ws_a", "thread:s1", "settled:ws_a", "thread:s2", "ws:ws_b", "settled:ws_b", "thread:s3"]);
    expect(rowOf("fix the port list").textContent).toContain("3m");
    expect(rowOf("upgrade node").textContent).toContain("50m");
    // a session without a prompt falls back to the harness session id
    expect(rowOf("59094224-bb3d").textContent).toContain("2d");
    // status pills: the running one works, the one that never settled ended, the idle one is plain
    expect(within(rowOf("fix the port list")).getByLabelText("Working")).toBeDefined();
    expect(within(rowOf("59094224-bb3d")).getByLabelText("Ended")).toBeDefined();
    expect(within(rowOf("upgrade node")).queryByLabelText(/Idle|Completed/)).toBeNull();
    expect(screen.getAllByRole("button", { name: /^Idle/ })).toHaveLength(2);
    expect(screen.queryByText(/Settled/)).toBeNull();
  });

  it("three workspaces in mixed states: the running one leads, then the paused, then the gone, whatever order they were created in; a creating row sits above them all", async () => {
    const gone = { ...view("ws_gone", "scratch"), createdAt: new Date(NOW - 3 * 24 * 60 * 60_000).toISOString() };
    const paused = { ...view("ws_nap", "spike", "napping"), createdAt: new Date(NOW - 2 * 60 * 60_000).toISOString() };
    const running = { ...view("ws_run", "dev"), createdAt: new Date(NOW - 60_000).toISOString() };
    await mount(fakeApi([gone, paused, running], [status(gone, { machineState: "gone", reach: { state: "gone" } }), status(paused), status(running)]), "dev");
    await waitFor(() => expect(rowIds()).toEqual(["ws:ws_run", "ws:ws_nap", "ws:ws_gone"]));
    expect(rowOf("dev").textContent).toContain("Running");
    expect(rowOf("spike").textContent).toContain("Paused");
    expect(rowOf("scratch").textContent).toContain("Gone");
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
      expect(mark.nextElementSibling?.className).toContain("text-muted-foreground/55");
      return { label: provenance(title).getAttribute("aria-label"), text: provenance(title).textContent, mark: mark.getAttribute("data-harness-mark"), svg: mark.tagName, tone, size: [...mark.classList].find(c => c.startsWith("size-")) };
    };
    expect(reads("fix the port list")).toEqual({ label: "Claude Code · cli", text: "cli", mark: "claude", svg: "svg", tone: "text-agent-claude", size: "size-[13px]" });
    expect(reads("upgrade node")).toEqual({ label: "Codex · you", text: "you", mark: "codex", svg: "svg", tone: undefined, size: "size-[13px]" });
    expect(reads("before provenance")).toEqual({ label: "Claude Code · you", text: "you", mark: "claude", svg: "svg", tone: "text-agent-claude", size: "size-[13px]" });
    expect(reads("from the director")).toEqual({ label: "Claude Code · agent", text: "agent", mark: "claude", svg: "svg", tone: "text-agent-claude", size: "size-[13px]" });
    const line = provenance("fix the port list").closest<HTMLElement>("[data-thread-meta]")!;
    expect(line.className).toContain("font-mono");
    expect(line.className).toContain("text-muted-foreground");
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
    expect(meta.textContent).toBe("Working·you");
    expect(meta.className).toContain("font-mono");
    expect(rowOf(SHORT).querySelector("[data-thread-meta]")!.textContent).toBe("cli");
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

  it("a workspace row carries phase, rate, accrued, idle countdown and the edge-slow note", async () => {
    await mount(
      fakeApi(
        [API, WEB],
        [status(API, { idleAt: iso(14.5 * 60_000), reach: { state: "slow" } }), status(WEB)],
      ),
      "api",
    );
    await waitFor(() => expect(rowOf("api").textContent).toContain("naps in 14m"));
    expect(rowOf("api").textContent).toContain("Running");
    expect(rowOf("api").textContent).toContain("edge slow");
    expect(rowOf("api").textContent).toContain("$0.110/hr");
    expect(rowOf("web").textContent).toContain("Paused");
    expect(rowOf("web").textContent).not.toContain("/hr");
    act(() =>
      useStore.getState().applyEvent({ type: "workspace.cost", workspaceId: "ws_a", phase: "running", rateUsdPerHour: 0.11, awakeMs: 120_000, accruedUsd: 0.0037, at: new Date(NOW).toISOString() }),
    );
    await waitFor(() => expect(rowOf("api").textContent).toContain("$0.0037 today"));
    act(() => useStore.getState().applyEvent({ type: "workspace.status", status: status(API) }));
    await waitFor(() => expect(rowOf("api").textContent).toContain("active"));
    expect(rowOf("api").textContent).not.toContain("edge slow");
  });

  it("while the runtime replaces the machine's helper the row says only that, and clears when it lands", async () => {
    await mount(fakeApi([API, WEB], [status(API, { idleAt: iso(14.5 * 60_000) }), status(WEB)]), "api");
    await waitFor(() => expect(rowOf("api").textContent).toContain("naps in 14m"));

    act(() => useStore.getState().applyEvent({ type: "workspace.status", status: { ...status(API, { idleAt: iso(14.5 * 60_000) }), daemonNote: DAEMON_UPDATING } }));
    await waitFor(() => expect(rowOf("api").textContent).toContain(DAEMON_UPDATING));
    // The one thing on the row worth waiting for takes the line; the rate and the countdown wait their turn.
    expect(rowOf("api").textContent).not.toContain("naps in 14m");
    expect(rowOf("api").textContent).not.toContain("$0.110/hr");
    expect(rowOf("api").textContent).toContain("Running");
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

  it("a workspace row offers the import when the runtime can read folders here, and the dialog opens for that workspace", async () => {
    const api = fakeApi([API, WEB], [status(API), status(WEB)]);
    api.planProject = vi.fn(async () => ({ source: "/private/var/proj", repo: true, files: 3, bytes: 900, secrets: [], excluded: [], skipped: [], agents: [] }));
    api.importProject = vi.fn();
    await mount(api, "api");
    fireEvent.click(screen.getByRole("button", { name: "Import a project into web" }));
    const dialog = await screen.findByRole("dialog", { name: "Import a project" });
    expect(within(dialog).getByText(importIntoLine("web"))).toBeDefined();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("without the project ops no row offers the import or the export", async () => {
    await mount(fakeApi([API], [status(API)]), "api");
    expect(screen.queryByRole("button", { name: /Import a project into/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Export a project from/ })).toBeNull();
    expect(screen.getByRole("button", { name: "New thread in api" })).toBeDefined();
  });

  it("a workspace row offers the export when the runtime can land folders here, and the dialog opens for that workspace", async () => {
    const api = fakeApi([API, WEB], [status(API), status(WEB)]);
    api.exportProject = vi.fn();
    await mount(api, "api");
    fireEvent.click(screen.getByRole("button", { name: "Export a project from web" }));
    const dialog = await screen.findByRole("dialog", { name: "Export a project" });
    expect(within(dialog).getByText(exportFromLine("web"))).toBeDefined();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("a zombie row offers the rebuild and no new thread", async () => {
    await mount(fakeApi([API], [status(API, { reach: { state: "zombie" } })]), "api");
    await waitFor(() => expect(screen.getByRole("button", { name: "Rebuild api" })).toBeDefined());
    expect(screen.queryByRole("button", { name: "New thread in api" })).toBeNull();
  });
});

describe("search", () => {
  it("the row is the palette's door: a glyph, the word Search and the palette chord in muted mono; a click opens the palette, focus alone does not, and no field ever appears", async () => {
    await mount(fakeApi([API, WEB], [status(API), status(WEB)], [session("s1", "ws_a", { prompt: "hello" })]), "api");
    const opened: boolean[] = [];
    const off = onOpenCommandPalette(detail => opened.push(detail.toggle === true));
    const row = screen.getByRole("button", { name: "Search" });
    const chord = shortcutLabelForCommand(DEFAULT_RESOLVED_KEYBINDINGS, "commandPalette.toggle");
    expect(chord).not.toBeNull();
    expect(row.querySelector("svg.lucide-search")).not.toBeNull();
    expect(row.textContent).toBe(`Search${chord}`);
    const kbd = row.querySelector("kbd")!;
    expect(kbd.textContent).toBe(chord);
    expect(kbd.className).toContain("font-mono");
    expect(kbd.className).toContain("ms-auto");
    expect(kbd.className).toContain("text-muted-foreground");
    // The row is the kit's row: no border, no fill at rest, the hover tint every other row has.
    expect(row.className).not.toMatch(/\bborder\b|ring-1|bg-background|bg-sidebar-control-surface/);
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

  it("the new-workspace glyph sits at the row's right edge and opens the dialog; the footer has no New workspace row", async () => {
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
    expect(document.querySelector("[data-slot=sidebar-footer]")!.textContent).toBe("");
    fireEvent.click(glyph);
    expect(await screen.findByRole("dialog", { name: "New workspace" })).toBeDefined();
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
    api.capabilities = vi.fn(async () => ({ liveCloneForks: true, ramPreservingPause: true, resize: false, previewUrls: true, signedUrls: true, containers: true, callbackRelay: true, snapshotListing: true, sizes: [{ cpu: 2, memMb: 4096, rateUsdPerHour: 0.11 }, { cpu: 2, memMb: 8192, rateUsdPerHour: 0.15 }] }));
    api.getGolden = async () => ({ head: 1, versions: [{ version: 1, snapshotId: "snap_g", baseTemplate: "t", setupSha: "s", createdAt: "c", smoke: { cmd: "true", exitCode: 0 }, size: { cpu: 2, memMb: 4096 } }] });
    api.createFromGoldenHead = vi.fn(async (name: string) => view("ws_new", name));
    await mount(api, "api");
    const { dialog, input } = await openDialog();
    const group = within(dialog).getByRole("radiogroup", { name: "Size" });
    await waitFor(() => expect(within(group).getAllByRole("radio").map(r => r.getAttribute("aria-checked"))).toEqual(["true", "false"]));
    fireEvent.change(input, { target: { value: "beta" } });
    fireEvent.click(within(group).getByRole("radio", { name: /8 GB/ }));
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

  it("a refusal keeps the row, names the refusal on it, and reopens no dialog", async () => {
    const api = fakeApi([API], [status(API)]);
    api.createFromGoldenHead = vi.fn(async () => { throw new RequestError("Sandbox limit reached", "concurrency"); });
    await mount(api, "api");
    const { input } = await openDialog();
    fireEvent.change(input, { target: { value: "gamma" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(rowOf("gamma").textContent).toMatch(/machine cap/i));
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
    act(() => useStore.getState().applyEvent({ type: "workspace.cost", workspaceId: "ws_a", phase: "running", rateUsdPerHour: 0.11, awakeMs: 60_000, accruedUsd: 0.0018, at: new Date(NOW).toISOString() }));
    const row = rowOf("api");
    await waitFor(() => expect(row.textContent).toContain("Gone"));
    expect(row.textContent).not.toContain("/hr");
    expect(row.textContent).not.toContain("naps");
    expect(row.textContent).not.toContain("active");
    expect(row.textContent).toContain("$0.0018 today");
    expect(screen.getByRole("button", { name: "Rebuild api" }).getAttribute("title")).toBe(gone.reason!);
  });

  it("a gone row offers forget beside the rebuild; confirming names what goes, calls the api once, and the row leaves on workspace.deleted", async () => {
    const api = await mount(fakeApi([OLD], [status(OLD)], [session("s1", "ws_c", { prompt: "fix the port list", status: "completed" })]), "old");
    await waitFor(() => expect(rowOf("old").textContent).toContain("Gone"));
    expect(screen.getByRole("button", { name: "Rebuild old" })).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Forget old" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("Forget old?");
    expect(dialog.textContent).toContain("Its record and 1 thread leave this computer; the machine is already gone.");
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
    expect(rowOf("api").textContent).toContain("Running");
  });
});
