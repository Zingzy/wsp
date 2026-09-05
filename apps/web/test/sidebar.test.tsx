// SPDX-License-Identifier: AGPL-3.0-only
// The workspace sidebar over the fixture wire: rows from the store's
// workspaces, statuses, costs and sessions; grouping; search; keyboard
// traversal; the new-workspace dialog; the zombie rebuild action.
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionView, WorkspaceStatus, WorkspaceView } from "@wsp/protocol";
import { SidebarProvider } from "../src/components/ui/sidebar.js";
import { RequestError, type Api } from "../src/protocol/client.js";
import { useStore } from "../src/protocol/store.js";
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

const status = (w: WorkspaceView, over: Partial<WorkspaceStatus> = {}): WorkspaceStatus => ({
  ...w,
  machineState: w.phase === "napping" ? "paused" : "running",
  reach: { state: w.phase === "napping" ? "napping" : "reachable" },
  size: { cpu: 2, memMb: 4096 },
  rateUsdPerHour: 0.11,
  ...over,
});

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
    upgrade: vi.fn(async (id: string) => view(id, "?", "running")),
    capabilities: vi.fn(async () => ({ liveCloneForks: true, ramPreservingPause: true, resize: true, previewUrls: true, signedUrls: true, containers: true, callbackRelay: true })),
    startSession: vi.fn(async (o: { workspaceId: string }) => session("s_x", o.workspaceId)),
    portReach: vi.fn(async (_id: string, port: number) => ({ url: `https://m1-${port}.preview.example/?pt_token=e`, expiresAt: NOW + 3_600_000 })),
    daemonReach: vi.fn(async () => ({ url: "ws://127.0.0.1:1", expiresAt: 0 })),
    builderReach: vi.fn(async () => ({ url: "ws://127.0.0.1:1", expiresAt: 0 })),
    sessionHistory: vi.fn(async () => []),
    listSnapshots: vi.fn(async () => ({ name: "default", head: null, versions: [] })),
    rollbackSnapshot: vi.fn(async () => ({ lineage: { name: "default", head: null, versions: [] }, existingWorkspaces: "untouched" as const })),
    listSessions: vi.fn(async () => sessions),
    subscribe: vi.fn(() => () => {}),
    getGolden: async () => undefined,
    prepareGolden: async () => { throw new Error("no wizard in this fixture"); },
    sealGolden: async () => { throw new Error("no wizard in this fixture"); },
  };
}

beforeEach(() => {
  window.localStorage.clear();
  useStore.setState({ api: null, conn: "live", capabilities: null, workspaces: [], statuses: {}, costs: {}, spending: {}, toast: null, selectedId: null, sessions: {}, ready: false });
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
    // The Idle header shows only where a workspace has both working and idle threads; ws_b's single group has none.
    expect(rowIds()).toEqual(["ws:ws_a", "thread:s1", "settled:ws_a", "thread:s2", "ws:ws_b", "thread:s3"]);
    expect(rowOf("fix the port list").textContent).toContain("3m");
    expect(rowOf("upgrade node").textContent).toContain("50m");
    // a session without a prompt falls back to the harness session id
    expect(rowOf("59094224-bb3d").textContent).toContain("2d");
    // status pills: the running one works, the one that never settled ended, the idle one is plain
    expect(within(rowOf("fix the port list")).getByLabelText("Working")).toBeDefined();
    expect(within(rowOf("59094224-bb3d")).getByLabelText("Ended")).toBeDefined();
    expect(within(rowOf("upgrade node")).queryByLabelText(/Idle|Completed/)).toBeNull();
    expect(screen.getByRole("button", { name: /^Idle/ })).toBeDefined();
    expect(screen.queryByText(/Settled/)).toBeNull();
  });

  it("the idle shelf collapses per workspace and remembers it", async () => {
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
    const toggle = await screen.findByRole("button", { name: /Idle/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(toggle);
    expect(screen.queryByText("upgrade node")).toBeNull();
    expect(screen.getByRole("button", { name: "Idle (1)" })).toBeDefined();
    expect(window.localStorage.getItem("wsp:sidebar-settled-expanded")).toBe("false");
  });

  it("a workspace whose threads are all idle lists them under no header, even with the shelf remembered collapsed", async () => {
    window.localStorage.setItem("wsp:sidebar-settled-expanded", "false");
    await mount(
      fakeApi([API], [status(API)], [session("s2", "ws_a", { status: "completed", prompt: "upgrade node", startedAt: iso(-60_000), endedAt: iso(-1_000) })]),
      "api",
    );
    await waitFor(() => expect(screen.getByText("upgrade node")).toBeDefined());
    expect(screen.queryByRole("button", { name: /Idle|Settled/ })).toBeNull();
    expect(rowIds()).toEqual(["ws:ws_a", "thread:s2"]);
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

  it("clicking a workspace or one of its threads selects that workspace", async () => {
    await mount(fakeApi([API, WEB], [status(API), status(WEB)], [session("s1", "ws_b", { prompt: "hello" })]), "api");
    await waitFor(() => expect(screen.getByText("hello")).toBeDefined());
    fireEvent.click(rowOf("hello"));
    expect(useStore.getState().selectedId).toBe("ws_b");
    fireEvent.click(rowOf("api"));
    expect(useStore.getState().selectedId).toBe("ws_a");
    expect(rowOf("api").getAttribute("data-active")).toBe("true");
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
    const line = screen.getByText(/No threads yet/).parentElement!;
    expect(item(line)).toBe(item(rowOf("web")));
    expect(within(item(rowOf("api"))).queryByText(/No threads yet/)).toBeNull();
    fireEvent.click(within(line).getByRole("button", { name: /New thread/ }));
    expect(seen).toEqual(["ws_b"]);
    off();
  });

  it("a zombie row offers the rebuild and no new thread", async () => {
    await mount(fakeApi([API], [status(API, { reach: { state: "zombie" } })]), "api");
    await waitFor(() => expect(screen.getByRole("button", { name: "Rebuild api" })).toBeDefined());
    expect(screen.queryByRole("button", { name: "New thread in api" })).toBeNull();
  });
});

describe("search", () => {
  it("narrows threads by title and keeps workspaces whose name matches", async () => {
    await mount(
      fakeApi(
        [API, WEB],
        [status(API), status(WEB)],
        [session("s1", "ws_a", { prompt: "fix the port list" }), session("s2", "ws_a", { prompt: "upgrade node" }), session("s3", "ws_b", { prompt: "port forwarding" })],
      ),
      "api",
    );
    await waitFor(() => expect(screen.getByText("port forwarding")).toBeDefined());
    const search = screen.getByRole("searchbox");
    fireEvent.change(search, { target: { value: "port" } });
    expect(rowIds()).toEqual(["ws:ws_a", "thread:s1", "ws:ws_b", "thread:s3"]);
    fireEvent.change(search, { target: { value: "web" } });
    expect(rowIds()).toEqual(["ws:ws_b"]);
    fireEvent.change(search, { target: { value: "nothing here" } });
    expect(rowIds()).toEqual([]);
    expect(screen.getByText(/No matches/)).toBeDefined();
    fireEvent.keyDown(search, { key: "Escape" });
    expect((search as HTMLInputElement).value).toBe("");
    expect(rowIds().length).toBe(5);
  });
});

describe("keyboard navigation", () => {
  it("arrows walk every row in order from the search box; Enter selects", async () => {
    await mount(fakeApi([API, WEB], [status(API), status(WEB)], [session("s1", "ws_a", { prompt: "hello" })]), "api");
    await waitFor(() => expect(screen.getByText("hello")).toBeDefined());
    const search = screen.getByRole("searchbox");
    search.focus();
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
    api.createFromGoldenHead = vi.fn(async (name: string) => ({ ...view("ws_new", name), notice: "Stopped the builder kept from golden v1 (m1) to make room at the machine cap." }));
    await mount(api, "api");
    const { input } = await openDialog();
    fireEvent.keyDown(input, { key: "Enter" });
    await screen.findByRole("status", { name: /Stopped the builder kept from golden v1/ });
    expect(useStore.getState().toast).toBe("Stopped the builder kept from golden v1 (m1) to make room at the machine cap.");
  });

  it("offers a default name, creates on Enter, shows a pending row until workspace.created, then selects it", async () => {
    let finish!: (w: WorkspaceView) => void;
    const api = fakeApi([API], [status(API)]);
    api.createFromGoldenHead = vi.fn(() => new Promise<WorkspaceView>(resolve => { finish = resolve; }));
    await mount(api, "api");
    const { input } = await openDialog();
    expect(input.value).toBe("workspace-1");
    fireEvent.change(input, { target: { value: "beta" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(api.createFromGoldenHead).toHaveBeenCalledWith("beta");
    const pending = await screen.findByText("beta");
    expect(pending.closest("[data-sidebar-row]")!.getAttribute("aria-busy")).toBe("true");
    const created = view("ws_beta", "beta");
    await act(async () => { finish(created); });
    expect(screen.getByText("beta").closest("[data-sidebar-row]")!.getAttribute("aria-busy")).toBe("true");
    act(() => useStore.getState().applyEvent({ type: "workspace.created", workspace: created }));
    await waitFor(() => expect(rowOf("beta").getAttribute("aria-busy")).toBeNull());
    expect(screen.getAllByText("beta").length).toBe(1);
    expect(useStore.getState().selectedId).toBe("ws_beta");
  });

  it("a refusal reopens the dialog with the name kept and the provider cap explained inline", async () => {
    const api = fakeApi([API], [status(API)]);
    api.createFromGoldenHead = vi.fn(async () => { throw new RequestError("Sandbox limit reached", "concurrency"); });
    await mount(api, "api");
    const { input } = await openDialog();
    fireEvent.change(input, { target: { value: "gamma" } });
    fireEvent.keyDown(input, { key: "Enter" });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/machine cap/i);
    expect(alert.textContent).toContain("Sandbox limit reached");
    expect((within(screen.getByRole("dialog")).getByLabelText("Name") as HTMLInputElement).value).toBe("gamma");
    expect(screen.queryByText("gamma", { selector: "[data-sidebar-row] *" })).toBeNull();
    expect(useStore.getState().toast).toBeNull();
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
