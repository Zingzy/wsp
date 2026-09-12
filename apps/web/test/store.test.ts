// SPDX-License-Identifier: AGPL-3.0-only
// The store's session folding: rows come from the sessions.list op, the
// session.* events decide when to refetch and what to patch in between.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLOUD_SETUP_WORDS, DEFAULT_THEME, type GoldenManifest, type InitJob, type PlaceView, type SessionView, type WorkspaceView } from "@wsp/protocol";
import { DisconnectedError, RequestError, type Api, type ProtocolEvent } from "../src/protocol/client.js";
import { LAST_WORKSPACE_KEY } from "../src/protocol/lastWorkspace.js";
import { useStore } from "../src/protocol/store.js";
import { caps } from "./caps.js";
import { noDaemonApi } from "./fake-daemon-api.js";

const view = (id: string): WorkspaceView => ({
  id,
  name: id,
  machineId: `m_${id}`,
  phase: "running",
  golden: "snap_g",
  createdAt: "2026-09-01T00:00:00Z",
});

const GOLDEN: GoldenManifest = {
  head: 1,
  versions: [{ version: 1, snapshotId: "snap_g", baseTemplate: "default", setupSha: "s", createdAt: "c", smoke: { cmd: "true", exitCode: 0 } }],
};

const CAPS = caps();

function fakeApi(workspaces: WorkspaceView[], sessions: SessionView[]) {
  const listeners = new Set<(e: ProtocolEvent) => void>();
  const listCalls: (string | undefined)[] = [];
  const pulls = { workspaces: 0, statuses: 0 };
  const api: Api = {
    listWorkspaces: async () => {
      pulls.workspaces++;
      return workspaces;
    },
    getWorkspace: async id => workspaces.find(w => w.id === id)!,
    createWorkspace: async () => workspaces[0]!,
    createFromGoldenHead: async () => workspaces[0]!,
    watchStatuses: async () => {
      pulls.statuses++;
      return workspaces.map(w => ({ ...w, machineState: "running" as const, reach: { state: "reachable" as const }, size: { cpu: 2, memMb: 4096 }, rateUsdPerHour: 0 }));
    },
    nap: async id => workspaces.find(w => w.id === id)!,
    wake: async id => workspaces.find(w => w.id === id)!,
    upgrade: async id => workspaces.find(w => w.id === id)!,
    capabilities: async () => CAPS,
    startSession: async o => ({ id: "s_new", workspaceId: o.workspaceId, harness: "claude", status: "running" }),
    portReach: async (_id, port) => ({ url: `https://m1-${port}.preview.example/?pt_token=e`, expiresAt: Date.now() + 3_600_000 }),
    daemon: noDaemonApi,
    sessionHistory: async () => [],
    listSnapshots: async () => ({ name: "default", head: null, versions: [] }),
    snapshotStorage: async () => null,
    rollbackSnapshot: async () => ({ lineage: { name: "default", head: null, versions: [] }, existingWorkspaces: "untouched" }),
    listSessions: async id => {
      listCalls.push(id);
      return id === undefined ? sessions : sessions.filter(s => s.workspaceId === id);
    },
    // Sealed, since these are the forks of its head: a computer with no image forks nothing at all.
    getGolden: async () => GOLDEN,
    subscribe: fn => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
  const emit = (e: ProtocolEvent) => {
    for (const fn of [...listeners]) fn(e);
  };
  return { api, emit, listCalls, pulls };
}

const flush = () => new Promise(r => setTimeout(r, 0));

beforeEach(() => {
  useStore.setState({ api: null, conn: "connecting", capabilities: null, workspaces: [], statuses: {}, costs: {}, spending: {}, toast: null, toastAction: null, setupOpen: false, selectedId: null, creations: [], sessions: {}, ready: false, gaps: 0 });
});

// The address is a global the store reads: a #w/<id> left behind would pick the workspace for every test after it.
afterEach(() => {
  window.location.hash = "";
  window.localStorage.removeItem(LAST_WORKSPACE_KEY);
  delete (window as unknown as { __WSP__?: unknown }).__WSP__;
});

describe("store selection", () => {
  it("select takes a thread of the workspace; selecting without one shows the latest thread again", () => {
    useStore.getState().select("ws_a", "thr_1");
    expect(useStore.getState()).toMatchObject({ selectedId: "ws_a", selectedThreadId: "thr_1" });
    useStore.getState().select("ws_a");
    expect(useStore.getState()).toMatchObject({ selectedId: "ws_a", selectedThreadId: null });
    useStore.getState().select("ws_b", "thr_2");
    useStore.getState().select(null);
    expect(useStore.getState()).toMatchObject({ selectedId: null, selectedThreadId: null });
  });
});

describe("the workspace the address opens on", () => {
  const hash = (h: string) => {
    window.location.hash = h;
  };
  const refreshed = async (workspaces: WorkspaceView[]) => {
    const { api } = fakeApi(workspaces, []);
    useStore.setState({ api });
    await useStore.getState().refresh();
    return useStore.getState().selectedId;
  };

  it("selects the workspace wsp init's address names, not the first row", async () => {
    hash("#w/ws_b");
    expect(await refreshed([view("ws_a"), view("ws_b")])).toBe("ws_b");
  });

  it("falls back to the first row when the address names no workspace, or one that is gone", async () => {
    hash("");
    expect(await refreshed([view("ws_a"), view("ws_b")])).toBe("ws_a");
    useStore.setState({ selectedId: null });
    hash("#gallery");
    expect(await refreshed([view("ws_a"), view("ws_b")])).toBe("ws_a");
    useStore.setState({ selectedId: null });
    hash("#w/ws_gone");
    expect(await refreshed([view("ws_a"), view("ws_b")])).toBe("ws_a");
  });

  it("never moves a selection the person already made", async () => {
    hash("#w/ws_b");
    useStore.setState({ selectedId: "ws_a" });
    expect(await refreshed([view("ws_a"), view("ws_b")])).toBe("ws_a");
  });

  // The rows the sidebar draws: two running workspaces, the later one on top since its creation is the latest activity.
  const rows = () => [view("ws_a"), { ...view("ws_b"), createdAt: "2026-09-02T00:00:00Z" }];

  it("with no address it opens on the first row in sidebar order, not the first of the runtime's list", async () => {
    hash("");
    expect(await refreshed(rows())).toBe("ws_b");
  });

  it("opens on the workspace the person had open last, remembered under the host's state file; one the list lost falls through to the first row", async () => {
    hash("");
    window.localStorage.setItem(LAST_WORKSPACE_KEY, JSON.stringify({ "/Users/dev/.wsp/state.json": "ws_a", "": "ws_a" }));
    expect(await refreshed(rows())).toBe("ws_a");
    useStore.setState({ selectedId: null });
    window.localStorage.setItem(LAST_WORKSPACE_KEY, JSON.stringify({ "": "ws_gone" }));
    expect(await refreshed(rows())).toBe("ws_b");
    useStore.setState({ selectedId: null });
    window.localStorage.setItem(LAST_WORKSPACE_KEY, "not json");
    expect(await refreshed(rows())).toBe("ws_b");
  });

  it("a memory written under another state file is not this host's", async () => {
    hash("");
    window.localStorage.setItem(LAST_WORKSPACE_KEY, JSON.stringify({ "/Users/dev/other/state.json": "ws_a" }));
    expect(await refreshed(rows())).toBe("ws_b");
  });

  it("remembers each workspace the person selects, under the state file the boot object names, and never a creation row", async () => {
    hash("");
    (window as unknown as { __WSP__?: unknown }).__WSP__ = { wsPort: 1, token: "t", statePath: "/Users/dev/.wsp/state.json" };
    await refreshed(rows());
    expect(JSON.parse(window.localStorage.getItem(LAST_WORKSPACE_KEY)!)).toEqual({ "/Users/dev/.wsp/state.json": "ws_b" });
    useStore.getState().select("ws_a", "thr_1");
    expect(JSON.parse(window.localStorage.getItem(LAST_WORKSPACE_KEY)!)).toEqual({ "/Users/dev/.wsp/state.json": "ws_a" });
    useStore.setState({ creations: [{ key: "c1", name: "new", askedAt: Date.now(), workspaceId: null, lines: [], failed: null }], selectedId: "c1" });
    expect(JSON.parse(window.localStorage.getItem(LAST_WORKSPACE_KEY)!)).toEqual({ "/Users/dev/.wsp/state.json": "ws_a" });
    useStore.setState({ selectedId: null });
    expect(await refreshed(rows())).toBe("ws_a");
  });

  it("a thread link opens that thread when the list carries it; a thread the list does not carry falls back to the workspace with a word", async () => {
    const thread: SessionView = { id: "s1", workspaceId: "ws_b", harness: "claude", status: "completed", threadId: "thr_1", prompt: "hello" };
    hash("#w/ws_b/t/thr_1");
    const { api } = fakeApi([view("ws_a"), view("ws_b")], [thread]);
    useStore.setState({ api });
    await useStore.getState().refresh();
    expect([useStore.getState().selectedId, useStore.getState().selectedThreadId, useStore.getState().toast]).toEqual(["ws_b", "thr_1", null]);

    useStore.setState({ selectedId: null, selectedThreadId: null });
    hash("#w/ws_b/t/thr_nope");
    await useStore.getState().refresh();
    expect([useStore.getState().selectedId, useStore.getState().selectedThreadId]).toEqual(["ws_b", null]);
    expect(useStore.getState().toast).toBe("No thread thr_nope in this workspace; opened the workspace instead");
  });
});

describe("store creations", () => {
  const HERE_PLACE: PlaceView = { id: "here", kind: "computer", name: "studio.local", default: false, present: true };
  const HETZNER_PLACE: PlaceView = { id: "p_1", kind: "computer", name: "hetzner", default: true, docker: true, present: true };

  const stage = (over: Partial<Extract<ProtocolEvent, { type: "workspace.creating" }>> = {}): ProtocolEvent => ({
    type: "workspace.creating",
    workspaceId: "ws_new",
    name: "beta",
    stage: "fork-requested",
    message: "Fork of the golden image requested.",
    elapsedMs: 0,
    ...over,
  });

  it("this computer is created once and selected, and a second call selects the row it already is", async () => {
    const { api } = fakeApi([view("ws_a")], []);
    const local: WorkspaceView = { ...view("ws_mac"), kind: "local", golden: "" };
    api.createLocalWorkspace = vi.fn(async () => local);
    useStore.getState().bind(api);
    await flush();

    expect(await useStore.getState().createLocalWorkspace()).toBe("ws_mac");
    expect(useStore.getState().selectedId).toBe("ws_mac");
    expect(useStore.getState().workspaces.map(w => w.id)).toEqual(["ws_a", "ws_mac"]);
    // This computer forks nothing and boots nothing: there is no creation row to watch and no stage to log.
    expect(useStore.getState().creations).toEqual([]);
    // The name is this computer's own, which the host is the one to know.
    expect(api.createLocalWorkspace).toHaveBeenCalledWith();

    useStore.getState().select("ws_a");
    expect(await useStore.getState().createLocalWorkspace()).toBe("ws_mac");
    expect(useStore.getState().selectedId).toBe("ws_mac");
    // One local workspace per host, so the second call asked the host nothing.
    expect(api.createLocalWorkspace).toHaveBeenCalledTimes(1);
  });

  it("a host that refuses this computer says so in its own sentence, with no creation row to carry it", async () => {
    const { api } = fakeApi([view("ws_a")], []);
    api.createLocalWorkspace = async () => {
      throw new Error("this computer is already the workspace mac; one workspace stands on one machine");
    };
    useStore.getState().bind(api);
    await flush();
    expect(await useStore.getState().createLocalWorkspace()).toBeNull();
    expect(useStore.getState().toast).toBe("this computer is already the workspace mac; one workspace stands on one machine");
    expect(useStore.getState().creations).toEqual([]);
  });

  it("a client with no road to this computer offers none: nothing is asked and nothing is selected", async () => {
    const { api } = fakeApi([view("ws_a")], []);
    delete api.createLocalWorkspace;
    useStore.getState().bind(api);
    await flush();
    expect(await useStore.getState().createLocalWorkspace()).toBeNull();
    expect(useStore.getState().workspaces.map(w => w.id)).toEqual(["ws_a"]);
  });

  it("createWorkspace adds a selected row, adopts the runtime's id from the first stage by name, logs each stage, and swaps to the workspace when created", async () => {
    const workspaces = [view("ws_a")];
    const { api, emit } = fakeApi(workspaces, []);
    let finish!: (w: WorkspaceView) => void;
    api.createFromGoldenHead = () => new Promise<WorkspaceView>(resolve => { finish = resolve; });
    useStore.getState().bind(api);
    await flush();
    const done = useStore.getState().createWorkspace("beta");
    const [creation] = useStore.getState().creations;
    expect(creation).toMatchObject({ name: "beta", workspaceId: null, lines: [], failed: null });
    expect(useStore.getState().selectedId).toBe(creation!.key);

    emit(stage());
    emit(stage({ stage: "machine-booting", message: "Machine m1 is booting.", elapsedMs: 1_500, notice: "Stopped the builder kept from golden v1 to make room at the machine cap." }));
    const logged = useStore.getState().creations[0]!;
    expect(logged.workspaceId).toBe("ws_new");
    expect(logged.lines.map(l => [l.stage, l.message, l.elapsedMs, l.notice])).toEqual([
      ["fork-requested", "Fork of the golden image requested.", 0, undefined],
      ["machine-booting", "Machine m1 is booting.", 1_500, "Stopped the builder kept from golden v1 to make room at the machine cap."],
    ]);
    expect(logged.lines.every(l => !Number.isNaN(Date.parse(l.at)))).toBe(true);

    emit({ type: "workspace.created", workspace: view("ws_new") });
    expect(useStore.getState().creations).toEqual([]);
    expect(useStore.getState().selectedId).toBe("ws_new");
    expect(useStore.getState().workspaces.map(w => w.id)).toEqual(["ws_a", "ws_new"]);
    finish(view("ws_new"));
    expect(await done).toBe("ws_new");
    expect(useStore.getState().creations).toEqual([]);
  });

  it("the image being built where the create is going reads as the first lines of that create's log", async () => {
    const { api, emit } = fakeApi([view("ws_a")], []);
    api.createFromGoldenHead = () => new Promise<WorkspaceView>(() => {});
    useStore.getState().bind(api);
    await flush();
    useStore.setState({ places: [HERE_PLACE, HETZNER_PLACE] });
    void useStore.getState().createWorkspace("beta", undefined, undefined, "p_1");
    expect(useStore.getState().creations[0]!.where).toBe("p_1");

    // The build names the place by the word its backend table keys it with, which is the same row.
    emit({ type: "golden.stage", name: "default", stage: "installing-harness", place: "hetzner" });
    emit({ type: "golden.stage", name: "default", stage: "snapshotting", detail: "about 4.2 GB", place: "hetzner" });
    // The image's own build, at no place, belongs to the init screens and never to a create's log.
    emit({ type: "golden.stage", name: "default", stage: "installing-tools" });
    // A build at a computer this create is not going to is another road's.
    emit({ type: "golden.stage", name: "default", stage: "installing-tools", place: "old-macbook" });
    emit(stage({ stage: "ready", message: "Ready.", elapsedMs: 210_000 }));

    expect(useStore.getState().creations[0]!.lines.map(l => [l.stage, l.message, l.notice])).toEqual([
      ["image", "building your image on hetzner · installing agents", undefined],
      ["image", "building your image on hetzner · taking the snapshot", "about 4.2 GB"],
      ["ready", "Ready.", undefined],
    ]);
  });

  it("stamps an image line's elapsed from the moment the create was asked, so the log's right column grows", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-09-12T09:27:00.000Z"));
      useStore.setState({ places: [HERE_PLACE, HETZNER_PLACE], creations: [], api: null });
      // The row is made by hand: what is measured is the clock, not the road that asked.
      useStore.setState({ creations: [{ key: "c1", name: "spoo-fix", askedAt: Date.now(), where: "p_1", workspaceId: null, lines: [], failed: null }] });
      vi.advanceTimersByTime(4_100);
      useStore.getState().applyEvent({ type: "golden.stage", name: "default", stage: "installing-harness", place: "hetzner" });
      vi.advanceTimersByTime(108_000);
      useStore.getState().applyEvent({ type: "golden.stage", name: "default", stage: "snapshotting", place: "hetzner" });
      expect(useStore.getState().creations[0]!.lines.map(l => l.elapsedMs)).toEqual([4_100, 112_100]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a reply that lands before the created event finishes the row from the reply, and carries its notice as the toast", async () => {
    const { api, emit } = fakeApi([view("ws_a")], []);
    api.createFromGoldenHead = async () => ({ ...view("ws_new"), notice: "Stopped the builder kept from golden v1 to make room at the machine cap." });
    useStore.getState().bind(api);
    await flush();
    expect(await useStore.getState().createWorkspace("beta")).toBe("ws_new");
    expect(useStore.getState().creations).toEqual([]);
    expect(useStore.getState().selectedId).toBe("ws_new");
    expect(useStore.getState().workspaces.map(w => w.id)).toEqual(["ws_a", "ws_new"]);
    expect(useStore.getState().toast).toBe("Stopped the builder kept from golden v1 to make room at the machine cap.");
    emit({ type: "workspace.created", workspace: view("ws_new") });
    expect(useStore.getState().workspaces.map(w => w.id)).toEqual(["ws_a", "ws_new"]);
  });

  it("a refusal keeps the row with the failing line and the explanation; retry starts the same name over under the same key; dismiss drops it", async () => {
    const { api, emit } = fakeApi([view("ws_a")], []);
    const calls: string[] = [];
    api.createFromGoldenHead = async name => {
      calls.push(name);
      if (calls.length === 1) {
        emit(stage());
        emit(stage({ stage: "failed", message: "Sandbox limit reached (2)", elapsedMs: 900 }));
        throw new RequestError("Sandbox limit reached (2)", "concurrency");
      }
      return view("ws_new");
    };
    useStore.getState().bind(api);
    await flush();
    expect(await useStore.getState().createWorkspace("beta")).toBeNull();
    const failed = useStore.getState().creations[0]!;
    expect(failed.failed?.title).toBe("The provider refused: no more workspaces can run there now");
    expect(failed.lines.map(l => l.stage)).toEqual(["fork-requested", "failed"]);
    expect(useStore.getState().selectedId).toBe(failed.key);

    await useStore.getState().retryCreation(failed.key);
    expect(calls).toEqual(["beta", "beta"]);
    expect(useStore.getState().creations).toEqual([]);
    expect(useStore.getState().selectedId).toBe("ws_new");

    api.createFromGoldenHead = async () => { throw new Error("no golden image yet"); };
    await useStore.getState().createWorkspace("gamma");
    const again = useStore.getState().creations[0]!;
    expect(again.failed).toEqual({ title: "Could not create the workspace", detail: "no golden image yet" });
    // No failed stage arrived, so the refusal is the failing line.
    expect(again.lines.map(l => [l.stage, l.message])).toEqual([["failed", "no golden image yet"]]);
    useStore.getState().dismissCreation(again.key);
    expect(useStore.getState().creations).toEqual([]);
    expect(useStore.getState().selectedId).toBe("ws_a");
  });

  it("createWorkspace with a snapshot forks that image instead of the golden's head, and a retry keeps it", async () => {
    const { api, emit } = fakeApi([view("ws_a")], []);
    const calls: [string, string | undefined][] = [];
    api.createFromGoldenHead = async () => {
      throw new Error("the head is not what was asked for");
    };
    api.createWorkspace = async (golden, name) => {
      calls.push([golden, name]);
      if (calls.length === 1) {
        emit(stage({ name: "proj-fork" }));
        emit(stage({ name: "proj-fork", stage: "failed", message: "Sandbox limit reached (2)", elapsedMs: 900 }));
        throw new RequestError("Sandbox limit reached (2)", "concurrency");
      }
      return view("ws_new");
    };
    useStore.getState().bind(api);
    await flush();
    expect(await useStore.getState().createWorkspace("proj-fork", "snap_project")).toBeNull();
    const failed = useStore.getState().creations[0]!;
    await useStore.getState().retryCreation(failed.key);
    expect(calls).toEqual([["snap_project", "proj-fork"], ["snap_project", "proj-fork"]]);
    expect(useStore.getState().selectedId).toBe("ws_new");
  });

  it("a create another client started shows up from its stage events and leaves on created without moving the selection", async () => {
    const { api, emit } = fakeApi([view("ws_a")], []);
    useStore.getState().bind(api);
    await flush();
    expect(useStore.getState().selectedId).toBe("ws_a");
    emit(stage({ workspaceId: "ws_far", name: "far" }));
    emit(stage({ workspaceId: "ws_far", name: "far", stage: "machine-booting", message: "Machine m9 is booting." }));
    expect(useStore.getState().creations).toEqual([expect.objectContaining({ key: "creating:ws_far", name: "far", workspaceId: "ws_far", failed: null })]);
    expect(useStore.getState().creations[0]!.lines).toHaveLength(2);
    emit(stage({ workspaceId: "ws_far", name: "far", stage: "failed", message: "boom" }));
    expect(useStore.getState().creations[0]!.failed).toEqual({ title: "Could not create the workspace", detail: "boom" });
    emit({ type: "workspace.created", workspace: view("ws_far") });
    expect(useStore.getState().creations).toEqual([]);
    expect(useStore.getState().selectedId).toBe("ws_a");
  });

  it("with no image sealed the fork is refused before a row exists: the toast says where the build stands and opens it, and nothing is asked of the runtime", async () => {
    const { api } = fakeApi([view("ws_a")], []);
    const asked: string[] = [];
    api.getGolden = async () => undefined;
    api.createFromGoldenHead = async name => {
      asked.push(name);
      return view("ws_new");
    };
    useStore.getState().bind(api);
    await flush();
    useStore.setState({
      initJob: { id: "init_1", road: "manual", phase: "building", keys: { solari: true }, step: 0, stoppable: true, screens: [], rows: [{ id: "stage/creating", kind: "stage", label: "Creating the machine", state: "done" }, { id: "stage/ready", kind: "stage", label: "Waiting for the machine", state: "running" }], progress: { done: 1, total: 2 }, log: [] },
    });
    expect(await useStore.getState().createWorkspace("beta")).toBeNull();
    expect(asked).toEqual([]);
    // No row: the sidebar never gains a workspace that only failed, so there is nothing to retry or dismiss.
    expect(useStore.getState().creations).toEqual([]);
    expect(useStore.getState().selectedId).toBe("ws_a");
    expect(useStore.getState().toast).toBe("the image is still building · 1 of 2");
    const action = useStore.getState().toastAction!;
    expect(action.for).toBe(useStore.getState().toast);
    expect(action.word).toBe(CLOUD_SETUP_WORDS.create.open);
    action.run();
    expect(useStore.getState().setupOpen).toBe(true);
    // With no build to point at, the same road says the setup instead and its word opens that.
    useStore.setState({ initJob: null, setupOpen: false });
    expect(await useStore.getState().createWorkspace("gamma")).toBeNull();
    expect(useStore.getState().toast).toBe(CLOUD_SETUP_WORDS.create.none);
    expect(useStore.getState().toastAction!.word).toBe(CLOUD_SETUP_WORDS.row);
    // A named snapshot carries its own image, so that fork is never held back by the golden's absence.
    api.createWorkspace = async () => view("ws_new");
    expect(await useStore.getState().createWorkspace("proj-fork", "snap_project")).toBe("ws_new");
    // The sentence the person reads is never the one that names a command to run.
    expect(JSON.stringify([useStore.getState().toast, CLOUD_SETUP_WORDS.create])).not.toMatch(/wspx|golden build/);
  });
});

describe("store sessions", () => {
  it("refresh loads every session once and groups rows by workspace", async () => {
    const rows: SessionView[] = [
      { id: "s1", workspaceId: "ws_a", harness: "claude", status: "completed", claudeSessionId: "c1" },
      { id: "s2", workspaceId: "ws_b", harness: "claude", status: "running", claudeSessionId: "c2" },
    ];
    const { api, listCalls } = fakeApi([view("ws_a"), view("ws_b")], rows);
    useStore.getState().bind(api);
    await flush();
    expect(listCalls).toEqual([undefined]);
    expect(useStore.getState().sessions).toEqual({ "ws_a": [rows[0]], "ws_b": [rows[1]] });
    expect(useStore.getState().capabilities).toEqual(CAPS);
  });

  it("session.start remembers the claude session id on the workspace and refetches that workspace's rows", async () => {
    const sessions: SessionView[] = [];
    const { api, emit, listCalls } = fakeApi([view("ws_a")], sessions);
    useStore.getState().bind(api);
    await flush();
    listCalls.length = 0;

    sessions.push({ id: "s1", workspaceId: "ws_a", harness: "claude", status: "running", claudeSessionId: "c1" });
    emit({ type: "session.start", workspaceId: "ws_a", sessionId: "c1", model: "claude-sonnet-4-5" });
    expect(useStore.getState().workspaces[0]!.claudeSessionId).toBe("c1");
    await flush();
    expect(listCalls).toEqual(["ws_a"]);
    expect(useStore.getState().sessions["ws_a"]).toEqual(sessions);
  });

  it("session.done keeps the row running with no round trip; session.end refetches it to the settled status", async () => {
    const sessions: SessionView[] = [
      { id: "s1", workspaceId: "ws_a", harness: "claude", status: "running", claudeSessionId: "c1" },
    ];
    const { api, emit, listCalls } = fakeApi([view("ws_a")], sessions);
    useStore.getState().bind(api);
    await flush();
    listCalls.length = 0;

    // The reply is in, but the row stays running until the process exits; a send that met it would be refused.
    emit({ type: "session.done", workspaceId: "ws_a", sessionId: "c1", result: { status: "completed" } });
    expect(useStore.getState().sessions["ws_a"]![0]!.status).toBe("running");
    expect(listCalls).toEqual([]);

    sessions[0]!.status = "completed";
    emit({ type: "session.end", workspaceId: "ws_a", sessionId: "c1", exitCode: 0, sawResult: true });
    await flush();
    expect(listCalls).toEqual(["ws_a"]);
    expect(useStore.getState().sessions["ws_a"]![0]!.status).toBe("completed");
  });

  it("renameThread names the session through the runtime and reloads that workspace's rows, so the row shows the new name", async () => {
    const sessions: SessionView[] = [{ id: "s1", workspaceId: "ws_a", harness: "claude", status: "completed", claudeSessionId: "c1", prompt: "fix the port list", threadId: "thr_1" }];
    const { api, listCalls } = fakeApi([view("ws_a")], sessions);
    const renames: [string, string][] = [];
    api.renameSession = async (sessionId, title) => {
      renames.push([sessionId, title]);
      sessions[0]!.harnessTitle = title;
      return { outcome: "renamed" };
    };
    useStore.getState().bind(api);
    await flush();
    listCalls.length = 0;

    expect(await useStore.getState().renameThread({ sessionId: "s1", workspaceId: "ws_a", harness: "claude", title: "the name he typed" })).toBe(true);
    expect(renames).toEqual([["s1", "the name he typed"]]);
    expect(listCalls).toEqual(["ws_a"]);
    expect(useStore.getState().sessions["ws_a"]![0]!.harnessTitle).toBe("the name he typed");
    expect(useStore.getState().toast).toBeNull();
  });

  it("wakes a napping machine before the name goes, as the command line's own rename does, and paints the row from the reply", async () => {
    const sessions: SessionView[] = [{ id: "s1", workspaceId: "ws_a", harness: "claude", status: "completed" }];
    const { api } = fakeApi([{ ...view("ws_a"), phase: "napping" }], sessions);
    const order: string[] = [];
    api.wake = async id => {
      order.push("wake");
      return { ...view(id), phase: "running" };
    };
    api.renameSession = async () => {
      order.push("rename");
      return { outcome: "renamed" };
    };
    useStore.getState().bind(api);
    await flush();

    expect(await useStore.getState().renameThread({ sessionId: "s1", workspaceId: "ws_a", harness: "claude", title: "the name" })).toBe(true);
    expect(order).toEqual(["wake", "rename"]);
    expect(useStore.getState().workspaces[0]!.phase).toBe("running");
    expect(useStore.getState().toast).toBeNull();

    // A machine already up is not woken again.
    order.length = 0;
    await useStore.getState().renameThread({ sessionId: "s1", workspaceId: "ws_a", harness: "claude", title: "another name" });
    expect(order).toEqual(["rename"]);
  });

  it("a wake the runtime refused is a toast and no name sent, so the caller can keep what was typed", async () => {
    const { api } = fakeApi([{ ...view("ws_a"), phase: "napping" }], []);
    const sent: string[] = [];
    api.wake = async () => {
      throw new RequestError("Workspace is pausing; it can be woken once it is paused");
    };
    api.renameSession = async (_id, title) => {
      sent.push(title);
      return { outcome: "renamed" };
    };
    useStore.getState().bind(api);
    await flush();

    expect(await useStore.getState().renameThread({ sessionId: "s1", workspaceId: "ws_a", harness: "claude", title: "the name" })).toBe(false);
    expect(sent).toEqual([]);
    expect(useStore.getState().toast).toBe("the name: Workspace is pausing; it can be woken once it is paused");
  });

  it("a rename the runtime named nothing for is a toast in the agent's words, and no reload", async () => {
    const sessions: SessionView[] = [{ id: "s1", workspaceId: "ws_a", harness: "claude", status: "completed" }];
    const { api, listCalls } = fakeApi([view("ws_a")], sessions);
    api.renameSession = async () => ({ outcome: "no-session" });
    useStore.getState().bind(api);
    await flush();
    listCalls.length = 0;

    expect(await useStore.getState().renameThread({ sessionId: "s1", workspaceId: "ws_a", harness: "claude", title: "the name" })).toBe(false);
    expect(useStore.getState().toast).toBe("Claude Code on the workspace has no session for this thread yet");
    expect(listCalls).toEqual([]);
  });

  it("a write the store refused is a toast in the machine's own line, never a sentence about which sessions it has", async () => {
    const { api } = fakeApi([view("ws_a")], [{ id: "s1", workspaceId: "ws_a", harness: "claude", status: "completed" }]);
    api.renameSession = async () => ({ outcome: "failed", error: "database is locked" });
    useStore.getState().bind(api);
    await flush();

    expect(await useStore.getState().renameThread({ sessionId: "s1", workspaceId: "ws_a", harness: "claude", title: "the name" })).toBe(false);
    expect(useStore.getState().toast).toBe("database is locked");
  });

  it("a rename the socket refused is a toast under the name, and a dropped socket says nothing", async () => {
    const { api } = fakeApi([view("ws_a")], []);
    api.renameSession = async () => {
      throw new RequestError("the runtime refused it");
    };
    useStore.getState().bind(api);
    await flush();
    expect(await useStore.getState().renameThread({ sessionId: "s1", workspaceId: "ws_a", harness: "claude", title: "the name" })).toBe(false);
    expect(useStore.getState().toast).toBe("the name: the runtime refused it");

    api.renameSession = async () => {
      throw new DisconnectedError("lost");
    };
    useStore.setState({ toast: null });
    await useStore.getState().renameThread({ sessionId: "s1", workspaceId: "ws_a", harness: "claude", title: "the name" });
    expect(useStore.getState().toast).toBeNull();
  });

  it("job.needs-you is a toast in the app's own words with an Open that opens the setup, and dismissing it takes the action too", async () => {
    const { api, emit } = fakeApi([view("ws_a")], []);
    useStore.getState().bind(api);
    await flush();
    emit({ type: "job.needs-you", jobId: "init_1", needsYou: { what: "sign in to GitHub CLI login", since: 1_760_000_000_000 } });
    expect(useStore.getState().toast).toBe("wsp needs you: sign in to GitHub CLI login");
    const action = useStore.getState().toastAction!;
    expect(action).toMatchObject({ for: "wsp needs you: sign in to GitHub CLI login", word: "Open" });
    expect(useStore.getState().setupOpen).toBe(false);
    action.run();
    expect(useStore.getState().setupOpen).toBe(true);
    useStore.getState().clearToast();
    expect([useStore.getState().toast, useStore.getState().toastAction]).toEqual([null, null]);
  });

  it("the need's toast goes when the need does: the row moving on, another need, and the job ending each take it away, and a toast said elsewhere is left alone", async () => {
    const { api, emit } = fakeApi([view("ws_a")], []);
    useStore.getState().bind(api);
    await flush();
    const job = (over: Partial<InitJob> = {}): InitJob => ({ id: "init_1", road: "manual", phase: "signing-in", keys: { solari: true }, step: 0, stoppable: true, screens: [], rows: [], progress: { done: 1, total: 2 }, log: [], ...over });
    const need = { what: "sign in to GitHub CLI login", since: 1_760_000_000_000 };
    const line = "wsp needs you: sign in to GitHub CLI login";

    // A view of the same standing need leaves the toast where it is.
    emit({ type: "job.needs-you", jobId: "init_1", needsYou: need });
    emit({ type: "init.job", job: job({ needsYou: need }) });
    expect(useStore.getState().toast).toBe(line);

    // The row moved on: the view carries no need, so the sentence goes with it and the action with the sentence.
    emit({ type: "init.job", job: job() });
    expect([useStore.getState().toast, useStore.getState().toastAction]).toEqual([null, null]);

    // The next need takes the slot, and a view carrying only the older one does not resurrect it.
    emit({ type: "job.needs-you", jobId: "init_1", needsYou: need });
    emit({ type: "init.job", job: job({ needsYou: { what: "sign in to Claude Code login", since: 1_760_000_002_000 } }) });
    expect(useStore.getState().toast).toBeNull();

    // A job that ends while a need's toast stands takes it away too, the last view being one with no need on it.
    emit({ type: "job.needs-you", jobId: "init_1", needsYou: need });
    expect(useStore.getState().toast).toBe(line);
    emit({ type: "init.job", job: job({ phase: "done" }) });
    expect([useStore.getState().toast, useStore.getState().toastAction]).toEqual([null, null]);

    // A toast from anywhere else is not a need's, so a job view is not allowed to clear it.
    useStore.setState({ toast: "runtime unreachable" });
    emit({ type: "init.job", job: job({ needsYou: need }) });
    expect(useStore.getState().toast).toBe("runtime unreachable");

    // Nor one that carries an action of its own: the version line offers the releases page and outlives any build.
    const version = "this app is 0.1.3, the host is 0.1.5: get the new app";
    useStore.setState({ toast: version, toastAction: { for: version, word: "Get", run: () => {} } });
    emit({ type: "init.job", job: job({ needsYou: need }) });
    emit({ type: "init.job", job: job({ phase: "done" }) });
    expect(useStore.getState().toast).toBe(version);
    expect(useStore.getState().toastAction?.word).toBe("Get");
  });

  it("workspace.deleted drops the workspace's rows", async () => {
    const sessions: SessionView[] = [{ id: "s1", workspaceId: "ws_a", harness: "claude", status: "completed" }];
    const { api, emit } = fakeApi([view("ws_a")], sessions);
    useStore.getState().bind(api);
    await flush();
    emit({ type: "workspace.deleted", workspaceId: "ws_a" });
    expect(useStore.getState().sessions).toEqual({});
  });
});

describe("store connection", () => {
  it("starts connecting and mirrors what the client reports", () => {
    expect(useStore.getState().conn).toBe("connecting");
    useStore.getState().setConn("reconnecting");
    expect(useStore.getState().conn).toBe("reconnecting");
  });

  it("live with an api bound pulls the workspace list and the status snapshot again", async () => {
    const workspaces = [view("ws_a")];
    const { api, pulls } = fakeApi(workspaces, []);
    useStore.getState().bind(api);
    await flush();
    expect(pulls).toEqual({ workspaces: 1, statuses: 1 });

    workspaces.push(view("ws_b"));
    useStore.getState().setConn("reconnecting");
    useStore.getState().setConn("live");
    await flush();
    expect(pulls).toEqual({ workspaces: 2, statuses: 2 });
    expect(useStore.getState().workspaces.map(w => w.id)).toEqual(["ws_a", "ws_b"]);
    expect(Object.keys(useStore.getState().statuses)).toEqual(["ws_a", "ws_b"]);
    expect(useStore.getState().selectedId).toBe("ws_a");
  });

  it("live before anything is bound pulls nothing", () => {
    useStore.getState().setConn("live");
    expect(useStore.getState().conn).toBe("live");
    expect(useStore.getState().api).toBeNull();
  });

  it("an optimistic toggle cut off by the drop reverts without a toast; the banner already says it", async () => {
    const { api } = fakeApi([view("ws_a")], []);
    api.nap = async () => {
      throw new DisconnectedError("lost");
    };
    useStore.getState().bind(api);
    await flush();
    const toggling = useStore.getState().toggle("ws_a");
    expect(useStore.getState().workspaces[0]!.phase).toBe("pausing");
    await toggling;
    expect(useStore.getState().workspaces[0]!.phase).toBe("running");
    expect(useStore.getState().toast).toBeNull();
  });
});

describe("store workspaces", () => {
  it("a refused nap reverts the optimistic phase and toasts the reason", async () => {
    const { api } = fakeApi([view("ws_a")], []);
    api.nap = async () => {
      throw new Error("backend said no");
    };
    useStore.getState().bind(api);
    await flush();
    const toggling = useStore.getState().toggle("ws_a");
    expect(useStore.getState().workspaces[0]!.phase).toBe("pausing");
    await toggling;
    expect(useStore.getState().workspaces[0]!.phase).toBe("running");
    expect(useStore.getState().toast).toContain("backend said no");
  });

  it("wake paints waking and calls the api; on a running workspace it does nothing; toggle wakes a pausing one after the nap", async () => {
    const { api } = fakeApi([view("ws_a"), { ...view("ws_b"), phase: "napping" }], []);
    const calls: string[] = [];
    api.wake = async id => { calls.push(`wake:${id}`); return view(id); };
    api.nap = async id => { calls.push(`nap:${id}`); return { ...view(id), phase: "napping" }; };
    useStore.getState().bind(api);
    await flush();
    await useStore.getState().wake("ws_a");
    expect(calls).toEqual([]);
    const waking = useStore.getState().wake("ws_b");
    expect(useStore.getState().workspaces[1]!.phase).toBe("waking");
    await waking;
    expect(calls).toEqual(["wake:ws_b"]);
    await useStore.getState().toggle("ws_a");
    expect(calls).toEqual(["wake:ws_b", "nap:ws_a"]);
  });

  it("the one slot stops a wake the host is still asking the provider for, and paints the record it hands back", async () => {
    const { api } = fakeApi([{ ...view("ws_a"), phase: "waking" }], []);
    const calls: string[] = [];
    api.stopWake = async id => {
      calls.push(`stopWake:${id}`);
      return { ...view(id), phase: "napping" };
    };
    api.nap = async id => { calls.push(`nap:${id}`); return { ...view(id), phase: "napping" }; };
    api.wake = async id => { calls.push(`wake:${id}`); return view(id); };
    useStore.getState().bind(api);
    await flush();
    await useStore.getState().toggle("ws_a");
    expect(calls).toEqual(["stopWake:ws_a"]);
    expect(useStore.getState().workspaces[0]!.phase).toBe("napping");
    // And that record now offers the wake again, which is the slot's other word.
    await useStore.getState().toggle("ws_a");
    expect(calls).toEqual(["stopWake:ws_a", "wake:ws_a"]);
  });

  it("a client with no stop leaves the wake alone rather than napping the machine under it", async () => {
    const { api } = fakeApi([{ ...view("ws_a"), phase: "waking" }], []);
    const calls: string[] = [];
    api.nap = async id => { calls.push(`nap:${id}`); return { ...view(id), phase: "napping" }; };
    api.wake = async id => { calls.push(`wake:${id}`); return view(id); };
    delete api.stopWake;
    useStore.getState().bind(api);
    await flush();
    await useStore.getState().toggle("ws_a");
    expect(calls).toEqual([]);
    expect(useStore.getState().workspaces[0]!.phase).toBe("waking");
  });

  it("napped carries the phase; woken and upgraded carry the phase and the new machine", async () => {
    const { api, emit } = fakeApi([view("ws_a")], []);
    useStore.getState().bind(api);
    await flush();
    emit({ type: "workspace.napped", workspaceId: "ws_a" });
    expect(useStore.getState().workspaces[0]!.phase).toBe("napping");
    expect(useStore.getState().statuses["ws_a"]?.phase).toBe("napping");
    emit({ type: "workspace.woken", workspaceId: "ws_a", machineId: "m2", resurrected: true });
    expect(useStore.getState().workspaces[0]!).toMatchObject({ phase: "running", machineId: "m2" });
    emit({ type: "workspace.upgraded", workspaceId: "ws_a", machineId: "m3" });
    expect(useStore.getState().workspaces[0]!.machineId).toBe("m3");
    expect(useStore.getState().statuses["ws_a"]?.machineId).toBe("m3");
  });

  it("renamed carries the name onto the row and its status, and moves nothing about the machine", async () => {
    const { api, emit } = fakeApi([view("ws_a")], []);
    useStore.getState().bind(api);
    await flush();
    const was = useStore.getState().statuses["ws_a"]!;
    emit({ type: "workspace.renamed", workspaceId: "ws_a", name: "the name he typed" });
    expect(useStore.getState().workspaces[0]!.name).toBe("the name he typed");
    expect(useStore.getState().statuses["ws_a"]).toMatchObject({ name: "the name he typed", phase: was.phase, machineId: was.machineId, machineState: was.machineState });
    // A workspace no row holds is not invented by a name.
    emit({ type: "workspace.renamed", workspaceId: "ws_gone", name: "nobody" });
    expect(useStore.getState().workspaces.map(w => w.id)).toEqual(["ws_a"]);
    expect(useStore.getState().statuses["ws_gone"]).toBeUndefined();
  });

  it("the look lands on the row and its status, and a cleared fact leaves rather than lingering under the merge", async () => {
    const { api, emit } = fakeApi([view("ws_a")], []);
    useStore.getState().bind(api);
    await flush();
    emit({ type: "workspace.look", workspaceId: "ws_a", theme: DEFAULT_THEME, glyph: "flask" });
    expect(useStore.getState().workspaces[0]!).toMatchObject({ theme: DEFAULT_THEME, glyph: "flask" });
    expect(useStore.getState().statuses["ws_a"]).toMatchObject({ theme: DEFAULT_THEME, glyph: "flask" });
    // Clearing one is a null, not a missing key, so the row loses it instead of keeping the old theme.
    emit({ type: "workspace.look", workspaceId: "ws_a", theme: null, glyph: "flask" });
    expect(useStore.getState().workspaces[0]!).not.toHaveProperty("theme");
    expect(useStore.getState().statuses["ws_a"]).not.toHaveProperty("theme");
    expect(useStore.getState().workspaces[0]!.glyph).toBe("flask");
    // A workspace no row holds is not invented by a look.
    emit({ type: "workspace.look", workspaceId: "ws_gone", theme: DEFAULT_THEME, glyph: null });
    expect(useStore.getState().workspaces.map(w => w.id)).toEqual(["ws_a"]);
    expect(useStore.getState().statuses["ws_gone"]).toBeUndefined();
  });

  it("setWorkspaceLook sends the one fact a picker changed and puts what the runtime answers with on the row", async () => {
    const { api } = fakeApi([view("ws_a")], []);
    const looked = { ...view("ws_a"), theme: DEFAULT_THEME };
    const calls: unknown[][] = [];
    api.setWorkspaceLook = async (...args) => { calls.push(args); return looked; };
    useStore.getState().bind(api);
    await flush();
    expect(await useStore.getState().setWorkspaceLook({ workspaceId: "ws_a", look: { theme: DEFAULT_THEME } })).toBe(true);
    expect(calls).toEqual([["ws_a", { theme: DEFAULT_THEME }]]);
    expect(useStore.getState().workspaces[0]!.theme).toEqual(DEFAULT_THEME);
    // A refusal is a toast and a false, and the row keeps what it had.
    api.setWorkspaceLook = async () => { throw new Error("the host said no"); };
    expect(await useStore.getState().setWorkspaceLook({ workspaceId: "ws_a", look: { theme: null } })).toBe(false);
    expect(useStore.getState().toast).toBe("the host said no");
    expect(useStore.getState().workspaces[0]!.theme).toEqual(DEFAULT_THEME);
    // A client without the verb takes no pick at all.
    delete api.setWorkspaceLook;
    expect(await useStore.getState().setWorkspaceLook({ workspaceId: "ws_a", look: { glyph: "bug" } })).toBe(false);
  });

  it("gone carries the phase and the provider's words onto the view and its status", async () => {
    const { api, emit } = fakeApi([view("ws_a")], []);
    useStore.getState().bind(api);
    await flush();
    emit({ type: "workspace.gone", workspaceId: "ws_a", machineId: "m1", reason: "machine m1 is gone at the provider: Not found" });
    expect(useStore.getState().workspaces[0]!).toMatchObject({ phase: "gone", gone: "machine m1 is gone at the provider: Not found" });
    emit({ type: "workspace.upgraded", workspaceId: "ws_a", machineId: "m2" });
    expect(useStore.getState().workspaces[0]!).toMatchObject({ phase: "running", machineId: "m2" });
    expect(useStore.getState().workspaces[0]!.gone).toBeUndefined();
  });

  it("a record that leaves gone drops the words with it, on the view and on its status", async () => {
    const { api, emit } = fakeApi([view("ws_a")], []);
    useStore.getState().bind(api);
    await flush();
    emit({ type: "workspace.gone", workspaceId: "ws_a", machineId: "m1", reason: "machine m1 is gone at the provider: Not found" });
    expect(useStore.getState().workspaces[0]!.gone).toBe("machine m1 is gone at the provider: Not found");
    // The verdict did not hold: the machine was there all along, so nothing is left saying it was not.
    emit({ type: "workspace.woken", workspaceId: "ws_a", machineId: "m1", resurrected: false });
    expect(useStore.getState().workspaces[0]!).toMatchObject({ phase: "running", machineId: "m1" });
    expect(useStore.getState().workspaces[0]!.gone).toBeUndefined();
  });

  it("session.start counts spending and workspace.deleted prunes it", async () => {
    const { api, emit } = fakeApi([view("ws_a")], []);
    useStore.getState().bind(api);
    await flush();
    emit({ type: "session.start", workspaceId: "ws_a", sessionId: "s1" });
    expect(useStore.getState().spending["ws_a"]).toBe(1);
    emit({ type: "session.end", workspaceId: "ws_a", sessionId: "s1", exitCode: 0, sawResult: true });
    expect(useStore.getState().spending["ws_a"]).toBe(0);
    emit({ type: "session.start", workspaceId: "ws_a", sessionId: "s2" });
    emit({ type: "workspace.deleted", workspaceId: "ws_a" });
    expect(useStore.getState().spending["ws_a"]).toBeUndefined();
  });

  it("a failed status subscription becomes a toast instead of silence", async () => {
    const { api } = fakeApi([view("ws_a")], []);
    api.watchStatuses = async () => {
      throw new Error("runtime unreachable");
    };
    useStore.getState().bind(api);
    await flush();
    expect(useStore.getState().toast).toContain("runtime unreachable");
  });
});

describe("store replay gaps", () => {
  it("noteGap counts every reconnect the runtime could not replay, so history readers know to reload", () => {
    expect(useStore.getState().gaps).toBe(0);
    useStore.getState().noteGap();
    useStore.getState().noteGap();
    expect(useStore.getState().gaps).toBe(2);
  });
});

// Last in the file on purpose: it runs after every test that set an address, so it fails if one was left behind.
describe("the address never leaks out of the tests that set it", () => {
  it("a refresh with no address of its own still takes the first row", async () => {
    const { api } = fakeApi([view("ws_a"), view("ws_b")], []);
    useStore.setState({ api });
    await useStore.getState().refresh();
    expect(useStore.getState().selectedId).toBe("ws_a");
  });
});
