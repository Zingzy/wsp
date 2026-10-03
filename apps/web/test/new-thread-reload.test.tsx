// SPDX-License-Identifier: AGPL-3.0-only
// The first message of a thread started from New thread is the window's to keep
// until the workspace is up: a reload, a closed window or a crash while the copy
// is made must not lose it, and it lands on the workspace's queue once, ahead of
// anything typed on the setup page. A kept row learns from the host's word on
// connect whether its create still runs, a send to several models keeps its
// starts the same way, and one page at a time owns a kept row. A reload is the
// store's modules evaluated again over the same local storage.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PREFERENCES, type HarnessCatalog, type ProjectView, type WorkspaceCreatingEvent, type WorkspaceView } from "@wsp/protocol";
import { RequestError, type Api, type ProtocolEvent, type StartSessionOptions } from "../src/protocol/client.js";
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

/** A host whose create answers only when `finish` is called, whose list holds what `listed` holds, and whose
 * subscribe hands this window the last word of every create in `creating`, ahead of the list's reply. */
function fakeApi(listed: WorkspaceView[] = [], creating: WorkspaceCreatingEvent[] = []) {
  let finish: (w: WorkspaceView) => void = () => {};
  let hear: (e: ProtocolEvent) => void = () => {};
  const asked: string[] = [];
  const started: StartSessionOptions[] = [];
  const api: Api = {
    preferences: async () => DEFAULT_PREFERENCES,
    listHarnesses: async () => [CLAUDE],
    portReach: async (_id, port) => ({ url: `https://m1-${port}.preview.example/`, expiresAt: Date.now() + 3_600_000 }),
    daemon: noDaemonApi,
    sessionHistory: async () => [],
    listSnapshots: async () => ({ name: "default", head: null, versions: [] }),
    snapshotStorage: async () => null,
    rollbackSnapshot: async () => ({ lineage: { name: "default", head: null, versions: [] }, existingWorkspaces: "untouched" }),
    listWorkspaces: async () => {
      for (const e of creating) hear(e);
      return listed;
    },
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
    subscribe: fn => {
      hear = fn;
      return () => {};
    },
    getGolden: async () => undefined,
    projectsList: async () => [PROJECT],
    startSession: async o => {
      started.push(o);
      return { id: `s_${started.length}`, workspaceId: o.workspaceId, harness: o.harness ?? "claude", status: "running" };
    },
  };
  return { api, asked, started, creating, finish: (w: WorkspaceView) => finish(w), hear: (e: ProtocolEvent) => hear(e) };
}

/** A create's stage as the host says it. */
const stage = (workspaceId: string, name: string, at: WorkspaceCreatingEvent["stage"], message = "copying /root to /root-copy", elapsedMs = 10): WorkspaceCreatingEvent => ({ type: "workspace.creating", workspaceId, name, stage: at, message, elapsedMs });

/** The lock manager every page of one origin shares: a lock stands until the callback's promise settles. A late
 * one answers nothing until `answer` is called. */
function installLocks(late = false): { held: Set<string>; answer: () => void; remove: () => void } {
  const held = new Set<string>();
  const waiting: Array<() => void> = [];
  const locks = {
    request: async (name: string, _opts: unknown, take: (lock: { name: string } | null) => unknown) => {
      if (late) await new Promise<void>(resolve => waiting.push(resolve));
      if (held.has(name)) return take(null);
      held.add(name);
      try {
        return await take({ name });
      } finally {
        held.delete(name);
      }
    },
  };
  Object.defineProperty(window.navigator, "locks", { value: locks, configurable: true });
  return { held, answer: () => waiting.splice(0).forEach(go => go()), remove: () => void delete (window.navigator as { locks?: unknown }).locks };
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
    await sendFromHome(fakeApi().api);
    const { store, queue } = await reload(fakeApi([], [stage("ws_new", TASK, "fork-requested")]).api);
    expect(store.getState().creations).toEqual([expect.objectContaining({ name: TASK, project: PROJECT.id, asked: TASK, workspaceId: "ws_new", failed: null })]);
    const { WorkspaceCreation } = await import("../src/shell/WorkspaceCreation.js");
    render(<WorkspaceCreation creation={store.getState().creations[0]!} />);
    expect(document.querySelector("[data-k=creation-asked]")?.textContent).toContain(TASK);
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

  it("a create refused while no page was open comes back refused with Retry, from the host's last word of it", async () => {
    await sendFromHome(fakeApi().api);
    const { store } = await reload(fakeApi([], [stage("ws_far", TASK, "fork-requested"), stage("ws_far", TASK, "failed", "the disk is full", 20)]).api);
    expect(store.getState().creations).toEqual([expect.objectContaining({ asked: TASK, project: PROJECT.id, workspaceId: "ws_far", failed: { title: `Could not start ${TASK}`, detail: "the disk is full" } })]);
    const { WorkspaceCreation } = await import("../src/shell/WorkspaceCreation.js");
    render(<WorkspaceCreation creation={store.getState().creations[0]!} />);
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("a kept row the host neither lists nor speaks of reads as refused, its message on screen, and Retry asks for it again", async () => {
    await sendFromHome(fakeApi().api);
    const again = fakeApi();
    const { store, queue } = await reload(again.api);
    const { WorkspaceCreation } = await import("../src/shell/WorkspaceCreation.js");
    const { CREATE_UNHEARD } = await import("../src/shell/creationLog.js");
    expect(store.getState().creations).toEqual([expect.objectContaining({ asked: TASK, failed: { title: `Could not start ${TASK}`, detail: CREATE_UNHEARD } })]);
    render(<WorkspaceCreation creation={store.getState().creations[0]!} />);
    expect(document.querySelector("[data-k=creation-asked]")?.textContent).toContain(TASK);
    expect(screen.getByText(CREATE_UNHEARD)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(again.asked).toEqual([TASK]);
    again.finish(view("ws_new", TASK));
    await waitFor(() => expect(queue("ws_new")).toEqual([TASK]));
  });

  it("a kept row the host is still making keeps waiting, and the host's last word repeated adds no second line", async () => {
    await sendFromHome(fakeApi().api);
    const host = fakeApi([], [stage("ws_new", TASK, "fork-requested")]);
    const { store } = await reload(host.api);
    host.hear(stage("ws_new", TASK, "fork-requested"));
    expect(store.getState().creations).toEqual([expect.objectContaining({ workspaceId: "ws_new", failed: null })]);
    expect(store.getState().creations[0]!.lines).toHaveLength(1);
  });

  it("a row the host spoke of reads as refused once a reconnect hears nothing of it, which is a host that restarted mid-create", async () => {
    await sendFromHome(fakeApi().api);
    const host = fakeApi([], [stage("ws_new", TASK, "fork-requested")]);
    const { store } = await reload(host.api);
    expect(store.getState().creations[0]!.failed).toBeNull();
    store.getState().setConn("reconnecting");
    host.creating.length = 0;
    store.getState().setConn("live");
    await waitFor(() => expect(store.getState().creations[0]!.failed).not.toBeNull());
  });

  it("a row refused before the reload comes back refused, on the step it stopped on, and Dismiss is quiet when the host no longer holds it", async () => {
    await sendFromHome(fakeApi().api);
    useStore.getState().applyEvent(stage("ws_far", TASK, "fork-requested", "starting it on hetzner"));
    useStore.getState().applyEvent(stage("ws_far", TASK, "failed", "Snapshot not found", 20));
    const api = fakeApi().api;
    api.deleteWorkspace = async id => {
      throw new RequestError(`no such workspace: ${id}`, "not-found");
    };
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

  it("a delete of a refused row the host refuses for any other reason says so", async () => {
    await sendFromHome(fakeApi().api);
    useStore.getState().applyEvent(stage("ws_far", TASK, "failed", "Snapshot not found", 20));
    const api = fakeApi().api;
    api.deleteWorkspace = async () => {
      throw new RequestError("the provider would not stop it");
    };
    const { store } = await reload(api);
    const { useNotices } = await import("../src/notices/store.js");
    store.getState().dismissCreation(store.getState().creations[0]!.key);
    await waitFor(() => expect(useNotices.getState().notices.map(n => n.text).join()).toContain("the provider would not stop it"));
  });

  it("a send to several models made before a reload still opens each thread on its own model, under one attempt", async () => {
    useMultiPickStore.setState({ byKey: { [HOME]: [{ harness: "claude", model: "claude-opus-5", label: "Opus 5" }, { harness: "claude", model: "claude-sonnet-5", label: "Sonnet 5" }] } });
    useStore.getState().bind(fakeApi().api);
    render(<ProjectHome projectId={PROJECT.id} />);
    await waitFor(() => expect(document.querySelector('[data-composer-picker="model"][data-value]')).not.toBeNull());
    await typeInto(composerEditor(), TASK);
    await press(composerEditor(), "Enter");
    await waitFor(() => expect(useStore.getState().creations).toHaveLength(2));
    const host = fakeApi([], [stage("ws_a", `${TASK} (Opus 5)`, "fork-requested"), stage("ws_b", `${TASK} (Sonnet 5)`, "fork-requested")]);
    const { store } = await reload(host.api);
    store.getState().applyEvent({ type: "workspace.created", workspace: view("ws_a", `${TASK} (Opus 5)`) });
    store.getState().applyEvent({ type: "workspace.created", workspace: view("ws_b", `${TASK} (Sonnet 5)`) });
    await waitFor(() => expect(host.started).toHaveLength(2));
    expect(Object.fromEntries(host.started.map(s => [s.workspaceId, s.model]))).toEqual({ ws_a: "claude-opus-5", ws_b: "claude-sonnet-5" });
    expect(host.started.every(s => s.prompt === TASK && s.harness === "claude")).toBe(true);
    expect(new Set(host.started.map(s => s.attempt)).size).toBe(1);
    expect(host.started[0]!.attempt).toEqual(expect.any(String));
    store.getState().applyEvent({ type: "workspace.created", workspace: view("ws_a", `${TASK} (Opus 5)`) });
    expect(host.started, "once").toHaveLength(2);
  });

  it("a second tab loaded while the copy is made leaves the row to the tab that made it, which queues the message once", async () => {
    const locks = installLocks();
    try {
      const first = fakeApi();
      await sendFromHome(first.api);
      const other = await reload(fakeApi([], [stage("ws_new", TASK, "fork-requested")]).api);
      await waitFor(() => expect(other.store.getState().creations.filter(c => c.queued === true)).toEqual([]));
      // What the second tab writes keeps the first tab's row, which still holds the only copy of the message.
      other.store.setState({ workspaces: [view("ws_else", "else")] });
      const kept = JSON.parse(window.localStorage.getItem(KEPT_CREATIONS_KEY) ?? "{}") as Record<string, Array<{ asked: string }>>;
      expect(kept[""]?.map(r => r.asked)).toEqual([TASK]);
      for (const store of [useStore, other.store]) store.getState().applyEvent({ type: "workspace.created", workspace: view("ws_new", TASK) });
      first.finish(view("ws_new", TASK));
      await waitFor(() => expect(useComposerDraftStore.getState().queues["ws_new"]?.map(r => r.prompt)).toEqual([TASK]));
      expect(other.queue("ws_new")).toEqual([]);
      expect(JSON.parse(window.localStorage.getItem(KEPT_CREATIONS_KEY) ?? "{}")).toEqual({});
      expect(locks.held.size).toBe(0);
    } finally {
      locks.remove();
    }
  });

  it("a kept row whose workspace is there before its lock answers waits for the lock, is handed over once, and is not kept for the next load", async () => {
    await sendFromHome(fakeApi().api);
    const locks = installLocks(true);
    try {
      cleanup();
      vi.resetModules();
      const { useStore: store } = await import("../src/protocol/store.js");
      const { useComposerDraftStore: drafts } = await import("../src/components/chat/composerDraftStore.js");
      const queue = () => drafts.getState().queues["ws_new"]?.map(r => r.prompt) ?? [];
      store.setState({ projects: [PROJECT] });
      store.getState().bind(fakeApi([view("ws_new", TASK)]).api);
      reloaded = store;
      store.getState().applyEvent({ type: "workspace.created", workspace: view("ws_new", TASK) });
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(queue()).toEqual([]);
      locks.answer();
      await waitFor(() => expect(queue()).toEqual([TASK]));
      expect(JSON.parse(window.localStorage.getItem(KEPT_CREATIONS_KEY) ?? "{}")).toEqual({});
      store.getState().setConn("closed");
      const next = await reload(fakeApi([view("ws_new", TASK)]).api);
      expect(next.queue("ws_new"), "once").toEqual([TASK]);
    } finally {
      locks.remove();
    }
  });

  it("a lock request the browser refuses leaves the kept row this page's, so the window never waits on it", async () => {
    await sendFromHome(fakeApi().api);
    Object.defineProperty(window.navigator, "locks", { value: { request: () => Promise.reject(new DOMException("not fully active", "InvalidStateError")) }, configurable: true });
    try {
      const next = await reload(fakeApi([view("ws_new", TASK)]).api);
      await waitFor(() => expect(next.queue("ws_new")).toEqual([TASK]));
    } finally {
      delete (window.navigator as { locks?: unknown }).locks;
    }
  });

  it("a refused create the host holds that no kept row here names draws nothing, while one still being made draws its row", async () => {
    const { store } = await reload(fakeApi([], [stage("ws_cli", "from the command line", "failed", "the disk is full"), stage("ws_else", "made elsewhere", "fork-requested")]).api);
    expect(store.getState().creations.map(c => c.name)).toEqual(["made elsewhere"]);
  });

  it("the task typed again after a reload, while the kept row's create is gone, lands once on the workspace it makes", async () => {
    await sendFromHome(fakeApi().api);
    const host = fakeApi();
    const { store, queue } = await reload(host.api);
    void store.getState().createWorkspace(PROJECT.id, TASK, undefined, { prompt: TASK, queuedFrom: HOME });
    store.getState().applyEvent({ type: "workspace.created", workspace: view("ws_new", TASK) });
    host.finish(view("ws_new", TASK));
    await waitFor(() => expect(queue("ws_new")).toEqual([TASK]));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(queue("ws_new"), "once").toEqual([TASK]);
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
