// SPDX-License-Identifier: AGPL-3.0-only
// The center region under the shell header: the selected workspace's thread
// with its composer and the terminal drawer under it, or a project's home.
// Nothing stands between the header and the thread.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { HOSTNAME_KEPT, type EventUnion, type GoldenManifest, type WorkspaceView } from "@wsp/protocol";
import { TRANSCRIPT_LOADING } from "../src/transcript-words.js";
import { useComposerDraftStore } from "../src/components/chat/composerDraftStore.js";
import { CREATE_ASKED, CREATE_STEP_WORDS } from "../src/shell/creationLog.js";
import { Shell } from "../src/App.js";
import { RequestError, type Api } from "../src/protocol/client.js";
import { useStore } from "../src/protocol/store.js";
import { useTerminalDrawerStore } from "../src/terminal/drawerStore.js";
import { provideTerminals, WorkspaceTerminals } from "../src/terminal/link.js";
import { installFakeLayout } from "./fake-layout.js";
import { caps } from "./caps.js";
import { noDaemonApi } from "./fake-daemon-api.js";
import { clearNotices } from "./notice-text.js";
import { press, typeInto } from "./composer-harness.js";
import { TABLE_CATALOG, whenAgentsAnswered } from "./agents.js";
import { useComposerOptionsStore } from "../src/components/chat/composerOptionsStore.js";

const WS = "ws_center";
const workspace: WorkspaceView = { id: WS, name: "api", machineId: "m_api", project: { id: "pr_1", name: "the-project", path: "/root", computer: "default" }, phase: "running", golden: "snap_g", createdAt: "2026-09-01T00:00:00Z" };
const manifest: GoldenManifest = {
  head: 1,
  versions: [{ version: 1, snapshotId: "snap_g", baseTemplate: "default", kind: "sandbox", setupSha: "x", createdAt: "t", smoke: { cmd: "true", exitCode: 0 } }],
};

function fakeApi(workspaces: WorkspaceView[]): Api {
  return {
    listWorkspaces: async () => workspaces,
    getWorkspace: async id => workspaces.find(w => w.id === id)!,
    createWorkspace: async () => workspaces[0]!,
    watchStatuses: async () => [],
    nap: async id => workspaces.find(w => w.id === id)!,
    wake: async id => workspaces.find(w => w.id === id)!,
    capabilities: async () => (caps()),
    startSession: async o => ({ id: "s1", workspaceId: o.workspaceId, harness: "claude", status: "running" }),
    portReach: async (_id, port) => ({ url: `https://m1-${port}.preview.example/?pt_token=e`, expiresAt: Date.now() + 3_600_000 }),
    daemon: noDaemonApi,
    sessionHistory: async () => [],
    listSnapshots: async () => ({ name: "default", head: null, versions: [] }),
    snapshotStorage: async () => null,
    rollbackSnapshot: async () => ({ lineage: { name: "default", head: null, versions: [] }, existingWorkspaces: "untouched" }),
    listSessions: async () => [],
    subscribe: () => () => {},
    getGolden: async () => manifest,
  };
}

let restoreLayout: () => void = () => {};
beforeAll(() => { restoreLayout = installFakeLayout(); });
afterAll(() => restoreLayout());

beforeEach(() => {
  window.localStorage.clear();
  useComposerDraftStore.setState({ drafts: {}, queues: {}, held: {} });
  useStore.setState({ api: null, conn: "live", capabilities: null, workspaces: [], statuses: {}, costs: {}, spending: {}, selectedId: null, creations: [], sessions: {}, ready: false, gaps: 0 });
  clearNotices();
  useTerminalDrawerStore.setState({ byWorkspaceId: {} });
});
afterEach(() => {
  cleanup();
  provideTerminals(WS, null);
});

async function mount(workspaces: WorkspaceView[]) {
  useStore.getState().bind(fakeApi(workspaces));
  render(<Shell />);
  await waitFor(() => expect(useStore.getState().ready).toBe(true));
}

describe("workspace center", () => {
  it("the selected workspace's center is its thread with the composer, and no tab strip stands in front", async () => {
    await mount([workspace]);
    const heading = await screen.findByRole("heading", { level: 1 });
    expect(heading.textContent).toContain("What should we build in");
    expect(heading.textContent).toContain("api");
    expect(screen.getByTestId("composer-editor")).toBeDefined();
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryByRole("tab", { name: "terminal" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "screen" })).toBeNull();
  });

  it("the terminal drawer opens under the thread and says so while the workspace's link is not live", async () => {
    provideTerminals(WS, new WorkspaceTerminals({ request: () => Promise.reject(new Error("no daemon in this test")) }));
    await mount([workspace]);
    await screen.findByRole("heading", { level: 1 });
    expect(document.querySelector('[data-terminal-owner="drawer"]')).toBeNull();
    act(() => useTerminalDrawerStore.getState().toggle(WS));
    const drawer = document.querySelector('[data-terminal-owner="drawer"]');
    expect(drawer).not.toBeNull();
    // The link here has never been open, so the drawer says what is being started rather than promising a return.
    expect(drawer!.textContent).toContain("Starting a terminal on api; the first one opens when it is ready");
    expect(screen.getByRole("heading", { level: 1 })).toBeDefined();
  });

  it("with a project recorded and no workspace the center is that project's home instead of a strip or a line that asks for a pick", async () => {
    await mount([]);
    act(() => useStore.setState({ projects: [{ id: "pr_1", name: "the-project", computer: "here", source: { kind: "folder", path: "/root" }, path: "/root", remote: "https://github.com/dev/the-project.git", defaultBranch: "main", memoryKey: "-root", memoryDir: "/root/.claude-cfg/projects/-root/memory", createdAt: "t" }] }));
    await waitFor(() => expect(document.querySelector("[data-k=project-home]")).not.toBeNull());
    expect(screen.queryByText("Pick a workspace to continue")).toBeNull();
    expect(screen.queryByRole("tablist")).toBeNull();
  });
});

describe("workspace creation view", () => {
  const stage = (over: Partial<Extract<EventUnion, { type: "workspace.creating" }>>): EventUnion => ({
    type: "workspace.creating",
    workspaceId: "ws_beta",
    name: "beta",
    stage: "fork-requested",
    message: "starting beta on ascii",
    elapsedMs: 0,
    ...over,
  });
  const emit = (e: EventUnion) => act(() => useStore.getState().applyEvent(e));

  it("creating opens the empty thread it will become with one folded Setting up row; a message waits and goes to the workspace when it is up", async () => {
    let finish!: (w: WorkspaceView) => void;
    const api = fakeApi([workspace]);
    const started: Array<{ workspaceId: string; prompt: string }> = [];
    api.createWorkspace = () => new Promise<WorkspaceView>(resolve => { finish = resolve; });
    api.startSession = async o => { started.push({ workspaceId: o.workspaceId, prompt: o.prompt }); return { id: "s1", workspaceId: o.workspaceId, harness: "claude", status: "running" }; };
    api.listHarnesses = async () => [TABLE_CATALOG];
    useStore.getState().bind(api);
    await whenAgentsAnswered();
    render(<Shell />);
    await screen.findByRole("heading", { level: 1 });
    void useStore.getState().createWorkspace("pr_1", "beta");
    const view = await screen.findByTestId("workspace-creation");
    expect(view.getAttribute("aria-busy")).toBe("true");
    expect(within(view).getByRole("heading", { level: 1 }).textContent).toBe("What should we build in beta?");
    expect(screen.getByRole("banner").textContent).toContain("beta");
    // The compose glyph stays and is held: a creation is not yet a workspace to open a thread in.
    expect(screen.getByRole("button", { name: "New thread" }).getAttribute("aria-disabled")).toBe("true");
    expect(within(view).queryByRole("progressbar")).toBeNull();
    const fold = view.querySelector<HTMLElement>("[data-k=setting-up]")!;
    expect(fold.textContent).toContain("Setting up");
    expect(fold.textContent).toContain(CREATE_ASKED);

    emit(stage({}));
    emit(stage({ stage: "preview-route", message: "Preview route to the daemon minted.", elapsedMs: 3_400 }));
    emit(stage({ stage: "hostname-set", message: HOSTNAME_KEPT, elapsedMs: 5_100, detail: "hostname beta on m1 failed: read-only" }));
    // The row names the step being waited on; naming the machine is a note on a step already taken.
    expect(fold.textContent).toContain(CREATE_STEP_WORDS["preview-route"]);
    fireEvent.click(fold);
    const rows = within(within(view).getByRole("list", { name: "Setting up" })).getAllByRole("listitem");
    expect(rows.map(r => r.textContent)).toEqual([`${CREATE_STEP_WORDS["fork-requested"]}0s`, `${CREATE_STEP_WORDS["preview-route"]}3s`, `${CREATE_STEP_WORDS["hostname-set"]}5s`]);
    expect(view.textContent).not.toMatch(/read-only|minted|starting beta/);
    expect(within(view).queryByRole("button", { name: "Retry" })).toBeNull();

    // A message typed now waits under the creation and is not sent anywhere yet.
    const editor = within(view).getByTestId("composer-editor");
    await typeInto(editor, "add a LICENSE file");
    await press(editor, "Enter");
    expect(within(view).getByRole("list", { name: "Queued messages" }).textContent).toContain("add a LICENSE file");
    expect(started).toEqual([]);
    const key = useStore.getState().selectedId!;
    act(() => useComposerOptionsStore.getState().pick(key, "effort", "low"));

    const created: WorkspaceView = { ...workspace, id: "ws_beta", name: "beta" };
    emit({ type: "workspace.created", workspace: created });
    await act(async () => { finish(created); });
    expect(screen.queryByTestId("workspace-creation")).toBeNull();
    expect(screen.queryByText(TRANSCRIPT_LOADING)).toBeNull();
    // A pick made over the waiting message goes with it.
    expect(useComposerOptionsStore.getState().byWorkspaceId["ws_beta"]).toMatchObject({ effort: "low" });
    await waitFor(() => expect(started).toEqual([{ workspaceId: "ws_beta", prompt: "add a LICENSE file" }]));
    expect(useComposerDraftStore.getState().queues).toEqual({});
  });

  it("with nothing typed the workspace takes the page as its empty thread with no loading line between, the question and the composer where they were", async () => {
    let finish!: (w: WorkspaceView) => void;
    const api = fakeApi([workspace]);
    api.createWorkspace = () => new Promise<WorkspaceView>(resolve => { finish = resolve; });
    // A history read that never answers: the new workspace's page must not wait on it.
    api.sessionHistory = () => new Promise(() => {});
    useStore.getState().bind(api);
    render(<Shell />);
    await waitFor(() => expect(useStore.getState().ready).toBe(true));
    void useStore.getState().createWorkspace("pr_1", "beta");
    const view = await screen.findByTestId("workspace-creation");
    emit(stage({}));
    const dock = view.querySelector("[data-chat-composer-dock]")!;
    expect(dock.hasAttribute("data-centred")).toBe(true);
    const created: WorkspaceView = { ...workspace, id: "ws_beta", name: "beta" };
    emit({ type: "workspace.created", workspace: created });
    await act(async () => { finish(created); });
    expect(screen.queryByTestId("workspace-creation")).toBeNull();
    expect(useStore.getState().selectedId).toBe("ws_beta");
    expect(screen.queryByText(TRANSCRIPT_LOADING)).toBeNull();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("What should we build in beta?");
    expect(document.querySelector("[data-chat-composer-dock]")!.hasAttribute("data-centred")).toBe(true);
  });

  it("a message left waiting under a creation before a reload never goes to the next workspace made", async () => {
    // What a window left under a creation's key is read back held after a reload, when the keys start again.
    const stale = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`creating:${i + 1}`, [{ id: `old-${i}`, prompt: "left from before the reload" }]]));
    act(() => useComposerDraftStore.setState({ queues: stale, held: Object.fromEntries(Object.keys(stale).map(k => [k, true as const])) }));
    const started: string[] = [];
    const created: WorkspaceView = { ...workspace, id: "ws_beta", name: "beta" };
    const api = fakeApi([workspace]);
    api.createWorkspace = async () => created;
    api.startSession = async o => { started.push(o.prompt); return { id: "s1", workspaceId: o.workspaceId, harness: "claude", status: "running" }; };
    api.listHarnesses = async () => [TABLE_CATALOG];
    useStore.getState().bind(api);
    await whenAgentsAnswered();
    render(<Shell />);
    await screen.findByRole("heading", { level: 1 });
    await act(() => useStore.getState().createWorkspace("pr_1", "beta"));
    await waitFor(() => expect(useStore.getState().selectedId).toBe("ws_beta"));
    expect(useComposerDraftStore.getState().queues["ws_beta"]).toBeUndefined();
    expect(started).toEqual([]);
  });

  it("a failure names the failing step in red, explains the refusal once, and retry runs the create again", async () => {
    const CAP_LINE = "both machine slots are in use: first, t-cap. Pause one or wait for a nap.";
    const api = fakeApi([workspace]);
    const create = vi.fn<(name: string) => Promise<WorkspaceView>>();
    create.mockImplementationOnce(async () => {
      useStore.getState().applyEvent(stage({}));
      useStore.getState().applyEvent(stage({ stage: "failed", message: CAP_LINE, elapsedMs: 800 }));
      throw new RequestError(CAP_LINE, "concurrency");
    });
    create.mockImplementation(() => new Promise<WorkspaceView>(() => {}));
    api.createWorkspace = create;
    useStore.getState().bind(api);
    render(<Shell />);
    await screen.findByRole("heading", { level: 1 });
    await act(() => useStore.getState().createWorkspace("pr_1", "beta"));
    const view = await screen.findByTestId("workspace-creation");
    expect(view.getAttribute("aria-busy")).toBe("false");
    const fold = view.querySelector<HTMLElement>("[data-k=setting-up]")!;
    expect(fold.textContent).toContain(CREATE_STEP_WORDS.failed);
    fireEvent.click(fold);
    const rows = within(within(view).getByRole("list", { name: "Setting up" })).getAllByRole("listitem");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.className).toContain("text-destructive-foreground");
    // The runtime's words are the refusal: they appear once, under the lead.
    expect(view.textContent!.split(CREATE_STEP_WORDS.failed)).toHaveLength(2);
    expect(view.textContent!.split(CAP_LINE)).toHaveLength(2);

    fireEvent.click(within(view).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    // The retry goes back to the same project, with the same size: a retry is the create again, not a new one.
    expect(create).toHaveBeenLastCalledWith("pr_1", "beta", {});
    await waitFor(() => expect(screen.getByTestId("workspace-creation").getAttribute("aria-busy")).toBe("true"));
    expect(within(screen.getByTestId("workspace-creation")).queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("dismissing a failed creation returns the center to the first workspace and drops what waited for it", async () => {
    const api = fakeApi([workspace]);
    api.createWorkspace = async () => { throw new Error("no golden image yet"); };
    useStore.getState().bind(api);
    render(<Shell />);
    await screen.findByRole("heading", { level: 1 });
    await act(() => useStore.getState().createWorkspace("pr_1", "beta"));
    const view = await screen.findByTestId("workspace-creation");
    expect(view.textContent).toContain("no golden image yet");
    const key = useStore.getState().selectedId!;
    act(() => {
      useComposerDraftStore.getState().enqueue(key, "add a LICENSE file");
      useComposerDraftStore.getState().setDraft(key, { prompt: "and a README", cursor: 12 });
      useComposerOptionsStore.getState().pick(key, "effort", "low");
    });
    fireEvent.click(within(view).getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(screen.queryByTestId("workspace-creation")).toBeNull());
    expect(useStore.getState().selectedId).toBe(WS);
    // What waited for a machine that will never come goes with it, rather than into a thread nobody asked for.
    expect(useComposerDraftStore.getState().queues).toEqual({});
    // And so does everything else kept under the creation's key, which nothing would ever read again.
    expect(useComposerDraftStore.getState().drafts[key]).toBeUndefined();
    expect(useComposerOptionsStore.getState().byWorkspaceId[key]).toBeUndefined();
    expect((await screen.findByRole("heading", { level: 1 })).textContent).toContain("api");
  });
});
