// SPDX-License-Identifier: AGPL-3.0-only
// The store's session folding: rows come from the sessions.list op, the
// session.* events decide when to refetch and what to patch in between.
import { beforeEach, describe, expect, it } from "vitest";
import type { SessionView, WorkspaceView } from "@wsp/protocol";
import { DisconnectedError, type Api, type ProtocolEvent } from "../src/protocol/client.js";
import { useStore } from "../src/protocol/store.js";

const view = (id: string): WorkspaceView => ({
  id,
  name: id,
  machineId: `m_${id}`,
  phase: "running",
  golden: "snap_g",
  createdAt: "2026-09-01T00:00:00Z",
});

const CAPS = { liveCloneForks: true, ramPreservingPause: true, resize: true, previewUrls: true, signedUrls: true, containers: true, callbackRelay: true };

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
    builderReach: async () => ({ url: "ws://127.0.0.1:1", expiresAt: 0 }),
    sessionHistory: async () => [],
    listSnapshots: async () => ({ name: "default", head: null, versions: [] }),
    rollbackSnapshot: async () => ({ lineage: { name: "default", head: null, versions: [] }, existingWorkspaces: "untouched" }),
    listSessions: async id => {
      listCalls.push(id);
      return id === undefined ? sessions : sessions.filter(s => s.workspaceId === id);
    },
    getGolden: async () => undefined,
    prepareGolden: async () => { throw new Error("no wizard in this fixture"); },
    sealGolden: async () => { throw new Error("no wizard in this fixture"); },
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
  useStore.setState({ api: null, conn: "connecting", capabilities: null, workspaces: [], statuses: {}, costs: {}, spending: {}, toast: null, selectedId: null, sessions: {}, ready: false, gaps: 0 });
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

  it("session.done patches the row's status without a round trip; session.end refetches", async () => {
    const sessions: SessionView[] = [
      { id: "s1", workspaceId: "ws_a", harness: "claude", status: "running", claudeSessionId: "c1" },
    ];
    const { api, emit, listCalls } = fakeApi([view("ws_a")], sessions);
    useStore.getState().bind(api);
    await flush();
    listCalls.length = 0;

    emit({ type: "session.done", workspaceId: "ws_a", sessionId: "c1", result: { status: "interrupted" } });
    expect(useStore.getState().sessions["ws_a"]![0]!.status).toBe("interrupted");
    expect(listCalls).toEqual([]);

    sessions[0]!.status = "failed";
    emit({ type: "session.end", workspaceId: "ws_a", sessionId: "c1", exitCode: 1, sawResult: false });
    await flush();
    expect(listCalls).toEqual(["ws_a"]);
    expect(useStore.getState().sessions["ws_a"]![0]!.status).toBe("failed");
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
    expect(useStore.getState().workspaces[0]!.phase).toBe("napping");
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
    expect(useStore.getState().workspaces[0]!.phase).toBe("napping");
    await toggling;
    expect(useStore.getState().workspaces[0]!.phase).toBe("running");
    expect(useStore.getState().toast).toContain("backend said no");
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
