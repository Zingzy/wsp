// SPDX-License-Identifier: AGPL-3.0-only
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { cloneElement, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Capabilities,
  EventUnion,
  SnapshotLineage,
  SnapshotRollbackResult,
  SysSample,
  WorkspacePhase,
  WorkspaceSize,
  WorkspaceStatus,
  WorkspaceView,
} from "@wsp/protocol";
import { MachineSurface } from "../src/components/machine/MachineSurface.js";
import { DAEMON_HELLO_WAIT_MS, provideDaemonHello, provideDaemonUpdate } from "../src/files/wire.js";
import { getLive, resetLive } from "../src/machine/live.js";
import type { Api } from "../src/protocol/client.js";
import { useStore } from "../src/protocol/store.js";

// Base UI's tooltip opens on pointer hover, which jsdom cannot stage; the popup renders inline instead.
vi.mock("../src/components/ui/tooltip.js", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ render: element, children }: { render: ReactElement<{ children?: ReactNode }>; children?: ReactNode }) => cloneElement(element, {}, children ?? element.props.children),
  TooltipPopup: ({ children }: { children: ReactNode }) => <div role="tooltip">{children}</div>,
}));

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

const CAPS: Capabilities = { liveCloneForks: true, ramPreservingPause: true, resize: true, previewUrls: true, signedUrls: true, containers: true, callbackRelay: true, snapshotListing: true };
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
    startSession: vi.fn(async (o: { workspaceId: string }) => ({ id: "s1", workspaceId: o.workspaceId, harness: "claude", status: "running" as const })),
    sessionHistory: vi.fn(async () => []),
    listSnapshots: vi.fn<() => Promise<SnapshotLineage>>(async () => current),
    snapshotStorage: async () => null,
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
  resetLive();
  provideDaemonHello("ws_a", null);
  provideDaemonUpdate("ws_a", null);
  document.documentElement.classList.add("dark");
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

afterEach(() => {
  vi.useRealTimers();
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

  it("every fact value carries its full text as a title, so a value the row cuts is still readable", async () => {
    const w = view("ws_a", "api");
    const api = await mount([w]);
    act(() => api.emit({ type: "workspace.status", status: { ...status(w), machineState: "starting", idleAt: Date.now() + 90_000 } }));
    await waitFor(() => expect(fact("state")).toBe("Running · machine starting"));
    for (const k of ["state", "reach", "size", "awake", "idle"]) {
      const el = document.querySelector(`[data-k="${k}"]`)!;
      expect(el.getAttribute("title")).toBe(el.textContent);
      expect(el.className).toContain("truncate");
    }
  });

  it("a machine id hundreds of characters long is cut inside its cell and rides its title in full", async () => {
    const id = "ZGVza3Rvc".repeat(25);
    await mount([{ ...view("ws_a", "api"), machineId: id }]);
    const cell = document.querySelector('[data-k="machine-id"]')!;
    expect(cell.getAttribute("title")).toBe(id);
    expect(cell.className).toContain("truncate");
    expect(cell.className).toContain("max-w-28");
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

  it("draws one line through the cost ticks, never bars, and drops the empty state on the first tick", async () => {
    const api = await mount([view("ws_a", "api")]);
    expect(screen.getByText("No cost ticks yet.")).toBeDefined();
    act(() => api.emit(costEvent("ws_a", 0.11, 60_000, "2026-09-01T00:01:00Z")));
    await waitFor(() => expect(document.querySelector("[data-usage-line]")).not.toBeNull());
    expect(screen.queryByText("No cost ticks yet.")).toBeNull();
    act(() => api.emit(costEvent("ws_a", 0.22, 120_000, "2026-09-01T00:02:00Z")));
    act(() => api.emit(costEvent("ws_a", 0.11, 180_000, "2026-09-01T00:03:00Z")));
    await waitFor(() => expect(screen.getByText("peak $0.22")).toBeDefined());
    const chart = document.querySelector("[data-usage-chart]")!;
    expect(chart.querySelectorAll("rect")).toHaveLength(0);
    expect(chart.querySelectorAll("[data-usage-bar]")).toHaveLength(0);
    const line = chart.querySelector("[data-usage-line]")!;
    expect(line.tagName.toLowerCase()).toBe("path");
    // One move then one segment per tick after the first: the path is the series, nothing else.
    expect(line.getAttribute("d")).toMatch(/^M[^ML]+(L[^ML]+){2}$/);
    // The peak is marked on its point with its value beside it.
    expect(chart.querySelector("[data-usage-peak]")).not.toBeNull();
    expect(fact("usage-peak")).toBe("$0.220/hr");
  });

  it("hovering the chart reads out the tick under the pointer; leaving returns to the window", async () => {
    const api = await mount([view("ws_a", "api")]);
    act(() => {
      api.emit(costEvent("ws_a", 0.11, 60_000, "2026-09-01T00:01:00Z"));
      api.emit(costEvent("ws_a", 0.22, 120_000, "2026-09-01T00:02:00Z"));
      api.emit(costEvent("ws_a", 0.11, 180_000, "2026-09-01T00:03:00Z"));
    });
    await waitFor(() => expect(screen.getByText("peak $0.22")).toBeDefined());
    const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    expect(fact("usage-readout")).toBe(`${clock("2026-09-01T00:01:00Z")} to ${clock("2026-09-01T00:03:00Z")}`);
    const svg = document.querySelector<SVGSVGElement>("[data-usage-chart] svg")!;
    svg.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 300, bottom: 64, width: 300, height: 64, toJSON: () => ({}) });
    fireEvent.mouseMove(svg, { clientX: 150, clientY: 30 });
    expect(fact("usage-readout")).toBe(`$0.220/hr at ${clock("2026-09-01T00:02:00Z")}`);
    expect(svg.querySelector("[data-usage-hover]")).not.toBeNull();
    fireEvent.mouseMove(svg, { clientX: 299, clientY: 30 });
    expect(fact("usage-readout")).toBe(`$0.110/hr at ${clock("2026-09-01T00:03:00Z")}`);
    fireEvent.mouseLeave(svg);
    expect(fact("usage-readout")).toBe(`${clock("2026-09-01T00:01:00Z")} to ${clock("2026-09-01T00:03:00Z")}`);
    expect(svg.querySelector("[data-usage-hover]")).toBeNull();
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
    expect(document.querySelector("[data-usage-line]")).toBeNull();
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

  it("lists the tools missing from the forked version under a micro-label, one row per tool with its cause and reason, under that version alone", async () => {
    const missing = [
      { id: "tools/brew/gopls", name: "gopls", outcome: "skipped" as const, note: "no Linux bottle" },
      { id: "tools/homebrew", name: "Homebrew", outcome: "failed" as const, note: "git: not found" },
    ];
    const lineage: SnapshotLineage = { name: "default", head: 12, versions: [{ ...gv(11), missingTools: [{ id: "tools/brew-cask/raycast", name: "Raycast", outcome: "skipped", note: "macOS app, no Linux build" }] }, { ...gv(12), missingTools: missing }] };
    await mount([onV12()], CAPS, lineage);
    await waitFor(() => expect(fact("v12")).toBe("v12headthis fork"));
    const lists = document.querySelectorAll("[data-k='missing-tools']");
    expect(lists).toHaveLength(1);
    expect(lists[0]!.closest("li")?.querySelector("[data-k='v12']")).not.toBeNull();
    expect(lists[0]!.querySelector("p")?.textContent).toBe("not on this image");
    const rows = [...lists[0]!.querySelectorAll("li")].map(li => [li.querySelector("[data-k='missing-tool']")?.textContent, li.querySelector("[data-k='missing-note']")?.textContent]);
    expect(rows).toEqual([
      ["gopls", "skipped: no Linux bottle"],
      ["Homebrew", "failed: git: not found"],
    ]);
    expect(screen.queryByText("Raycast")).toBeNull();
  });

  it("two missing tools sharing a label are two rows keyed apart", async () => {
    const missing = [
      { id: "tools/brew/gh", name: "gh", outcome: "skipped" as const, note: "no Linux bottle" },
      { id: "tools/cli/gh", name: "gh", outcome: "failed" as const, note: "curl: not found" },
    ];
    const lineage: SnapshotLineage = { name: "default", head: 12, versions: [gv(11), { ...gv(12), missingTools: missing }] };
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await mount([onV12()], CAPS, lineage);
    await waitFor(() => expect(fact("v12")).toBe("v12headthis fork"));
    const rows = [...document.querySelectorAll("[data-k='missing-tools'] li")].map(li => li.querySelector("[data-k='missing-note']")?.textContent);
    expect(rows).toEqual(["skipped: no Linux bottle", "failed: curl: not found"]);
    expect(errors.mock.calls.map(c => String(c[0]))).not.toContainEqual(expect.stringContaining("same key"));
    errors.mockRestore();
  });

  it("a version that recorded no missing tools gets no list and no label", async () => {
    await mount([onV12()], CAPS, twoVersions);
    await waitFor(() => expect(fact("v12")).toBe("v12headthis fork"));
    expect(document.querySelector("[data-k='missing-tools']")).toBeNull();
    expect(screen.queryByText("not on this image")).toBeNull();
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

const GiB = 1024 ** 3;
const sysSample = (i: number, over: Partial<Pick<SysSample, "cpu" | "disk">> = {}): SysSample => ({
  type: "sys.sample",
  cpu: 33.3,
  load1: 0.42,
  mem: { used: 1 * GiB, total: 4 * GiB },
  disk: { used: 20 * GiB, total: 100 * GiB },
  at: 1_757_000_000_000 + i * 2_000,
  ...over,
});
const feed = (id: string, samples: SysSample[], reach: "live" | "connecting" = "live"): void => {
  act(() => {
    getLive(id).feedStatus(reach);
    for (const s of samples) getLive(id).feedSample(s);
  });
};
const liveRow = (k: string): HTMLElement => document.querySelector<HTMLElement>(`[data-live-row="${k}"]`)!;
const valueSlot = (k: string): HTMLElement => document.querySelector<HTMLElement>(`[data-k="${k}"]`)!;

describe("live", () => {
  it("renders cpu, memory and disk rows from the sample stream as lines with the current value at the right edge", async () => {
    await mount([view("ws_a", "api")]);
    feed("ws_a", [0, 1, 2, 3, 4].map(i => sysSample(i)));
    await waitFor(() => expect(fact("cpu")).toBe("33%"));
    expect(fact("mem")).toBe("1.0 GB of 4.0 GB");
    expect(fact("disk")).toBe("20.0 GB of 100.0 GB");
    expect(screen.getByText("load 0.42")).toBeDefined();
    for (const k of ["cpu", "mem", "disk"]) {
      const row = liveRow(k);
      expect(row.querySelectorAll("rect")).toHaveLength(0);
      const line = row.querySelector("[data-live-line]")!;
      expect(line.tagName.toLowerCase()).toBe("path");
      expect(line.getAttribute("d")).toMatch(/^M[^ML]+(L[^ML]+){4}$/);
      expect(row.hasAttribute("data-stale")).toBe(false);
    }
    expect(valueSlot("cpu").className).toMatch(/tabular-nums/);
    expect(valueSlot("cpu").className).toMatch(/font-mono/);
  });

  it("keeps the last sixty samples: the newest sits at the right edge and the oldest is dropped", async () => {
    await mount([view("ws_a", "api")]);
    feed("ws_a", Array.from({ length: 70 }, (_, i) => sysSample(i, { cpu: i })));
    await waitFor(() => expect(fact("cpu")).toBe("69%"));
    const d = liveRow("cpu").querySelector("[data-live-line]")!.getAttribute("d")!;
    expect(d.split("L")).toHaveLength(60);
    expect(d).toMatch(/L100\.00 [\d.]+$/);
  });

  it("a napping workspace keeps its last values dim under the word napping, and nothing changes height", async () => {
    await mount([view("ws_a", "api", "napping")]);
    feed("ws_a", [0, 1, 2].map(i => sysSample(i)), "connecting");
    await waitFor(() => expect(fact("cpu")).toBe("napping"));
    expect(fact("mem")).toBe("napping");
    expect(fact("disk")).toBe("napping");
    expect(screen.queryByText("load 0.42")).toBeNull();
    for (const k of ["cpu", "mem", "disk"]) {
      const row = liveRow(k);
      expect(row.getAttribute("data-stale")).toBe("napping");
      expect(row.className).toMatch(/\bh-7\b/);
      expect(row.querySelector("[data-live-line]")!.getAttribute("d")).toMatch(/^M[^ML]+(L[^ML]+){2}$/);
      expect(row.querySelector("[data-live-line]")!.getAttribute("class")).toMatch(/muted-foreground/);
      expect(valueSlot(k).className).toMatch(/muted-foreground/);
    }
  });

  it("a running workspace whose daemon link is down says unreachable; before the first sample it says pending", async () => {
    await mount([view("ws_a", "api")]);
    expect(fact("cpu")).toBe("unreachable");
    expect(liveRow("cpu").getAttribute("data-stale")).toBe("unreachable");
    feed("ws_a", []);
    await waitFor(() => expect(fact("cpu")).toBe("pending"));
    expect(liveRow("cpu").hasAttribute("data-stale")).toBe(false);
    feed("ws_a", [sysSample(0)]);
    await waitFor(() => expect(fact("cpu")).toBe("33%"));
    feed("ws_a", [], "connecting");
    await waitFor(() => expect(fact("cpu")).toBe("unreachable"));
    expect(liveRow("cpu").querySelector("[data-live-line]")).not.toBeNull();
  });

  it("the disk number takes the tier colour at 50, 65 and 75 percent; cpu and memory stay neutral", async () => {
    await mount([view("ws_a", "api")]);
    const tone = (k: string): string => valueSlot(k).className;
    const disk = (pct: number): SysSample => sysSample(0, { cpu: 95, disk: { used: pct * GiB, total: 100 * GiB } });
    feed("ws_a", [disk(49.9)]);
    await waitFor(() => expect(fact("disk")).toBe("49.9 GB of 100.0 GB"));
    expect(tone("disk")).not.toMatch(/warning|caution|destructive/);
    feed("ws_a", [disk(50)]);
    await waitFor(() => expect(fact("disk")).toBe("50.0 GB of 100.0 GB"));
    expect(tone("disk")).toMatch(/text-warning-foreground/);
    feed("ws_a", [disk(65)]);
    await waitFor(() => expect(fact("disk")).toBe("65.0 GB of 100.0 GB"));
    expect(tone("disk")).toMatch(/text-caution-foreground/);
    feed("ws_a", [disk(75)]);
    await waitFor(() => expect(fact("disk")).toBe("75.0 GB of 100.0 GB"));
    expect(tone("disk")).toMatch(/text-destructive-foreground/);
    expect(fact("cpu")).toBe("95%");
    expect(tone("cpu")).not.toMatch(/warning|caution|destructive/);
    expect(tone("mem")).not.toMatch(/warning|caution|destructive/);
  });

  it("every row is the same fixed height in every state", async () => {
    await mount([view("ws_a", "api")]);
    const heights = (): string[] => ["cpu", "mem", "disk"].map(k => liveRow(k).className.match(/\bh-\S+/)![0]);
    expect(heights()).toEqual(["h-7", "h-7", "h-7"]);
    feed("ws_a", [sysSample(0), sysSample(1)]);
    await waitFor(() => expect(fact("cpu")).toBe("33%"));
    expect(heights()).toEqual(["h-7", "h-7", "h-7"]);
    feed("ws_a", [], "connecting");
    await waitFor(() => expect(fact("cpu")).toBe("unreachable"));
    expect(heights()).toEqual(["h-7", "h-7", "h-7"]);
  });

  it("a daemon that refused the stream puts unavailable in every slot with its reason as the title, never pending, at the same height", async () => {
    await mount([view("ws_a", "api")]);
    act(() => {
      getLive("ws_a").feedStatus("live");
      getLive("ws_a").feedUnavailable("unknown op: sys.watch");
    });
    await waitFor(() => expect(fact("cpu")).toBe("unavailable"));
    for (const k of ["cpu", "mem", "disk"]) {
      expect(fact(k)).toBe("unavailable");
      expect(valueSlot(k).getAttribute("title")).toBe("unknown op: sys.watch");
      expect(liveRow(k).getAttribute("data-unavailable")).toBe("unknown op: sys.watch");
      expect(liveRow(k).className).toMatch(/\bh-7\b/);
      expect(valueSlot(k).className).toMatch(/muted-foreground/);
      expect(valueSlot(k).className).not.toMatch(/warning|caution|destructive|success/);
    }
    expect(["cpu", "mem", "disk"].map(fact)).not.toContain("pending");
    // The link dropping outranks it; a daemon that then answers the watch clears it and the rows fill.
    feed("ws_a", [], "connecting");
    await waitFor(() => expect(fact("cpu")).toBe("unreachable"));
    act(() => {
      getLive("ws_a").feedStatus("live");
      getLive("ws_a").feedUnavailable(null);
      getLive("ws_a").feedSample(sysSample(0));
    });
    await waitFor(() => expect(fact("cpu")).toBe("33%"));
    expect(valueSlot("cpu").hasAttribute("title")).toBe(false);
  });

  it("hovering a sparkline reads that sample into the value slot; leaving restores the current one", async () => {
    await mount([view("ws_a", "api")]);
    feed("ws_a", [sysSample(0, { cpu: 10 }), sysSample(1, { cpu: 50 }), sysSample(2, { cpu: 90 })]);
    await waitFor(() => expect(fact("cpu")).toBe("90%"));
    const svg = liveRow("cpu").querySelector<SVGSVGElement>("svg")!;
    svg.getBoundingClientRect = () => ({ left: 0, width: 600, top: 0, height: 16, right: 600, bottom: 16, x: 0, y: 0, toJSON: () => ({}) });
    // Three of sixty slots: the last three percent of the width, hovering the middle one.
    fireEvent.mouseMove(svg, { clientX: 600 * (58 / 59) });
    expect(fact("cpu")).toBe("50%");
    expect(svg.querySelector("[data-live-hover]")).not.toBeNull();
    fireEvent.mouseMove(svg, { clientX: 10 });
    expect(fact("cpu")).toBe("90%");
    fireEvent.mouseLeave(svg);
    expect(fact("cpu")).toBe("90%");
    expect(svg.querySelector("[data-live-hover]")).toBeNull();
  });
});

const updateLine = (): HTMLElement | null => document.querySelector<HTMLElement>('[data-k="daemon-update"]');
const updateButton = (): HTMLButtonElement => screen.getByRole("button", { name: "update the daemon on api" }) as HTMLButtonElement;

describe("daemon version", () => {
  it.each(["dark", "light"] as const)("in the %s theme a daemon older than the app gets one mono muted line naming what it predates and a keycap that updates it; a current one gets no line", async theme => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    const api = await mount([view("ws_a", "api")]);
    const updateDaemon = vi.fn(async (_id: string) => {});
    (api as Api).updateDaemon = updateDaemon;
    expect(updateLine()).toBeNull();
    act(() => provideDaemonHello("ws_a", { root: "/root", version: 2 }));
    expect(updateLine()).toBeNull();
    act(() => provideDaemonHello("ws_a", { root: "/root", version: 1 }));
    const line = updateLine()!;
    expect(line.querySelector("span")!.textContent).toBe("daemon v1 predates Live and Processes");
    expect(line.className).toMatch(/font-mono/);
    expect(line.className).toMatch(/text-muted-foreground/);
    expect(line.className).toMatch(/\bh-6\b/);
    expect(line.className).not.toMatch(/warning|caution|destructive|success|info/);
    expect(line.querySelectorAll("[class*=badge], [data-slot=badge]")).toHaveLength(0);
    const button = updateButton();
    expect(button.textContent).toBe("update");
    expect(line.querySelector("[role=tooltip]")!.textContent).toBe("Restarts the daemon on the machine. Open terminals end, chat threads keep running.");
    expect(button.className).toMatch(/border/);
    expect(button.className).toMatch(/\bh-5\b/);
    expect(button.className).not.toMatch(/warning|caution|destructive|success|info/);
    fireEvent.click(button);
    expect(updateDaemon).toHaveBeenCalledWith("ws_a");
    await waitFor(() => expect(updateButton().textContent).toBe("updating"));
    expect(updateLine()!.className).toMatch(/\bh-6\b/);
    // The new daemon's hello names a current version: the line leaves.
    act(() => provideDaemonHello("ws_a", { root: "/root", version: 2 }));
    expect(updateLine()).toBeNull();
  });

  it("after the update resolves the keycap stays busy until the daemon's hello names a current version, so a second click cannot run the deploy again", async () => {
    const api = await mount([view("ws_a", "api")]);
    let settle!: () => void;
    (api as Api).updateDaemon = vi.fn((_id: string) => new Promise<void>(resolve => (settle = resolve)));
    act(() => provideDaemonHello("ws_a", { root: "/root", version: 1 }));
    fireEvent.click(updateButton());
    await waitFor(() => expect(updateButton().textContent).toBe("updating"));
    await act(async () => settle());
    // The runtime is done but the link it killed has not redialled yet: the line still reads v1 and the keycap stays busy.
    expect(updateLine()!.querySelector("span")!.textContent).toBe("daemon v1 predates Live and Processes");
    expect(updateButton().textContent).toBe("updating");
    expect(updateButton().disabled).toBe(true);
    act(() => provideDaemonHello("ws_a", { root: "/root", version: 2 }));
    expect(updateLine()).toBeNull();
  });

  it("a daemon that never reports back frees the keycap once the bound passes, with the daemon's line as the title", async () => {
    const api = await mount([view("ws_a", "api")]);
    (api as Api).updateDaemon = vi.fn(async (_id: string) => {});
    act(() => provideDaemonHello("ws_a", { root: "/root", version: 1 }));
    vi.useFakeTimers();
    fireEvent.click(updateButton());
    await act(async () => {});
    expect(updateButton().textContent).toBe("updating");
    act(() => vi.advanceTimersByTime(DAEMON_HELLO_WAIT_MS - 1));
    expect(updateButton().textContent).toBe("updating");
    act(() => vi.advanceTimersByTime(1));
    expect(updateButton().textContent).toBe("update");
    expect(updateButton().disabled).toBe(false);
    expect(updateLine()!.querySelector("span")!.textContent).toBe("daemon v1 predates Live and Processes");
    expect(updateLine()!.querySelector("span")!.getAttribute("title")).toBe("daemon v1 predates Live and Processes");
  });

  it("leaving the machine tab mid-update and coming back finds the keycap still busy: a click runs nothing more, and the current hello removes the line", async () => {
    const api = await mount([view("ws_a", "api")]);
    let settle!: () => void;
    const updateDaemon = vi.fn((_id: string) => new Promise<void>(resolve => (settle = resolve)));
    (api as Api).updateDaemon = updateDaemon;
    act(() => provideDaemonHello("ws_a", { root: "/root", version: 1 }));
    fireEvent.click(updateButton());
    await act(async () => settle());
    expect(updateButton().textContent).toBe("updating");
    // The right panel renders one surface at a time: the processes pane or another workspace unmounts this one.
    cleanup();
    render(<MachineSurface workspaceId="ws_a" />);
    await waitFor(() => expect(updateLine()).not.toBeNull());
    expect(updateLine()!.querySelector("span")!.textContent).toBe("daemon v1 predates Live and Processes");
    expect(updateButton().textContent).toBe("updating");
    expect(updateButton().disabled).toBe(true);
    fireEvent.click(updateButton());
    expect(updateDaemon).toHaveBeenCalledTimes(1);
    act(() => provideDaemonHello("ws_a", { root: "/root", version: 2 }));
    expect(updateLine()).toBeNull();
  });

  it("after a remount the bound still counts from when the runtime finished, not from the remount", async () => {
    const api = await mount([view("ws_a", "api")]);
    (api as Api).updateDaemon = vi.fn(async (_id: string) => {});
    act(() => provideDaemonHello("ws_a", { root: "/root", version: 1 }));
    vi.useFakeTimers();
    fireEvent.click(updateButton());
    await act(async () => {});
    act(() => vi.advanceTimersByTime(20_000));
    cleanup();
    render(<MachineSurface workspaceId="ws_a" />);
    await act(async () => {});
    expect(updateButton().textContent).toBe("updating");
    act(() => vi.advanceTimersByTime(DAEMON_HELLO_WAIT_MS - 20_000 - 1));
    expect(updateButton().textContent).toBe("updating");
    act(() => vi.advanceTimersByTime(1));
    expect(updateButton().textContent).toBe("update");
    expect(updateButton().disabled).toBe(false);
    expect(updateLine()!.querySelector("span")!.getAttribute("title")).toBe("daemon v1 predates Live and Processes");
  });

  it("the keycap reads updating while the runtime redeploys, and a refusal takes the line's place", async () => {
    const api = await mount([view("ws_a", "api")]);
    let settle!: (e?: Error) => void;
    (api as Api).updateDaemon = vi.fn((_id: string) => new Promise<void>((resolve, reject) => (settle = e => (e ? reject(e) : resolve()))));
    act(() => provideDaemonHello("ws_a", { root: "/root", version: 1 }));
    fireEvent.click(updateButton());
    await waitFor(() => expect(updateButton().textContent).toBe("updating"));
    expect(updateButton().disabled).toBe(true);
    act(() => settle(new Error("daemon deploy failed: NPM_FAIL")));
    await waitFor(() => expect(updateLine()!.querySelector("span")!.textContent).toBe("daemon deploy failed: NPM_FAIL"));
    expect(updateButton().disabled).toBe(false);
    expect(updateButton().textContent).toBe("update");
  });

  it("a client without the update op says so instead of offering nothing", async () => {
    await mount([view("ws_a", "api")]);
    act(() => provideDaemonHello("ws_a", { root: "/root", version: 1 }));
    fireEvent.click(updateButton());
    await waitFor(() => expect(updateLine()!.querySelector("span")!.textContent).toBe("This client cannot update daemons."));
  });

  it("a napping workspace shows no update line: its daemon is not running to replace", async () => {
    await mount([view("ws_a", "api", "napping")]);
    act(() => provideDaemonHello("ws_a", { root: "/root", version: 1 }));
    expect(updateLine()).toBeNull();
  });
});
