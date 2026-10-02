// SPDX-License-Identifier: AGPL-3.0-only
// The first message of a thread started from New thread is the window's to keep
// until the workspace is up: a reload, a closed window or a crash while the copy
// is made must not lose it, and it lands on the workspace's queue once, ahead of
// anything typed on the setup page. A reload is the store's modules evaluated
// again over the same local storage.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PREFERENCES, type HarnessCatalog, type ProjectView, type WorkspaceView } from "@wsp/protocol";
import { RequestError, type Api } from "../src/protocol/client.js";
import { KEPT_CREATIONS_KEY } from "../src/protocol/keptCreations.js";
import { projectHomeKey, useStore } from "../src/protocol/store.js";
import { ProjectHome } from "../src/shell/ProjectHome.js";
import { useComposerDraftStore } from "../src/components/chat/composerDraftStore.js";
import { useComposerOptionsStore } from "../src/components/chat/composerOptionsStore.js";
import { useMultiPickStore } from "../src/components/chat/composerMultiPick.js";
import { composerEditor, press, typeInto } from "./composer-harness.js";
import { installFakeLayout } from "./fake-layout.js";
import { caps } from "./caps.js";
import { noDaemonApi } from "./fake-daemon-api.js";

const PROJECT: ProjectView = { id: "pr_1", name: "the-project", computer: "here", source: { kind: "folder", path: "/root" }, path: "/root", remote: "https://github.com/dev/the-project.git", defaultBranch: "main", memoryKey: "-root", memoryDir: "/root/.claude-cfg/projects/-root/memory", createdAt: "t" };
const HOME = projectHomeKey(PROJECT.id);
const TASK = "fix the flaky login test";
const CLAUDE: HarnessCatalog = {
  harness: "claude",
  label: "Claude Code",
  source: "harness",
  version: "2.1.257",
  models: [{ value: "claude-opus-5", label: "Opus 5", isDefault: true }, { value: "claude-sonnet-5", label: "Sonnet 5" }],
  efforts: [{ value: "high", label: "High", isDefault: true }],
  contextWindows: [],
  permissionModes: [],
  steers: true,
  renames: true,
  images: true,
};

const view = (id: string, name: string, createdAt = "2026-10-02T00:00:00Z"): WorkspaceView => ({ id, name, machineId: "local", project: { id: PROJECT.id, name: PROJECT.name, path: "/root", computer: "here" }, phase: "running", golden: "", createdAt });

/** A host whose create answers only when `finish` is called, and whose list holds what `listed` holds. */
function fakeApi(listed: WorkspaceView[] = []) {
  let finish: (w: WorkspaceView) => void = () => {};
  const asked: string[] = [];
  const api: Api = {
    preferences: async () => DEFAULT_PREFERENCES,
    listHarnesses: async () => [CLAUDE],
    portReach: async (_id, port) => ({ url: `https://m1-${port}.preview.example/`, expiresAt: Date.now() + 3_600_000 }),
    daemon: noDaemonApi,
    sessionHistory: async () => [],
    listSnapshots: async () => ({ name: "default", head: null, versions: [] }),
    snapshotStorage: async () => null,
    rollbackSnapshot: async () => ({ lineage: { name: "default", head: null, versions: [] }, existingWorkspaces: "untouched" }),
    listWorkspaces: async () => listed,
    getWorkspace: async id => view(id, id),
    createWorkspace: (_project, name) => {
      asked.push(name);
      return new Promise<WorkspaceView>(resolve => (finish = resolve));
    },
    nap: async id => view(id, id),
    wake: async id => view(id, id),
    capabilities: async () => caps(),
    listSessions: async () => [],
    watchStatuses: async () => [],
    subscribe: () => () => {},
    getGolden: async () => undefined,
    projectsList: async () => [PROJECT],
    startSession: async o => ({ id: "s_1", workspaceId: o.workspaceId, harness: "claude", status: "running" }),
  };
  return { api, asked, finish: (w: WorkspaceView) => finish(w) };
}

let restoreLayout: () => void = () => {};
beforeAll(() => { restoreLayout = installFakeLayout(); });
afterAll(() => restoreLayout());
beforeEach(() => {
  window.localStorage.clear();
  useComposerDraftStore.setState({ drafts: {}, queues: {}, held: {} });
  useComposerOptionsStore.setState({ byWorkspaceId: {}, pickedOn: {} });
  useMultiPickStore.setState({ byKey: {} });
  useStore.setState({ conn: "live", workspaces: [], creations: [], statuses: {}, sessions: {}, selectedId: null, selectedThreadId: null, harnesses: [], harnessesByWorkspace: {}, preferences: DEFAULT_PREFERENCES, projects: [PROJECT] });
});
/** The store the last reload made, closed after each test so no wait it armed outlives it. */
let reloaded: typeof useStore | undefined;
afterEach(() => {
  reloaded?.getState().setConn("closed");
  reloaded = undefined;
  cleanup();
  vi.resetModules();
});

/** Types the task on the project's home and sends it, leaving the create in flight. */
async function sendFromHome(api: Api) {
  useStore.getState().bind(api);
  render(<ProjectHome projectId={PROJECT.id} />);
  await waitFor(() => expect(document.querySelector('[data-composer-picker="model"][data-value]')).not.toBeNull());
  const editor = composerEditor();
  await typeInto(editor, TASK);
  await press(editor, "Enter");
  await waitFor(() => expect(useStore.getState().creations).toHaveLength(1));
}

/** Runs `steps` on a fake clock from a fresh connect, the wait the first connect armed on the real one cleared first. */
function onFakeClock(store: typeof useStore, steps: () => void): void {
  store.getState().setConn("closed");
  vi.useFakeTimers();
  try {
    store.getState().setConn("live");
    steps();
  } finally {
    store.getState().setConn("closed");
    vi.useRealTimers();
  }
}

/** The page loaded again: every module read anew off the local storage the last one left. */
async function reload(api: Api) {
  cleanup();
  vi.resetModules();
  const { useStore: store } = await import("../src/protocol/store.js");
  const { useComposerDraftStore: drafts } = await import("../src/components/chat/composerDraftStore.js");
  store.setState({ projects: [PROJECT] });
  store.getState().bind(api);
  await waitFor(() => expect(store.getState().ready).toBe(true));
  reloaded = store;
  return { store, queue: (key: string) => drafts.getState().queues[key]?.map(r => r.prompt) ?? [] };
}

describe("New thread's first message across a reload", () => {
  it("a reload while the copy is made keeps the message on the setup page, and the workspace takes it when it is up", async () => {
    const first = fakeApi();
    await sendFromHome(first.api);
    const { store, queue } = await reload(fakeApi().api);
    expect(store.getState().creations).toEqual([expect.objectContaining({ name: TASK, project: PROJECT.id, asked: TASK, workspaceId: null })]);
    const { WorkspaceCreation } = await import("../src/shell/WorkspaceCreation.js");
    render(<WorkspaceCreation creation={store.getState().creations[0]!} />);
    expect(document.querySelector("[data-k=creation-asked]")?.textContent).toContain(TASK);
    // A copy on this computer says nothing until it is made; the created frame names it by the name it was asked for.
    store.getState().applyEvent({ type: "workspace.created", workspace: view("ws_new", TASK) });
    expect(queue("ws_new")).toEqual([TASK]);
    expect(store.getState().creations).toEqual([]);
    store.getState().applyEvent({ type: "workspace.created", workspace: view("ws_new", TASK) });
    expect(queue("ws_new"), "once").toEqual([TASK]);
  });

  it("a window closed until the copy stood finds the workspace in the list and queues the message there", async () => {
    await sendFromHome(fakeApi().api);
    const { store, queue } = await reload(fakeApi([view("ws_new", TASK)]).api);
    await waitFor(() => expect(queue("ws_new")).toEqual([TASK]));
    expect(store.getState().creations).toEqual([]);
  });

  it("a fork's stages after the reload find the kept row, and a refusal keeps it with Retry", async () => {
    await sendFromHome(fakeApi().api);
    const { store } = await reload(fakeApi().api);
    store.getState().applyEvent({ type: "workspace.creating", workspaceId: "ws_far", name: TASK, stage: "failed", message: "boom", elapsedMs: 10 });
    expect(store.getState().creations).toEqual([expect.objectContaining({ asked: TASK, project: PROJECT.id, workspaceId: "ws_far", failed: { title: `Could not start ${TASK}`, detail: "boom" } })]);
  });

  it("a kept row the host says nothing about for 30 seconds after the window connects can be dismissed, its message still on screen", async () => {
    await sendFromHome(fakeApi().api);
    const deleted: string[] = [];
    const again = fakeApi();
    again.api.deleteWorkspace = async id => void deleted.push(id);
    const { store, queue } = await reload(again.api);
    const { WorkspaceCreation } = await import("../src/shell/WorkspaceCreation.js");
    const { CREATE_QUIET } = await import("../src/shell/creationLog.js");
    const key = store.getState().creations[0]!.key;
    onFakeClock(store, () => {
      act(() => vi.advanceTimersByTime(29_000));
      expect(store.getState().creations[0]!.quiet).toBeUndefined();
      act(() => vi.advanceTimersByTime(1_000));
    });
    render(<WorkspaceCreation creation={store.getState().creations[0]!} />);
    expect(document.querySelector("[data-k=creation-asked]")?.textContent).toContain(TASK);
    expect(screen.getByText(CREATE_QUIET)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(store.getState().creations).toEqual([]);
    expect(queue(key)).toEqual([]);
    expect(deleted).toEqual([]);
    expect(JSON.parse(window.localStorage.getItem(KEPT_CREATIONS_KEY) ?? "{}")).toEqual({});
  });

  it("dismissing a quiet row whose stages named its workspace before the reload leaves that workspace's create alone", async () => {
    window.localStorage.setItem(KEPT_CREATIONS_KEY, JSON.stringify({ "": [{ key: "creating:k1", name: TASK, project: PROJECT.id, askedAt: Date.now(), asked: TASK, queued: true, workspaceId: "ws_far", failed: null }] }));
    const deleted: string[] = [];
    const api = fakeApi().api;
    api.deleteWorkspace = async id => void deleted.push(id);
    const { store } = await reload(api);
    onFakeClock(store, () => act(() => vi.advanceTimersByTime(30_000)));
    expect(store.getState().creations[0]!.quiet).toBe(true);
    store.getState().dismissCreation("creating:k1");
    expect(store.getState().creations).toEqual([]);
    expect(deleted).toEqual([]);
  });

  it("a kept row the host speaks of within the 30 seconds keeps waiting with no Dismiss", async () => {
    await sendFromHome(fakeApi().api);
    const { store } = await reload(fakeApi().api);
    onFakeClock(store, () => {
      act(() => vi.advanceTimersByTime(10_000));
      store.getState().applyEvent({ type: "workspace.creating", workspaceId: "ws_far", name: TASK, stage: "fork-requested", message: "starting", elapsedMs: 10 });
      act(() => vi.advanceTimersByTime(30_000));
    });
    expect(store.getState().creations[0]!.quiet).toBeUndefined();
  });

  it("a host that goes away clears the wait: a row heard of by nobody is not offered Dismiss while the window is not connected", async () => {
    await sendFromHome(fakeApi().api);
    const { store } = await reload(fakeApi().api);
    onFakeClock(store, () => {
      act(() => vi.advanceTimersByTime(10_000));
      store.getState().setConn("reconnecting");
      act(() => vi.advanceTimersByTime(30_000));
    });
    expect(store.getState().creations[0]!.quiet).toBeUndefined();
  });

  it("a row refused before the reload comes back refused, on the step it stopped on, and Dismiss is quiet when the host has forgotten it", async () => {
    await sendFromHome(fakeApi().api);
    useStore.getState().applyEvent({ type: "workspace.creating", workspaceId: "ws_far", name: TASK, stage: "fork-requested", message: "starting it on hetzner", elapsedMs: 10 });
    useStore.getState().applyEvent({ type: "workspace.creating", workspaceId: "ws_far", name: TASK, stage: "failed", message: "Snapshot not found", elapsedMs: 20 });
    const api = fakeApi().api;
    api.deleteWorkspace = async id => { throw new RequestError(`no workspace: ${id}`); };
    const { store, queue } = await reload(api);
    const { useNotices } = await import("../src/notices/store.js");
    const { WorkspaceCreation } = await import("../src/shell/WorkspaceCreation.js");
    const { CREATE_ASKED, CREATE_STEP_WORDS } = await import("../src/shell/creationLog.js");
    const row = store.getState().creations[0]!;
    expect(row).toMatchObject({ workspaceId: "ws_far", failed: { title: `Could not start ${TASK}`, detail: "Snapshot not found" } });
    render(<WorkspaceCreation creation={row} />);
    const page = document.querySelector("[data-k=setting-up]")!.textContent!;
    expect(page).toContain(CREATE_STEP_WORDS["fork-requested"]);
    expect(page).toContain("Snapshot not found");
    expect(page).not.toContain(CREATE_ASKED);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(store.getState().creations).toEqual([]);
    expect(queue(row.key)).toEqual([]);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(useNotices.getState().notices).toEqual([]);
  });

  it("a workspace of the same name made after the ask is the row's own, so the row stays kept between the created frame and the reply", async () => {
    await sendFromHome(fakeApi().api);
    const row = useStore.getState().creations[0]!;
    useStore.setState(s => ({ workspaces: [...s.workspaces, view("ws_new", TASK, new Date(row.askedAt + 1_000).toISOString())] }));
    const kept = JSON.parse(window.localStorage.getItem(KEPT_CREATIONS_KEY) ?? "{}") as Record<string, Array<{ key: string }>>;
    expect(kept[""]?.map(r => r.key)).toEqual([row.key]);
  });

  it("a kept record that is not one, or not JSON, loads as no rows", async () => {
    window.localStorage.setItem(KEPT_CREATIONS_KEY, JSON.stringify({ "": [{ key: 1 }, null, { key: "creating:x", name: TASK }] }));
    expect((await reload(fakeApi().api)).store.getState().creations).toEqual([]);
    window.localStorage.setItem(KEPT_CREATIONS_KEY, "{not json");
    expect((await reload(fakeApi().api)).store.getState().creations).toEqual([]);
  });

  it("an older workspace holding the name is never taken for the one asked for", async () => {
    const older = view("ws_old", TASK, "2026-01-01T00:00:00Z");
    useStore.setState({ workspaces: [older] });
    await sendFromHome(fakeApi([older]).api);
    const { queue } = await reload(fakeApi([older]).api);
    expect(queue("ws_old")).toEqual([]);
  });

  it("without a reload the message is queued once, ahead of a message typed on the setup page, whichever of the frame and the reply lands first", async () => {
    const { api, finish } = fakeApi();
    await sendFromHome(api);
    const key = useStore.getState().creations[0]!.key;
    useComposerDraftStore.getState().enqueue(key, "and run it twice");
    useStore.getState().applyEvent({ type: "workspace.created", workspace: view("ws_new", TASK) });
    finish(view("ws_new", TASK));
    await waitFor(() => expect(useStore.getState().selectedId).toBe("ws_new"));
    expect(useComposerDraftStore.getState().queues["ws_new"]?.map(r => r.prompt)).toEqual([TASK, "and run it twice"]);
    expect(useComposerDraftStore.getState().queues[key]).toBeUndefined();
    expect(useComposerOptionsStore.getState().byWorkspaceId[HOME]).toBeUndefined();
  });
});
