// SPDX-License-Identifier: AGPL-3.0-only
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceStatus, WorkspaceView } from "@wsp/protocol";
import { Rail } from "../src/components/Rail.js";
import type { Api } from "../src/protocol/client.js";
import { useStore } from "../src/protocol/store.js";

const view = (id: string, name: string, phase: "running" | "napping" = "running"): WorkspaceView => ({
  id,
  name,
  machineId: `m_${id}`,
  phase,
  golden: "snap_g",
  createdAt: "2026-09-01T00:00:00Z",
});

const status = (w: WorkspaceView): WorkspaceStatus => ({
  ...w,
  machineState: w.phase === "napping" ? "paused" : "running",
  reach: { state: w.phase === "napping" ? "napping" : "reachable" },
  size: { cpu: 2, memMb: 4096 },
  rateUsdPerHour: 0.11,
});

function fakeApi(workspaces: WorkspaceView[]): Api & { nap: ReturnType<typeof vi.fn> } {
  return {
    listWorkspaces: vi.fn(async () => workspaces),
    getWorkspace: vi.fn(async id => workspaces.find(w => w.id === id)!),
    createWorkspace: vi.fn(async () => workspaces[0]!),
    createFromGoldenHead: vi.fn(async (name: string) => view("ws_new", name)),
    watchStatuses: vi.fn(async () => workspaces.map(status)),
    nap: vi.fn(async (id: string) => view(id, "?", "napping")),
    wake: vi.fn(async (id: string) => view(id, "?", "running")),
    upgrade: vi.fn(async (id: string) => view(id, "?", "running")),
    capabilities: vi.fn(async () => ({ liveCloneForks: true, ramPreservingPause: true, resize: true, previewUrls: true, signedUrls: true })),
    startSession: vi.fn(async (o: { workspaceId: string }) => ({ id: "s1", workspaceId: o.workspaceId, harness: "claude", status: "running" as const })),
    portReach: vi.fn(async (_id: string, port: number) => ({ url: `https://m1-${port}.preview.example/?pt_token=e`, expiresAt: Date.now() + 3_600_000 })),
    daemonReach: vi.fn(async () => ({ url: "ws://127.0.0.1:1", expiresAt: 0 })),
    builderReach: vi.fn(async () => ({ url: "ws://127.0.0.1:1", expiresAt: 0 })),
    sessionHistory: vi.fn(async () => []),
    listSnapshots: vi.fn(async () => ({ name: "default", head: null, versions: [] })),
    rollbackSnapshot: vi.fn(async () => ({ lineage: { name: "default", head: null, versions: [] }, existingWorkspaces: "untouched" as const })),
    listSessions: vi.fn(async () => []),
    subscribe: vi.fn(() => () => {}),
    getGolden: async () => undefined,
    prepareGolden: async () => { throw new Error("no wizard in this fixture"); },
    sealGolden: async () => { throw new Error("no wizard in this fixture"); },
  };
}

beforeEach(() => {
  useStore.setState({
    api: null,
    capabilities: null,
    workspaces: [],
    statuses: {},
    costs: {},
    spending: {},
    toast: null,
    selectedId: null,
    sessions: {},
    ready: false,
  });
});

async function bindAndRender(workspaces: WorkspaceView[]) {
  const api = fakeApi(workspaces);
  useStore.getState().bind(api);
  render(<Rail />);
  await waitFor(() => expect(screen.getByText(workspaces[0]!.name)).toBeDefined());
  return api;
}

describe("rail cards", () => {
  it("renders 3-row cards: dot+name+phase, size, live cost ticker", async () => {
    await bindAndRender([view("ws_a", "api")]);
    await waitFor(() => expect(screen.getByText("2 vCPU · 4 GB")).toBeDefined());
    act(() => useStore.getState().applyEvent({
      type: "workspace.cost",
      workspaceId: "ws_a",
      phase: "running",
      rateUsdPerHour: 0.11,
      awakeMs: 60_000,
      accruedUsd: 0.0018,
      at: "2026-09-01T00:01:00Z",
    }));
    await waitFor(() => expect(screen.getByText(/\$0\.110\/hr/)).toBeDefined());
    expect(screen.getByText(/\$0\.0018/)).toBeDefined();

    act(() => useStore.getState().applyEvent({
      type: "workspace.cost",
      workspaceId: "ws_a",
      phase: "running",
      rateUsdPerHour: 0.11,
      awakeMs: 120_000,
      accruedUsd: 0.0037,
      at: "2026-09-01T00:02:00Z",
    }));
    await waitFor(() => expect(screen.getByText(/\$0\.0037/)).toBeDefined());
  });

  it("selection drives the store", async () => {
    await bindAndRender([view("ws_a", "api"), view("ws_b", "web")]);
    fireEvent.click(screen.getByText("web"));
    expect(useStore.getState().selectedId).toBe("ws_b");
  });

  it("marks the dot as spending while a session runs", async () => {
    await bindAndRender([view("ws_a", "api")]);
    const dot = () => document.querySelector('[data-dot="ws_a"]')!;
    expect(dot().getAttribute("data-spending")).toBe("false");
    act(() => useStore.getState().applyEvent({ type: "session.start", workspaceId: "ws_a", sessionId: "s1" }));
    await waitFor(() => expect(dot().getAttribute("data-spending")).toBe("true"));
    act(() => useStore.getState().applyEvent({ type: "session.end", workspaceId: "ws_a", sessionId: "s1", exitCode: 0, sawResult: true }));
    await waitFor(() => expect(dot().getAttribute("data-spending")).toBe("false"));
  });
});

describe("optimistic nap/wake", () => {
  it("paints immediately and reconciles on success", async () => {
    const api = await bindAndRender([view("ws_a", "api")]);
    fireEvent.click(screen.getByRole("button", { name: /nap api/i }));
    // painted before the api call settles
    expect(useStore.getState().workspaces[0]!.phase).toBe("napping");
    await waitFor(() => expect(api.nap).toHaveBeenCalledWith("ws_a"));
    expect(useStore.getState().workspaces[0]!.phase).toBe("napping");
    expect(useStore.getState().toast).toBeNull();
  });

  it("reverts and toasts on failure", async () => {
    const api = await bindAndRender([view("ws_a", "api")]);
    api.nap.mockRejectedValueOnce(new Error("backend said no"));
    fireEvent.click(screen.getByRole("button", { name: /nap api/i }));
    expect(useStore.getState().workspaces[0]!.phase).toBe("napping");
    await waitFor(() => expect(useStore.getState().workspaces[0]!.phase).toBe("running"));
    await waitFor(() => expect(screen.getByText(/backend said no/)).toBeDefined());
  });

  it("reconciles phase from napped events and phase+machineId from woken/upgraded", async () => {
    await bindAndRender([view("ws_a", "api")]);
    act(() => useStore.getState().applyEvent({ type: "workspace.napped", workspaceId: "ws_a" }));
    expect(useStore.getState().workspaces[0]!.phase).toBe("napping");
    // wake-via-resurrect and upgrade replace the machine; the event's machineId must land
    act(() => useStore.getState().applyEvent({ type: "workspace.woken", workspaceId: "ws_a", machineId: "m2", resurrected: true }));
    expect(useStore.getState().workspaces[0]!).toMatchObject({ phase: "running", machineId: "m2" });
    act(() => useStore.getState().applyEvent({ type: "workspace.upgraded", workspaceId: "ws_a", machineId: "m3" }));
    expect(useStore.getState().workspaces[0]!.machineId).toBe("m3");
  });

  it("deleting a workspace prunes its spending counter", async () => {
    await bindAndRender([view("ws_a", "api")]);
    act(() => useStore.getState().applyEvent({ type: "session.start", workspaceId: "ws_a", sessionId: "s1" }));
    act(() => useStore.getState().applyEvent({ type: "workspace.deleted", workspaceId: "ws_a" }));
    expect(useStore.getState().spending["ws_a"]).toBeUndefined();
  });
});

describe("status subscription failure", () => {
  it("surfaces a failed watchStatuses as a toast instead of silence", async () => {
    const api = fakeApi([view("ws_a", "api")]);
    api.watchStatuses = vi.fn(async () => { throw new Error("runtime unreachable"); });
    useStore.getState().bind(api);
    render(<Rail />);
    await waitFor(() => expect(screen.getByText(/runtime unreachable/)).toBeDefined());
  });
});

describe("new-workspace affordance", () => {
  it("creates from the golden head on enter", async () => {
    const api = await bindAndRender([view("ws_a", "api")]);
    fireEvent.click(screen.getByRole("button", { name: /new workspace/i }));
    const input = screen.getByPlaceholderText(/name/i);
    fireEvent.change(input, { target: { value: "beta" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(api.createFromGoldenHead).toHaveBeenCalledWith("beta"));
  });
});
