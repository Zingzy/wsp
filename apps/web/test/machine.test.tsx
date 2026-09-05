// SPDX-License-Identifier: AGPL-3.0-only
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Capabilities,
  EventUnion,
  SnapshotLineage,
  SnapshotRollbackResult,
  WorkspacePhase,
  WorkspaceSize,
  WorkspaceStatus,
  WorkspaceView,
} from "@wsp/protocol";
import { MachineSurface } from "../src/components/machine/MachineSurface.js";
import type { Api } from "../src/protocol/client.js";
import { useStore } from "../src/protocol/store.js";

const view = (id: string, name: string, phase: WorkspacePhase = "running"): WorkspaceView => ({
  id,
  name,
  machineId: `m_${id}_0123456789abcdef`,
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

const CAPS: Capabilities = { liveCloneForks: true, ramPreservingPause: true, resize: true, previewUrls: true, signedUrls: true, containers: true, callbackRelay: true };
const EMPTY_LINEAGE: SnapshotLineage = { name: "default", head: null, versions: [] };

// The surface's cost series listens through api.subscribe like the store does,
// so tests push events through the same channel.
function fakeApi(workspaces: WorkspaceView[], capabilities: Capabilities = CAPS, lineage: SnapshotLineage = EMPTY_LINEAGE) {
  const listeners = new Set<(e: EventUnion) => void>();
  let current = lineage;
  const api: Api & {
    emit(e: EventUnion): void;
    nap: ReturnType<typeof vi.fn<(id: string) => Promise<WorkspaceView>>>;
    wake: ReturnType<typeof vi.fn<(id: string) => Promise<WorkspaceView>>>;
    upgrade: ReturnType<typeof vi.fn<(id: string, size: WorkspaceSize) => Promise<WorkspaceView>>>;
    rollbackSnapshot: ReturnType<typeof vi.fn<(version: number, name?: string) => Promise<SnapshotRollbackResult>>>;
    listSnapshots: ReturnType<typeof vi.fn<() => Promise<SnapshotLineage>>>;
  } = {
    upgrade: vi.fn(async (id: string, _size: WorkspaceSize) => view(id, "?", "running")),
    capabilities: vi.fn(async () => capabilities),
    portReach: vi.fn(async (_id: string, port: number) => ({ url: `https://m1-${port}.preview.example/?pt_token=e`, expiresAt: Date.now() + 3_600_000 })),
    daemonReach: vi.fn(async () => ({ url: "ws://127.0.0.1:1", expiresAt: 0 })),
    builderReach: vi.fn(async () => ({ url: "ws://127.0.0.1:1", expiresAt: 0 })),
    startSession: vi.fn(async (o: { workspaceId: string }) => ({ id: "s1", workspaceId: o.workspaceId, harness: "claude", status: "running" as const })),
    sessionHistory: vi.fn(async () => []),
    listSnapshots: vi.fn<() => Promise<SnapshotLineage>>(async () => current),
    rollbackSnapshot: vi.fn(async (version: number) => {
      current = { ...current, head: version };
      return { lineage: current, existingWorkspaces: "untouched" as const };
    }),
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

async function mount(workspaces: WorkspaceView[], capabilities: Capabilities = CAPS, lineage: SnapshotLineage = EMPTY_LINEAGE) {
  const api = fakeApi(workspaces, capabilities, lineage);
  useStore.getState().bind(api);
  render(<MachineSurface workspaceId={workspaces[0]!.id} />);
  await waitFor(() => expect(useStore.getState().ready).toBe(true));
  await waitFor(() => expect(useStore.getState().capabilities).not.toBeNull());
  await waitFor(() => expect(fact("size")).toBe("2 vCPU · 4 GB"));
  return api;
}

const fact = (k: string): string => document.querySelector(`[data-k="${k}"]`)?.textContent ?? "";

const gv = (n: number) => ({
  version: n,
  snapshotId: `snap_golden-v${n}`,
  baseTemplate: "base",
  setupSha: `sha${n}`,
  createdAt: `2026-08-${10 + n}T00:00:00.000Z`,
  smoke: { cmd: "true", exitCode: 0 },
});
const twoVersions: SnapshotLineage = { name: "default", head: 12, versions: [gv(11), gv(12)] };
const onV12 = (): WorkspaceView => ({ ...view("ws_a", "api"), golden: "snap_golden-v12" });

describe("machine facts", () => {
  it("renders id, state, reach and size from the enriched status", async () => {
    await mount([view("ws_a", "api")]);
    expect(fact("machine-id")).toBe("m_ws_a_0123456789abcdef");
    expect(fact("state")).toBe("Running");
    expect(fact("reach")).toBe("reachable");
    expect(fact("size")).toBe("2 vCPU · 4 GB");
  });

  it("copies the full machine id", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await mount([view("ws_a", "api")]);
    fireEvent.click(screen.getByRole("button", { name: "Copy machine id" }));
    expect(writeText).toHaveBeenCalledWith("m_ws_a_0123456789abcdef");
  });

  it("renders napping as Paused and waking as Waking with the wake control held", async () => {
    await mount([view("ws_a", "api", "napping")]);
    expect(fact("state")).toBe("Paused");
    expect(screen.getByRole("button", { name: "wake api" })).toBeDefined();
    act(() => useStore.getState().applyEvent({ type: "workspace.woken", workspaceId: "ws_a", machineId: "m2", resurrected: false }));
    act(() => useStore.setState(s => ({ workspaces: s.workspaces.map(w => ({ ...w, phase: "waking" as const })) })));
    expect(fact("state")).toBe("Waking");
    expect((screen.getByRole("button", { name: "wake api" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows machine-state divergence next to the phase", async () => {
    const w = view("ws_a", "api");
    const api = await mount([w]);
    act(() => api.emit({ type: "workspace.status", status: { ...status(w), machineState: "starting" } }));
    await waitFor(() => expect(fact("state")).toBe("Running · machine starting"));
  });

  it("renders reach slow as edge slow and no-daemon in words", async () => {
    const w = view("ws_a", "api");
    const api = await mount([w]);
    act(() => api.emit({ type: "workspace.status", status: { ...status(w), reach: { state: "slow" } } }));
    await waitFor(() => expect(fact("reach")).toBe("edge slow"));
    act(() => api.emit({ type: "workspace.status", status: { ...status(w), reach: { state: "no-daemon" } } }));
    await waitFor(() => expect(fact("reach")).toBe("no daemon"));
  });

  it("renders awake time from the cost event's awakeMs", async () => {
    const api = await mount([view("ws_a", "api")]);
    expect(fact("awake")).toBe("pending");
    act(() => api.emit(costEvent("ws_a", 0.11, 125_000, "2026-09-01T00:02:05Z")));
    await waitFor(() => expect(fact("awake")).toBe("2m 5s"));
  });

  it("shows the runtime's reason when the status carries one", async () => {
    const w = view("ws_a", "api");
    const api = await mount([w]);
    act(() => api.emit({ type: "workspace.status", status: { ...status(w), reason: "idle 20 min" } }));
    await waitFor(() => expect(fact("reason")).toBe("idle 20 min"));
  });

  it("says machines cannot run containers when the backend reports containers: false", async () => {
    await mount([view("ws_a", "api")], { ...CAPS, containers: false });
    expect(fact("containers")).toBe("This provider's machines cannot run containers; install services natively.");
  });

  it("shows no container line when the backend can run them", async () => {
    await mount([view("ws_a", "api")]);
    expect(document.querySelector('[data-k="containers"]')).toBeNull();
  });

  it("renders an empty state without a workspace", () => {
    render(<MachineSurface workspaceId="ws_missing" />);
    expect(screen.getByText("No workspace selected.")).toBeDefined();
  });
});

describe("idle window", () => {
  it("counts down to idleAt", async () => {
    const w = view("ws_a", "api");
    const api = await mount([w]);
    expect(fact("idle")).toBe("not scheduled");
    act(() => api.emit({ type: "workspace.status", status: { ...status(w), idleAt: Date.now() + 90_000 } }));
    await waitFor(() => expect(fact("idle")).toMatch(/^naps in 1m (29|30)s$/));
  });

  it("reads napping now once idleAt has passed", async () => {
    const w = view("ws_a", "api");
    const api = await mount([w]);
    act(() => api.emit({ type: "workspace.status", status: { ...status(w), idleAt: Date.now() - 1_000 } }));
    await waitFor(() => expect(fact("idle")).toBe("napping now"));
  });
});

describe("usage", () => {
  it("shows the live rate and accrued total", async () => {
    const api = await mount([view("ws_a", "api")]);
    act(() => api.emit(costEvent("ws_a", 0.11, 60_000, "2026-09-01T00:01:00Z")));
    await waitFor(() => expect(fact("rate")).toBe("$0.110/hr"));
    expect(fact("accrued")).toBe("$0.0018");
  });

  it("draws one bar per cost tick and drops the empty state on the first tick", async () => {
    const api = await mount([view("ws_a", "api")]);
    expect(screen.getByText("No cost ticks yet.")).toBeDefined();
    act(() => api.emit(costEvent("ws_a", 0.11, 60_000, "2026-09-01T00:01:00Z")));
    await waitFor(() => expect(document.querySelectorAll("[data-usage-bar]")).toHaveLength(1));
    expect(screen.queryByText("No cost ticks yet.")).toBeNull();
    act(() => api.emit(costEvent("ws_a", 0.22, 120_000, "2026-09-01T00:02:00Z")));
    await waitFor(() => expect(document.querySelectorAll("[data-usage-bar]")).toHaveLength(2));
    expect(screen.getByText("peak $0.22")).toBeDefined();
  });

  it("never says no spend while the counters show spend the chart missed", async () => {
    const api = fakeApi([view("ws_a", "api")]);
    useStore.getState().bind(api);
    // A tick that landed before the surface mounted: the store has it, the chart does not.
    act(() => useStore.getState().applyEvent(costEvent("ws_a", 0.11, 60_000, "2026-09-01T00:01:00Z")));
    render(<MachineSurface workspaceId="ws_a" />);
    await waitFor(() => expect(fact("accrued")).toBe("$0.0018"));
    expect(screen.queryByText("No cost ticks yet.")).toBeNull();
    expect(screen.getByText("Chart starts with the next cost tick.")).toBeDefined();
  });

  it("keeps each workspace's series separate", async () => {
    const api = await mount([view("ws_a", "api"), view("ws_b", "web")]);
    act(() => {
      api.emit(costEvent("ws_b", 0.44, 60_000, "2026-09-01T00:01:00Z"));
      api.emit(costEvent("ws_b", 0.44, 120_000, "2026-09-01T00:02:00Z"));
    });
    expect(document.querySelectorAll("[data-usage-bar]")).toHaveLength(0);
    expect(screen.getByText("No cost ticks yet.")).toBeDefined();
  });
});

describe("lineage", () => {
  it("renders live disk and the golden base while no golden was ever sealed", async () => {
    await mount([view("ws_a", "api")]);
    expect(screen.getByText("Live disk")).toBeDefined();
    expect(screen.getByText("forked 2026-08-30")).toBeDefined();
    await waitFor(() => expect(fact("golden")).toBe("snap_golden01"));
  });

  it("lists versions newest first, marks head and this fork, offers rollback only off head", async () => {
    await mount([onV12()], CAPS, twoVersions);
    await waitFor(() => expect(fact("v12")).toBe("v12headthis fork"));
    expect(fact("v11")).toBe("v11");
    expect(screen.getByText("built 2026-08-22")).toBeDefined();
    const rows = [...document.querySelectorAll("[data-k^='v1']")].map(el => el.getAttribute("data-k"));
    expect(rows).toEqual(["v12", "v11"]);
    expect(screen.getByRole("button", { name: "roll back to v11" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "roll back to v12" })).toBeNull();
  });

  it("asks before rolling back; confirming calls the api once and moves head", async () => {
    const api = await mount([onV12()], CAPS, twoVersions);
    fireEvent.click(await screen.findByRole("button", { name: "roll back to v11" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("Roll back to v11?");
    expect(dialog.textContent).toContain("Workspaces already forked keep their image.");
    expect(api.rollbackSnapshot).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Roll back" }));
    await waitFor(() => expect(api.rollbackSnapshot).toHaveBeenCalledTimes(1));
    expect(api.rollbackSnapshot).toHaveBeenCalledWith(11);
    await waitFor(() => expect(fact("v11")).toBe("v11head"));
    expect(fact("v12")).toBe("v12this fork");
    expect(screen.getByText("New forks use v11. Existing workspaces keep their image.")).toBeDefined();
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });

  it("cancel closes the confirm without touching the api", async () => {
    const api = await mount([onV12()], CAPS, twoVersions);
    fireEvent.click(await screen.findByRole("button", { name: "roll back to v11" }));
    await screen.findByRole("alertdialog");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(api.rollbackSnapshot).not.toHaveBeenCalled();
  });

  it("a refused rollback shows the runtime's message and leaves head where it was", async () => {
    const api = await mount([onV12()], CAPS, twoVersions);
    api.rollbackSnapshot.mockRejectedValueOnce(new Error("rollback target v11 not in manifest"));
    fireEvent.click(await screen.findByRole("button", { name: "roll back to v11" }));
    await screen.findByRole("alertdialog");
    fireEvent.click(screen.getByRole("button", { name: "Roll back" }));
    await waitFor(() => expect(screen.getByText("rollback target v11 not in manifest")).toBeDefined());
    expect(fact("v12")).toBe("v12headthis fork");
  });

  it("refetches the lineage when a golden seals", async () => {
    const api = await mount([onV12()], CAPS, twoVersions);
    await screen.findByRole("button", { name: "roll back to v11" });
    expect(api.listSnapshots).toHaveBeenCalledTimes(1);
    api.listSnapshots.mockResolvedValueOnce({ name: "default", head: 13, versions: [gv(11), gv(12), gv(13)] });
    act(() => api.emit({ type: "golden.stage", name: "default", stage: "snapshotting" }));
    expect(api.listSnapshots).toHaveBeenCalledTimes(1);
    act(() => api.emit({ type: "golden.stage", name: "default", stage: "sealed" }));
    await waitFor(() => expect(fact("v13")).toBe("v13head"));
    expect(api.listSnapshots).toHaveBeenCalledTimes(2);
  });
});

describe("pause and wake", () => {
  it("pause paints the phase immediately and calls the api once", async () => {
    const api = await mount([view("ws_a", "api")]);
    fireEvent.click(screen.getByRole("button", { name: "pause api" }));
    expect(useStore.getState().workspaces[0]!.phase).toBe("pausing");
    expect(fact("state")).toBe("Pausing");
    const held = screen.getByRole("button", { name: "wake api" }) as HTMLButtonElement;
    expect(held.textContent).toBe("Pausing…");
    expect(held.disabled).toBe(true);
    await waitFor(() => expect(api.nap).toHaveBeenCalledTimes(1));
    expect(api.nap).toHaveBeenCalledWith("ws_a");
  });

  it("wake calls the api once and paints waking", async () => {
    const api = await mount([view("ws_a", "api", "napping")]);
    fireEvent.click(screen.getByRole("button", { name: "wake api" }));
    expect(useStore.getState().workspaces[0]!.phase).toBe("waking");
    expect(fact("state")).toBe("Waking");
    await waitFor(() => expect(api.wake).toHaveBeenCalledTimes(1));
    expect(api.wake).toHaveBeenCalledWith("ws_a");
  });

  it("reverts on failure", async () => {
    const api = await mount([view("ws_a", "api")]);
    api.nap.mockRejectedValueOnce(new Error("backend said no"));
    fireEvent.click(screen.getByRole("button", { name: "pause api" }));
    await waitFor(() => expect(useStore.getState().workspaces[0]!.phase).toBe("running"));
    expect(screen.getByRole("button", { name: "pause api" })).toBeDefined();
  });
});

describe("upgrade", () => {
  const openPicker = () => fireEvent.click(screen.getByRole("button", { name: "upgrade api" }));

  it("offers doubling tiers with the estimated rate", async () => {
    await mount([view("ws_a", "api")]);
    openPicker();
    expect(screen.getByRole("button", { name: "4 vCPU · 8 GB" })).toBeDefined();
    expect(screen.getByRole("button", { name: "8 vCPU · 16 GB" })).toBeDefined();
    expect(screen.getByRole("button", { name: "16 vCPU · 32 GB" })).toBeDefined();
    expect(screen.getByText("~$0.220/hr", { exact: false })).toBeDefined();
  });

  it("paints the new size while the op runs, calls the api once, then settles on the status event", async () => {
    const api = await mount([view("ws_a", "api")]);
    let resolveUpgrade!: (w: WorkspaceView) => void;
    api.upgrade.mockImplementationOnce(() => new Promise(res => (resolveUpgrade = res)));
    openPicker();
    fireEvent.click(screen.getByRole("button", { name: "Confirm resize" }));

    expect(fact("size")).toBe("4 vCPU · 8 GB · resizing");
    expect(screen.getByRole("status").textContent).toBe("Resizing…");
    expect(api.upgrade).toHaveBeenCalledTimes(1);
    expect(api.upgrade).toHaveBeenCalledWith("ws_a", { cpu: 4, memMb: 8192 });

    act(() => resolveUpgrade(view("ws_a", "api")));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Resized."));

    const w = view("ws_a", "api");
    act(() => api.emit({ type: "workspace.status", status: { ...status(w), size: { cpu: 4, memMb: 8192 } } }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe(""));
    expect(fact("size")).toBe("4 vCPU · 8 GB");
  });

  it("picks a larger tier when chosen", async () => {
    const api = await mount([view("ws_a", "api")]);
    openPicker();
    fireEvent.click(screen.getByRole("button", { name: "8 vCPU · 16 GB" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm resize" }));
    await waitFor(() => expect(api.upgrade).toHaveBeenCalledWith("ws_a", { cpu: 8, memMb: 16384 }));
  });

  it("un-paints and shows the message on failure", async () => {
    const api = await mount([view("ws_a", "api")]);
    api.upgrade.mockRejectedValueOnce(new Error("quota exceeded"));
    openPicker();
    fireEvent.click(screen.getByRole("button", { name: "Confirm resize" }));
    await waitFor(() => expect(screen.getByText("quota exceeded")).toBeDefined());
    expect(fact("size")).toBe("2 vCPU · 4 GB");
  });

  it("is a disabled control with a hint when the backend cannot resize", async () => {
    const api = await mount([view("ws_a", "api")], { ...CAPS, resize: false });
    const button = screen.getByRole("button", { name: "upgrade api" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(fact("resize-hint")).toBe("This provider cannot resize a machine. Pick the size when you create a workspace.");
    fireEvent.click(button);
    expect(screen.queryByRole("button", { name: "Confirm resize" })).toBeNull();
    expect(api.upgrade).not.toHaveBeenCalled();
  });
});

describe("zombie", () => {
  const zombie = (w: WorkspaceView): WorkspaceStatus => ({
    ...status(w),
    reach: { state: "zombie" },
    reason: "m_ws_a answered nothing for 92s after slow at 14:02:11",
  });

  it("renders the zombie reach distinctly with the runtime's reason and a rebuild control", async () => {
    const w = view("ws_a", "api");
    const api = await mount([w]);
    expect(screen.queryByRole("button", { name: "rebuild api" })).toBeNull();
    act(() => api.emit({ type: "workspace.status", status: zombie(w) }));
    await waitFor(() => expect(fact("reach")).toBe("zombie"));
    expect(document.querySelector('[data-reach="zombie"]')).not.toBeNull();
    expect(fact("reason")).toBe("m_ws_a answered nothing for 92s after slow at 14:02:11");
    expect(screen.getByRole("button", { name: "rebuild api" })).toBeDefined();
  });

  it("asks before rebuilding; confirming calls the api once", async () => {
    const w = view("ws_a", "api");
    const api = await mount([w]);
    const rebuild = vi.fn(async (id: string) => ({ ...view(id, "api"), machineId: "m_fresh" }));
    api.rebuild = rebuild;
    act(() => api.emit({ type: "workspace.status", status: zombie(w) }));
    fireEvent.click(await screen.findByRole("button", { name: "rebuild api" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("Rebuild api?");
    expect(rebuild).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Rebuild" }));
    await waitFor(() => expect(rebuild).toHaveBeenCalledTimes(1));
    expect(rebuild).toHaveBeenCalledWith("ws_a");
    await waitFor(() => expect(screen.getByText("Machine rebuilt from the golden.")).toBeDefined());
  });

  it("cancel leaves the zombie alone", async () => {
    const w = view("ws_a", "api");
    const api = await mount([w]);
    const rebuild = vi.fn(async (id: string) => view(id, "api"));
    api.rebuild = rebuild;
    act(() => api.emit({ type: "workspace.status", status: zombie(w) }));
    fireEvent.click(await screen.findByRole("button", { name: "rebuild api" }));
    await screen.findByRole("alertdialog");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(rebuild).not.toHaveBeenCalled();
  });
});
