// SPDX-License-Identifier: AGPL-3.0-only
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionView, WorkspaceView } from "@wsp/protocol";
import { TabStrip } from "../src/components/TabStrip.js";
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
const row = (workspaceId: string): SessionView => ({ id: `s_${workspaceId}`, workspaceId, harness: "claude", status: "running" });

function fakeApi(workspaces: WorkspaceView[], sessions: SessionView[]) {
  const listeners = new Set<(e: ProtocolEvent) => void>();
  const api: Api = {
    listWorkspaces: async () => workspaces,
    getWorkspace: async id => workspaces.find(w => w.id === id)!,
    createWorkspace: async () => workspaces[0]!,
    createFromGoldenHead: async () => workspaces[0]!,
    watchStatuses: async () => [],
    nap: async id => workspaces.find(w => w.id === id)!,
    wake: async id => workspaces.find(w => w.id === id)!,
    upgrade: async id => workspaces.find(w => w.id === id)!,
    capabilities: async () => ({ liveCloneForks: true, ramPreservingPause: true, resize: true, previewUrls: true, signedUrls: true }),
    startSession: async o => row(o.workspaceId),
    portReach: async (_id, port) => ({ url: `https://m1-${port}.preview.example/?pt_token=e`, expiresAt: Date.now() + 3_600_000 }),
    daemonReach: async () => ({ url: "ws://127.0.0.1:1", expiresAt: 0 }),
    builderReach: async () => ({ url: "ws://127.0.0.1:1", expiresAt: 0 }),
    sessionHistory: async () => [],
    listSnapshots: async () => ({ name: "default", head: null, versions: [] }),
    rollbackSnapshot: async () => ({ lineage: { name: "default", head: null, versions: [] }, existingWorkspaces: "untouched" }),
    listSessions: async id => (id === undefined ? sessions : sessions.filter(s => s.workspaceId === id)),
    getGolden: async () => undefined,
    prepareGolden: async () => { throw new Error("no wizard in this fixture"); },
    sealGolden: async () => { throw new Error("no wizard in this fixture"); },
    subscribe: fn => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
  const emit = (e: ProtocolEvent) => act(() => { for (const fn of [...listeners]) fn(e); });
  return { api, emit };
}

const flush = () => act(() => new Promise(r => setTimeout(r, 0)));
const activeTab = () => screen.getAllByRole("tab").find(t => t.getAttribute("aria-selected") === "true")?.textContent;

beforeEach(() => {
  useStore.setState({ api: null, capabilities: null, workspaces: [], statuses: {}, costs: {}, spending: {}, toast: null, selectedId: null, sessions: {}, ready: false });
});
afterEach(cleanup);

describe("tab strip default tab", () => {
  it("opens on terminal without a session and flips to chat when one starts after mount", async () => {
    const sessions: SessionView[] = [];
    const { api, emit } = fakeApi([view("ws_a")], sessions);
    act(() => useStore.getState().bind(api));
    await flush();
    render(<TabStrip />);
    expect(activeTab()).toBe("terminal");

    sessions.push(row("ws_a"));
    emit({ type: "session.start", workspaceId: "ws_a", sessionId: "c1" });
    await flush();
    expect(activeTab()).toBe("chat");
  });

  it("a tab the user picked survives a session starting", async () => {
    const sessions: SessionView[] = [];
    const { api, emit } = fakeApi([view("ws_a")], sessions);
    act(() => useStore.getState().bind(api));
    await flush();
    render(<TabStrip />);
    fireEvent.click(screen.getByRole("tab", { name: "browser" }));
    expect(activeTab()).toBe("browser");

    sessions.push(row("ws_a"));
    emit({ type: "session.start", workspaceId: "ws_a", sessionId: "c1" });
    await flush();
    expect(activeTab()).toBe("browser");
  });

  it("forgets a pick when its workspace is deleted, so a reused id starts on the default again", async () => {
    const { api, emit } = fakeApi([view("ws_a")], []);
    act(() => useStore.getState().bind(api));
    await flush();
    render(<TabStrip />);
    fireEvent.click(screen.getByRole("tab", { name: "browser" }));
    expect(activeTab()).toBe("browser");

    emit({ type: "workspace.deleted", workspaceId: "ws_a" });
    emit({ type: "workspace.created", workspace: view("ws_a") });
    act(() => useStore.getState().select("ws_a"));
    expect(activeTab()).toBe("terminal");
  });

  it("each workspace gets its own default: chat where a session exists, terminal elsewhere", async () => {
    const { api } = fakeApi([view("ws_a"), view("ws_b")], [row("ws_b")]);
    act(() => useStore.getState().bind(api));
    await flush();
    render(<TabStrip />);
    expect(activeTab()).toBe("terminal");
    act(() => useStore.getState().select("ws_b"));
    expect(activeTab()).toBe("chat");
    act(() => useStore.getState().select("ws_a"));
    expect(activeTab()).toBe("terminal");
  });
});
