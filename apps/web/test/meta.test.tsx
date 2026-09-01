// SPDX-License-Identifier: AGPL-3.0-only
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Capabilities, EventUnion, WorkspaceSize, WorkspaceStatus, WorkspaceView } from "@wsp/protocol";
import { MetaPanel } from "../src/components/MetaPanel.js";
import type { Api } from "../src/protocol/client.js";
import { useStore } from "../src/protocol/store.js";

const view = (id: string, name: string, phase: "running" | "napping" = "running"): WorkspaceView => ({
  id,
  name,
  machineId: `m_${id}`,
  phase,
  golden: "snap_golden01",
  createdAt: "2026-08-30T09:00:00Z",
});

const status = (w: WorkspaceView): WorkspaceStatus => ({
  ...w,
  machineState: w.phase === "napping" ? "paused" : "running",
  reach: { state: w.phase === "napping" ? "napping" : "reachable" },
  size: { cpu: 2, memMb: 4096 },
  rateUsdPerHour: 0.11,
});

const costEvent = (workspaceId: string, rate: number, awakeMs: number, at: string): EventUnion => ({
  type: "workspace.cost",
  workspaceId,
  phase: "running",
  rateUsdPerHour: rate,
  awakeMs,
  accruedUsd: (rate * awakeMs) / 3_600_000,
  at,
});

const CAPS: Capabilities = { liveCloneForks: true, ramPreservingPause: true, resize: true, previewUrls: true, signedUrls: true };

// Live emitter: MetaPanel's cost series listens through api.subscribe, exactly
// like the store does, so tests push events through the same channel.
export function fakeApi(workspaces: WorkspaceView[], capabilities: Capabilities = CAPS) {
  const listeners = new Set<(e: EventUnion) => void>();
  const api: Api & {
    emit(e: EventUnion): void;
    nap: ReturnType<typeof vi.fn>;
    upgrade: ReturnType<typeof vi.fn<(id: string, size: WorkspaceSize) => Promise<WorkspaceView>>>;
  } = {
    upgrade: vi.fn(async (id: string, _size: WorkspaceSize) => view(id, "?", "running")),
    capabilities: vi.fn(async () => capabilities),
    daemonReach: vi.fn(async () => ({ url: "ws://127.0.0.1:1", expiresAt: 0 })),
    startSession: vi.fn(async (o: { workspaceId: string }) => ({ id: "s1", workspaceId: o.workspaceId, harness: "claude", status: "running" as const })),
    sessionHistory: vi.fn(async () => []),
    listWorkspaces: vi.fn(async () => workspaces),
    getWorkspace: vi.fn(async id => workspaces.find(w => w.id === id)!),
    createWorkspace: vi.fn(async () => workspaces[0]!),
    createFromGoldenHead: vi.fn(async (name: string) => view("ws_new", name)),
    watchStatuses: vi.fn(async () => workspaces.map(status)),
    nap: vi.fn(async (id: string) => view(id, "?", "napping")),
    wake: vi.fn(async (id: string) => view(id, "?", "running")),
    listSessions: vi.fn(async () => []),
    getGolden: async () => undefined,
    prepareGolden: async () => { throw new Error("no wizard in this fixture"); },
    sealGolden: async () => { throw new Error("no wizard in this fixture"); },
    subscribe: fn => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    emit: e => {
      for (const fn of listeners) fn(e);
    },
  };
  return api;
}

beforeEach(() => {
  useStore.setState({
    api: null,
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
  render(<MetaPanel />);
  await waitFor(() => expect(useStore.getState().ready).toBe(true));
  return api;
}

const fact = (k: string): string => document.querySelector(`[data-k="${k}"]`)?.textContent ?? "";

describe("machine facts", () => {
  it("renders size, state, and reach from the enriched status", async () => {
    await bindAndRender([view("ws_a", "api")]);
    await waitFor(() => expect(fact("machine")).toBe("2 vCPU · 4 GB"));
    expect(fact("state")).toBe("running");
    expect(fact("reach")).toBe("reachable");
    expect(screen.getByText("m_ws_a")).toBeDefined();
  });

  it("shows machine-state divergence next to the phase", async () => {
    const w = view("ws_a", "api");
    const api = await bindAndRender([w]);
    act(() => api.emit({ type: "workspace.status", status: { ...status(w), machineState: "starting" } }));
    await waitFor(() => expect(fact("state")).toBe("running · starting"));
  });

  it("renders awake time from the cost event's awakeMs", async () => {
    const api = await bindAndRender([view("ws_a", "api")]);
    expect(fact("awake")).toBe("—");
    act(() => api.emit(costEvent("ws_a", 0.11, 125_000, "2026-09-01T00:02:05Z")));
    await waitFor(() => expect(fact("awake")).toBe("2m 5s"));
  });

  it("renders 'no selection' without a workspace", () => {
    render(<MetaPanel />);
    expect(screen.getByText("no selection")).toBeDefined();
  });
});

describe("spend sparkline", () => {
  it("accumulates cost events into the sparkline with a peak caption", async () => {
    const api = await bindAndRender([view("ws_a", "api")]);
    expect(screen.getByText("no spend data yet")).toBeDefined();
    act(() => api.emit(costEvent("ws_a", 0.11, 60_000, "2026-09-01T00:01:00Z")));
    expect(screen.getByText("no spend data yet")).toBeDefined(); // one point is not a line
    act(() => api.emit(costEvent("ws_a", 0.22, 120_000, "2026-09-01T00:02:00Z")));
    await waitFor(() => expect(document.querySelector("[data-spark]")).not.toBeNull());
    expect(screen.getByText("peak $0.22")).toBeDefined();
    // rendered in the viewer's timezone, so assert shape rather than a fixed clock
    expect(screen.getByText(/^since \d{2}:\d{2}$/)).toBeDefined();
  });

  it("keeps each workspace's series separate", async () => {
    const api = await bindAndRender([view("ws_a", "api"), view("ws_b", "web")]);
    act(() => {
      api.emit(costEvent("ws_b", 0.44, 60_000, "2026-09-01T00:01:00Z"));
      api.emit(costEvent("ws_b", 0.44, 120_000, "2026-09-01T00:02:00Z"));
    });
    // ws_a is selected; ws_b's spend must not paint here
    expect(screen.getByText("no spend data yet")).toBeDefined();
    act(() => useStore.getState().select("ws_b"));
    await waitFor(() => expect(screen.getByText("peak $0.44")).toBeDefined());
  });

  it("shows the live rate and accrued total", async () => {
    const api = await bindAndRender([view("ws_a", "api")]);
    act(() => api.emit(costEvent("ws_a", 0.11, 60_000, "2026-09-01T00:01:00Z")));
    await waitFor(() => expect(screen.getByText("$0.110/hr")).toBeDefined());
    expect(screen.getByText(/\$0\.0018/)).toBeDefined();
  });
});

describe("snapshot lineage", () => {
  it("renders live disk and the golden base from view fields", async () => {
    await bindAndRender([view("ws_a", "api")]);
    expect(screen.getByText("live disk")).toBeDefined();
    expect(screen.getByText("forked 2026-08-30")).toBeDefined();
    expect(fact("golden")).toBe("snap_golden01golden");
  });
});

describe("pause/wake", () => {
  it("paints the phase immediately and calls the api", async () => {
    const api = await bindAndRender([view("ws_a", "api")]);
    fireEvent.click(screen.getByRole("button", { name: "pause api" }));
    expect(useStore.getState().workspaces[0]!.phase).toBe("napping");
    expect(screen.getByRole("button", { name: "wake api" })).toBeDefined();
    await waitFor(() => expect(api.nap).toHaveBeenCalledWith("ws_a"));
  });

  it("reverts on failure", async () => {
    const api = await bindAndRender([view("ws_a", "api")]);
    api.nap.mockRejectedValueOnce(new Error("backend said no"));
    fireEvent.click(screen.getByRole("button", { name: "pause api" }));
    expect(useStore.getState().workspaces[0]!.phase).toBe("napping");
    await waitFor(() => expect(useStore.getState().workspaces[0]!.phase).toBe("running"));
    expect(screen.getByRole("button", { name: "pause api" })).toBeDefined();
  });
});

async function openPicker(api: Awaited<ReturnType<typeof bindAndRender>>) {
  await waitFor(() => expect(fact("machine")).toBe("2 vCPU · 4 GB"));
  await waitFor(() => expect((screen.getByRole("button", { name: "upgrade api" }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "upgrade api" }));
  return api;
}

describe("upgrade", () => {
  it("offers doubling tiers with the estimated rate", async () => {
    await openPicker(await bindAndRender([view("ws_a", "api")]));
    expect(screen.getByRole("button", { name: "8 vCPU · 16 GB" })).toBeDefined();
    expect(screen.getByRole("button", { name: "16 vCPU · 32 GB" })).toBeDefined();
    expect(screen.getByText("~$0.220/hr", { exact: false })).toBeDefined();
  });

  it("paints the new size while the op runs, then settles on the status event", async () => {
    const api = await bindAndRender([view("ws_a", "api")]);
    let resolveUpgrade!: (w: WorkspaceView) => void;
    api.upgrade.mockImplementationOnce(() => new Promise(res => (resolveUpgrade = res)));
    await openPicker(api);
    fireEvent.click(screen.getByRole("button", { name: "confirm resize" }));

    // painted before the api call settles
    expect(fact("machine")).toBe("4 vCPU · 8 GB · resizing");
    expect(screen.getByRole("status").textContent).toBe("resizing…");
    expect(api.upgrade).toHaveBeenCalledWith("ws_a", { cpu: 4, memMb: 8192 });

    act(() => resolveUpgrade(view("ws_a", "api")));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("resized"));

    const w = view("ws_a", "api");
    act(() => api.emit({ type: "workspace.status", status: { ...status(w), size: { cpu: 4, memMb: 8192 } } }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe(""));
    expect(fact("machine")).toBe("4 vCPU · 8 GB");
  });

  it("picks a larger tier when chosen", async () => {
    const api = await openPicker(await bindAndRender([view("ws_a", "api")]));
    fireEvent.click(screen.getByRole("button", { name: "8 vCPU · 16 GB" }));
    fireEvent.click(screen.getByRole("button", { name: "confirm resize" }));
    await waitFor(() => expect(api.upgrade).toHaveBeenCalledWith("ws_a", { cpu: 8, memMb: 16384 }));
  });

  it("un-paints and shows the message on failure", async () => {
    const api = await bindAndRender([view("ws_a", "api")]);
    api.upgrade.mockRejectedValueOnce(new Error("quota exceeded"));
    await openPicker(api);
    fireEvent.click(screen.getByRole("button", { name: "confirm resize" }));
    await waitFor(() => expect(screen.getByText("quota exceeded")).toBeDefined());
    expect(fact("machine")).toBe("2 vCPU · 4 GB");
  });

  it("stays disabled and says so when the backend cannot resize", async () => {
    const api = fakeApi([view("ws_a", "api")], { ...CAPS, resize: false });
    useStore.getState().bind(api);
    render(<MetaPanel />);
    await waitFor(() => expect(fact("machine")).toBe("2 vCPU · 4 GB"));
    await waitFor(() => expect(useStore.getState().capabilities?.resize).toBe(false));
    const button = screen.getByRole("button", { name: "upgrade api" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe("no resize");
    fireEvent.click(button);
    expect(screen.queryByRole("button", { name: "confirm resize" })).toBeNull();
    expect(api.upgrade).not.toHaveBeenCalled();
  });
});
