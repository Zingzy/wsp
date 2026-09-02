// SPDX-License-Identifier: AGPL-3.0-only
// The store's session folding: rows come from the sessions.list op, the
// session.* events decide when to refetch and what to patch in between.
import { beforeEach, describe, expect, it } from "vitest";
import type { SessionView, WorkspaceView } from "@wsp/protocol";
import type { Api, ProtocolEvent } from "../src/protocol/client.js";
import { useStore } from "../src/protocol/store.js";

const view = (id: string): WorkspaceView => ({
  id,
  name: id,
  machineId: `m_${id}`,
  phase: "running",
  golden: "snap_g",
  createdAt: "2026-09-01T00:00:00Z",
});

const CAPS = { liveCloneForks: true, ramPreservingPause: true, resize: true, previewUrls: true, signedUrls: true };

function fakeApi(workspaces: WorkspaceView[], sessions: SessionView[]) {
  const listeners = new Set<(e: ProtocolEvent) => void>();
  const listCalls: (string | undefined)[] = [];
  const api: Api = {
    listWorkspaces: async () => workspaces,
    getWorkspace: async id => workspaces.find(w => w.id === id)!,
    createWorkspace: async () => workspaces[0]!,
    createFromGoldenHead: async () => workspaces[0]!,
    watchStatuses: async () => [],
    nap: async id => workspaces.find(w => w.id === id)!,
    wake: async id => workspaces.find(w => w.id === id)!,
    upgrade: async id => workspaces.find(w => w.id === id)!,
    capabilities: async () => CAPS,
    startSession: async o => ({ id: "s_new", workspaceId: o.workspaceId, harness: "claude", status: "running" }),
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
  return { api, emit, listCalls };
}

const flush = () => new Promise(r => setTimeout(r, 0));

beforeEach(() => {
  useStore.setState({ api: null, capabilities: null, workspaces: [], statuses: {}, costs: {}, spending: {}, toast: null, selectedId: null, sessions: {}, ready: false });
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
