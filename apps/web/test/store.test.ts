// SPDX-License-Identifier: AGPL-3.0-only
// The store's session folding: rows come from the sessions.list op, the
// session.* events decide when to refetch and what to patch in between.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionView, WorkspaceView } from "@wsp/protocol";
import { DisconnectedError, RequestError, type Api, type ProtocolEvent } from "../src/protocol/client.js";
import { LAST_WORKSPACE_KEY } from "../src/protocol/lastWorkspace.js";
import { useStore } from "../src/protocol/store.js";

const view = (id: string): WorkspaceView => ({
  id,
  name: id,
  machineId: `m_${id}`,
  phase: "running",
  golden: "snap_g",
  createdAt: "2026-09-01T00:00:00Z",
});

const CAPS = { liveCloneForks: true, ramPreservingPause: true, resize: true, previewUrls: true, signedUrls: true, containers: true, callbackRelay: true, snapshotListing: true, templates: false, sizes: [] };

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
    daemonReach: async () => ({ url: "ws://127.0.0.1:1", expiresAt: 0 }),
    sessionHistory: async () => [],
    listSnapshots: async () => ({ name: "default", head: null, versions: [] }),
    snapshotStorage: async () => null,
    rollbackSnapshot: async () => ({ lineage: { name: "default", head: null, versions: [] }, existingWorkspaces: "untouched" }),
    listSessions: async id => {
      listCalls.push(id);
      return id === undefined ? sessions : sessions.filter(s => s.workspaceId === id);
    },
    getGolden: async () => undefined,
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
  useStore.setState({ api: null, conn: "connecting", capabilities: null, workspaces: [], statuses: {}, costs: {}, spending: {}, toast: null, selectedId: null, creations: [], sessions: {}, ready: false, gaps: 0 });
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
    useStore.setState({ creations: [{ key: "c1", name: "new", workspaceId: null, lines: [], failed: null }], selectedId: "c1" });
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
  const stage = (over: Partial<Extract<ProtocolEvent, { type: "workspace.creating" }>> = {}): ProtocolEvent => ({
    type: "workspace.creating",
    workspaceId: "ws_new",
    name: "beta",
    stage: "fork-requested",
    message: "Fork of the golden image requested.",
    elapsedMs: 0,
    ...over,
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
    expect(failed.failed?.title).toBe("The provider refused: machine cap reached");
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
    expect(useStore.getState().toast).toBe("Claude Code on the machine has no session for this thread yet");
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

  it("gone carries the phase and the provider's words onto the view and its status", async () => {
    const { api, emit } = fakeApi([view("ws_a")], []);
    useStore.getState().bind(api);
    await flush();
    emit({ type: "workspace.gone", workspaceId: "ws_a", machineId: "m1", reason: "machine m1 is gone at the provider: Not found" });
    expect(useStore.getState().workspaces[0]!).toMatchObject({ phase: "gone", gone: "machine m1 is gone at the provider: Not found" });
    emit({ type: "workspace.upgraded", workspaceId: "ws_a", machineId: "m2" });
    expect(useStore.getState().workspaces[0]!).toMatchObject({ phase: "running", machineId: "m2" });
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
