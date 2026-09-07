// SPDX-License-Identifier: AGPL-3.0-only
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { cloneElement, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DAEMON_VERSION } from "@wsp/protocol";
import type {
  Capabilities,
  EventUnion,
  GoldenMissingTool,
  ProjectGolden,
  SnapshotLineage,
  SnapshotRollbackResult,
  SysSample,
  WorkspacePhase,
  WorkspaceSize,
  WorkspaceStatus,
  WorkspaceView,
} from "@wsp/protocol";
import { MachineSurface } from "../src/components/machine/MachineSurface.js";
import { provideDaemonHello } from "../src/files/wire.js";
import { getLive, resetLive } from "../src/machine/live.js";
import type { Api } from "../src/protocol/client.js";
import { useStore } from "../src/protocol/store.js";
import { statusOf } from "./workspace-status.js";

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

const status = statusOf;

const costEvent = (workspaceId: string, rate: number, awakeMs: number, at: string): EventUnion => ({
  type: "workspace.cost",
  workspaceId,
  phase: "running",
  rateUsdPerHour: rate,
  awakeMs,
  accruedUsd: (rate * awakeMs) / 3_600_000,
  at,
});

const CAPS: Capabilities = {
  liveCloneForks: true,
  ramPreservingPause: true,
  resize: true,
  previewUrls: true,
  signedUrls: true,
  containers: true,
  callbackRelay: true,
  snapshotListing: true,
  sizes: [
    { cpu: 2, memMb: 4096, rateUsdPerHour: 0.11 },
    { cpu: 4, memMb: 8192, rateUsdPerHour: 0.22 },
    { cpu: 4, memMb: 16384, rateUsdPerHour: 0.3 },
    { cpu: 8, memMb: 16384, rateUsdPerHour: 0.44 },
    { cpu: 16, memMb: 32768, rateUsdPerHour: 0.88 },
  ],
};
const EMPTY_LINEAGE: SnapshotLineage = { name: "default", head: null, versions: [] };

// The surface's cost series listens through api.subscribe like the store does,
// so tests push events through the same channel.
function fakeApi(workspaces: WorkspaceView[], capabilities: Capabilities = CAPS, lineage: SnapshotLineage = EMPTY_LINEAGE, history?: EventUnion[], projects: ProjectGolden[] = []) {
  const listeners = new Set<(e: EventUnion) => void>();
  let current = lineage;
  const api: Api & {
    emit(e: EventUnion): void;
    nap: ReturnType<typeof vi.fn<(id: string) => Promise<WorkspaceView>>>;
    wake: ReturnType<typeof vi.fn<(id: string) => Promise<WorkspaceView>>>;
    upgrade: ReturnType<typeof vi.fn<(id: string, size: WorkspaceSize) => Promise<WorkspaceView>>>;
    updateImage: ReturnType<typeof vi.fn<(id: string) => Promise<WorkspaceView>>>;
    rollbackSnapshot: ReturnType<typeof vi.fn<(version: number, name?: string) => Promise<SnapshotRollbackResult>>>;
    listSnapshots: ReturnType<typeof vi.fn<() => Promise<SnapshotLineage>>>;
    listProjectGoldens: ReturnType<typeof vi.fn<() => Promise<ProjectGolden[]>>>;
    snapshotWorkspace: ReturnType<typeof vi.fn<(id: string) => Promise<ProjectGolden>>>;
    createWorkspace: ReturnType<typeof vi.fn<(golden: string, name?: string) => Promise<WorkspaceView>>>;
  } = {
    listProjectGoldens: vi.fn<() => Promise<ProjectGolden[]>>(async () => projects),
    snapshotWorkspace: vi.fn<(id: string) => Promise<ProjectGolden>>(async id => {
      const taken = pg("snap_taken", "snap_golden-v12", { workspaceId: id, createdAt: "2026-09-07T08:00:00.000Z" });
      projects = [...projects, taken];
      return taken;
    }),
    upgrade: vi.fn(async (id: string, _size: WorkspaceSize) => view(id, "?", "running")),
    updateImage: vi.fn(async (id: string) => ({ ...view(id, "?", "running"), golden: `snap_golden-v${current.head ?? 0}` })),
    capabilities: vi.fn(async () => capabilities),
    portReach: vi.fn(async (_id: string, port: number) => ({ url: `https://m1-${port}.preview.example/?pt_token=e`, expiresAt: Date.now() + 3_600_000 })),
    daemonReach: vi.fn(async () => ({ url: "ws://127.0.0.1:1", expiresAt: 0 })),
    startSession: vi.fn(async (o: { workspaceId: string }) => ({ id: "s1", workspaceId: o.workspaceId, harness: "claude", status: "running" as const })),
    sessionHistory: vi.fn(async () => []),
    listSnapshots: vi.fn<() => Promise<SnapshotLineage>>(async () => current),
    snapshotStorage: async () => null,
    ...(history !== undefined ? { costHistory: async () => history.filter((e): e is EventUnion & { type: "workspace.cost" } => e.type === "workspace.cost") } : {}),
    rollbackSnapshot: vi.fn(async (version: number) => {
      current = { ...current, head: version };
      return { lineage: current, existingWorkspaces: "untouched" as const };
    }),
    listWorkspaces: vi.fn(async () => workspaces),
    getWorkspace: vi.fn(async id => workspaces.find(w => w.id === id)!),
    createWorkspace: vi.fn<(golden: string, name?: string) => Promise<WorkspaceView>>(async () => workspaces[0]!),
    createFromGoldenHead: vi.fn(async (name: string) => view("ws_new", name)),
    watchStatuses: vi.fn(async () => workspaces.map(w => status(w))),
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

async function mount(workspaces: WorkspaceView[], capabilities: Capabilities = CAPS, lineage: SnapshotLineage = EMPTY_LINEAGE, history?: EventUnion[], projects?: ProjectGolden[]) {
  const api = fakeApi(workspaces, capabilities, lineage, history, projects);
  useStore.getState().bind(api);
  render(<MachineSurface workspaceId={workspaces[0]!.id} />);
  await waitFor(() => expect(useStore.getState().ready).toBe(true));
  await waitFor(() => expect(useStore.getState().capabilities).not.toBeNull());
  await waitFor(() => expect(fact("size")).toBe("2 vCPU · 4 GB"));
  return api;
}

const fact = (k: string): string => document.querySelector(`[data-k="${k}"]`)?.textContent ?? "";
/** The state words on the lineage row titled by `k`, the row's own and not those of the rows under it. */
const marks = (k: string): string[] => [...(document.querySelector(`[data-k="${k}"]`)?.closest("li")?.querySelectorAll(":scope > span [data-mark]") ?? [])].map(el => el.textContent ?? "");

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

const PROJECT = { name: "proj", dest: "/root/work/proj", importedAt: "2026-09-06T10:01:00.000Z" };
const pg = (snapshotId: string, golden: string, over: Partial<ProjectGolden> = {}): ProjectGolden => ({
  snapshotId,
  project: PROJECT,
  golden,
  version: Number(golden.slice(-2)),
  workspaceId: "ws_a",
  workspaceName: "api",
  createdAt: "2026-09-06T10:06:00.000Z",
  ...over,
});

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

  it("the footer's phase button reads one entry: a record still saying running while the machine is paused reads and labels Wake, and one whose machine is starting reads Waking and refuses", async () => {
    const w = view("ws_a", "api");
    const api = await mount([w]);
    act(() => api.emit({ type: "workspace.status", status: { ...status(w), machineState: "paused", reach: { state: "napping" } } }));
    const wake = (await screen.findByRole("button", { name: "Wake api" })) as HTMLButtonElement;
    expect(wake.textContent).toBe("Wake");
    expect(wake.disabled).toBe(false);
    expect(wake.title).toBe("Boot the VM from its disk");
    act(() => api.emit({ type: "workspace.status", status: { ...status(w), machineState: "starting" } }));
    await waitFor(() => expect((screen.getByRole("button", { name: "Wake api" }) as HTMLButtonElement).textContent).toBe("Waking…"));
    const waking = screen.getByRole("button", { name: "Wake api" }) as HTMLButtonElement;
    expect(waking.disabled).toBe(true);
    expect(waking.title).toBe("Workspace is waking");
  });

  it("renders napping as Paused and waking as Waking with the wake control held", async () => {
    await mount([view("ws_a", "api", "napping")]);
    expect(fact("state")).toBe("Paused");
    expect(screen.getByRole("button", { name: "Wake api" })).toBeDefined();
    act(() => useStore.getState().applyEvent({ type: "workspace.woken", workspaceId: "ws_a", machineId: "m2", resurrected: false }));
    // The store moves the record and its status together on every phase change, so the test moves both.
    act(() => useStore.setState(s => ({ workspaces: s.workspaces.map(w => ({ ...w, phase: "waking" as const })), statuses: { ...s.statuses, ws_a: { ...s.statuses["ws_a"]!, phase: "waking" as const } } })));
    expect(fact("state")).toBe("Waking");
    expect((screen.getByRole("button", { name: "Wake api" }) as HTMLButtonElement).disabled).toBe(true);
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
  const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const clockToSecond = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const T0 = Date.UTC(2026, 8, 5, 6, 0);
  const at = (minutes: number) => T0 + minutes * 60_000;
  const point = (minutes: number, rate: number, accruedUsd: number): EventUnion => ({
    type: "workspace.cost",
    workspaceId: "ws_a",
    phase: rate > 0 ? "running" : "napping",
    rateUsdPerHour: rate,
    awakeMs: Math.round((accruedUsd / 0.11) * 3_600_000),
    accruedUsd,
    at: new Date(at(minutes)).toISOString(),
  });
  // Three hours the runtime metered before the tab opened: two running at $0.11/hr, then one napping.
  const HISTORY = [point(0, 0.11, 0), point(120, 0.11, 0.22), point(121, 0, 0.22), point(180, 0, 0.22)];
  const axis = (which: "x" | "y") => [...document.querySelectorAll(`[data-usage-axis=${which}] span`)].map(el => el.textContent);
  const toggle = (name: string) => screen.getByRole("button", { name });

  it("shows the live rate and accrued total", async () => {
    const api = await mount([view("ws_a", "api")]);
    act(() => api.emit(costEvent("ws_a", 0.11, 60_000, "2026-09-01T00:01:00Z")));
    await waitFor(() => expect(fact("rate")).toBe("$0.110/hr"));
    expect(fact("accrued")).toBe("$0.0018");
  });

  it("starts with a quiet empty state and draws the accrued total as one line from the first tick, never bars", async () => {
    const api = await mount([view("ws_a", "api")]);
    expect(screen.getByText("No cost yet")).toBeDefined();
    expect(document.querySelector("[data-usage-chart] svg")).toBeNull();
    act(() => api.emit(costEvent("ws_a", 0.11, 60_000, "2026-09-01T00:01:00Z")));
    await waitFor(() => expect(document.querySelector("[data-usage-line]")).not.toBeNull());
    expect(screen.queryByText("No cost yet")).toBeNull();
    const chart = document.querySelector("[data-usage-chart]")!;
    expect(chart.querySelectorAll("rect")).toHaveLength(0);
    expect(chart.querySelectorAll("[data-usage-bar]")).toHaveLength(0);
    expect(chart.querySelector("[data-usage-line]")!.tagName.toLowerCase()).toBe("path");
    expect(chart.querySelector("[data-usage-area]")).not.toBeNull();
    expect(chart.querySelector("[data-k=usage-end]")).not.toBeNull();
    // One tick still reads as a minute of axis, not a window collapsed to a point, and ticks under a minute apart carry
    // seconds so no two labels read alike.
    const t1 = Date.parse("2026-09-01T00:01:00Z");
    expect(axis("x")).toEqual([clockToSecond(t1 - 60_000), clockToSecond(t1 - 40_000), clockToSecond(t1 - 20_000), clockToSecond(t1)]);
    expect(new Set(axis("x")).size).toBe(4);
    expect(fact("usage-readout")).toBe(`tracked since ${clockToSecond(t1)}`);
  });

  it("reads the workspace's history from the runtime and spans all of it by default, with hour and day toggles", async () => {
    await mount([view("ws_a", "api")], CAPS, EMPTY_LINEAGE, HISTORY);
    await waitFor(() => expect(document.querySelector("[data-usage-line]")).not.toBeNull());
    expect(toggle("all").getAttribute("aria-pressed")).toBe("true");
    expect(axis("x")).toEqual([clock(at(0)), clock(at(60)), clock(at(120)), clock(at(180))]);
    // A round ceiling just above the total, labelled to the step.
    expect(axis("y")).toEqual(["$0.30", "$0.20", "$0.10", "$0.00"]);
    expect(fact("usage-readout")).toBe(`tracked since ${clock(at(0))}`);
    expect(screen.queryByText(/peak/)).toBeNull();

    fireEvent.click(toggle("hour"));
    expect(toggle("hour").getAttribute("aria-pressed")).toBe("true");
    expect(toggle("all").getAttribute("aria-pressed")).toBe("false");
    expect(axis("x")).toEqual([clock(at(120)), clock(at(140)), clock(at(160)), clock(at(180))]);

    fireEvent.click(toggle("day"));
    expect(axis("x")).toEqual([clock(at(180 - 1440)), clock(at(180 - 960)), clock(at(180 - 480)), clock(at(180))]);
    // The series began inside the day: the line starts where the data does, the axis stays the whole day.
    const d = document.querySelector("[data-usage-line]")!.getAttribute("d")!;
    expect(Number(d.slice(1).split(" ")[0])).toBeCloseTo(100 * (1 - 180 / 1440), 0);
  });

  it("a live tick extends the line and the axis to the newest moment", async () => {
    const api = await mount([view("ws_a", "api")], CAPS, EMPTY_LINEAGE, HISTORY);
    await waitFor(() => expect(axis("x").at(-1)).toBe(clock(at(180))));
    act(() => api.emit(point(190, 0.11, 0.23)));
    expect(axis("x").at(-1)).toBe(clock(at(190)));
    expect(fact("usage-readout")).toBe(`tracked since ${clock(at(0))}`);
  });

  it("hovering reads the total, the rate and the moment under the pointer; leaving returns to the span", async () => {
    await mount([view("ws_a", "api")], CAPS, EMPTY_LINEAGE, HISTORY);
    await waitFor(() => expect(document.querySelector("[data-usage-line]")).not.toBeNull());
    const svg = document.querySelector<SVGSVGElement>("[data-usage-chart] svg")!;
    svg.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 300, bottom: 96, width: 300, height: 96, toJSON: () => ({}) });
    fireEvent.mouseMove(svg, { clientX: 100, clientY: 30 });
    expect(fact("usage-readout")).toBe(`$0.1100 · $0.110/hr · ${clock(at(60))}`);
    expect(svg.querySelector("[data-usage-hover]")).not.toBeNull();
    fireEvent.mouseMove(svg, { clientX: 250, clientY: 30 });
    expect(fact("usage-readout")).toBe(`$0.2200 · $0.000/hr · ${clock(at(150))}`);
    fireEvent.mouseLeave(svg);
    expect(fact("usage-readout")).toBe(`tracked since ${clock(at(0))}`);
    expect(svg.querySelector("[data-usage-hover]")).toBeNull();
  });

  it("keeps each workspace's series separate", async () => {
    const api = await mount([view("ws_a", "api"), view("ws_b", "web")]);
    act(() => {
      api.emit(costEvent("ws_b", 0.44, 60_000, "2026-09-01T00:01:00Z"));
      api.emit(costEvent("ws_b", 0.44, 120_000, "2026-09-01T00:02:00Z"));
    });
    expect(document.querySelector("[data-usage-line]")).toBeNull();
    expect(screen.getByText("No cost yet")).toBeDefined();
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
    await waitFor(() => expect(marks("v12")).toEqual(["head", "this fork"]));
    expect(fact("v11")).toBe("v11");
    expect(marks("v11")).toEqual([]);
    expect(document.querySelector("[data-slot='badge']")).toBeNull();
    const word = document.querySelector("[data-mark='head']")!;
    expect(word.className).toContain("font-mono");
    expect(word.className).toContain("text-muted-foreground");
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
    await waitFor(() => expect(marks("v12")).toEqual(["head", "this fork"]));
    const lists = document.querySelectorAll("[data-k='missing-tools']");
    expect(lists).toHaveLength(1);
    expect(lists[0]!.closest("li")?.querySelector("[data-k='v12']")).not.toBeNull();
    expect(lists[0]!.querySelector("p")?.textContent).toBe("not on this image");
    const rows = [...lists[0]!.querySelectorAll("li")].map(li => [li.querySelector("[data-k='missing-tool']")?.textContent, li.querySelector("[data-k='missing-note']")?.textContent, li.querySelector("[data-mark]")?.textContent]);
    expect(rows).toEqual([
      ["gopls", "no Linux bottle", "skipped"],
      ["Homebrew", "git: not found", "failed"],
    ]);
    expect(screen.queryByText("Raycast")).toBeNull();
  });

  it("a base floor row that failed is a named row like any tool's: its name, the reason beside it, the outcome as its mark", async () => {
    const docker = { id: "base/docker", name: "Docker engine and compose", outcome: "failed" as const, note: "E: Unable to locate package docker-compose-v2" };
    const lineage: SnapshotLineage = { name: "default", head: 12, versions: [gv(11), { ...gv(12), missingTools: [docker] }] };
    await mount([onV12()], CAPS, lineage);
    await waitFor(() => expect(marks("v12")).toEqual(["head", "this fork"]));
    const row = document.querySelector("[data-k='missing-tools'] li")!;
    expect(row.querySelector("[data-k='missing-tool']")?.textContent).toBe("Docker engine and compose");
    expect(row.querySelector("[data-k='missing-note']")?.textContent).toBe("E: Unable to locate package docker-compose-v2");
    expect(row.querySelector("[data-mark]")?.textContent).toBe("failed");
    expect(row.textContent).toBe("Docker engine and composeE: Unable to locate package docker-compose-v2failed");
    expect(document.querySelector("[data-slot='badge']")).toBeNull();
  });

  it("names the shell calls the forked version silenced, once and under that version alone", async () => {
    const lineage: SnapshotLineage = { name: "default", head: 12, versions: [{ ...gv(11), silenced: ["fzf"] }, { ...gv(12), silenced: ["starship", "eza", "diskbloom"] }] };
    await mount([onV12()], CAPS, lineage);
    await waitFor(() => expect(marks("v12")).toEqual(["head", "this fork"]));
    const lines = document.querySelectorAll("[data-k='silenced']");
    expect(lines).toHaveLength(1);
    expect(lines[0]!.closest("li")?.querySelector("[data-k='v12']")).not.toBeNull();
    expect(lines[0]!.textContent).toBe("silenced in the shell starship, eza, diskbloom");
    expect(screen.queryByText("fzf")).toBeNull();
  });

  it("names the forked version's shell noise on one line, under that version alone", async () => {
    const lineage: SnapshotLineage = { name: "default", head: 12, versions: [{ ...gv(11), shellNoise: "old noise, 1 line" }, { ...gv(12), shellNoise: "zsh: command not found: starship, 2 lines" }] };
    await mount([onV12()], CAPS, lineage);
    await waitFor(() => expect(marks("v12")).toEqual(["head", "this fork"]));
    const lines = document.querySelectorAll("[data-k='shell-noise']");
    expect(lines).toHaveLength(1);
    expect(lines[0]!.closest("li")?.querySelector("[data-k='v12']")).not.toBeNull();
    expect(lines[0]!.textContent).toBe("shell noise zsh: command not found: starship, 2 lines");
    expect(screen.queryByText(/old noise/)).toBeNull();
  });

  it("a record sealed without a name or an outcome still reads: its id in the name cell and failed as its mark", async () => {
    const bare = { id: "base/docker", note: "E: Unable to locate package docker-compose-v2" } as unknown as GoldenMissingTool;
    const lineage: SnapshotLineage = { name: "default", head: 12, versions: [gv(11), { ...gv(12), missingTools: [bare] }] };
    await mount([onV12()], CAPS, lineage);
    await waitFor(() => expect(marks("v12")).toEqual(["head", "this fork"]));
    const row = document.querySelector("[data-k='missing-tools'] li")!;
    expect(row.querySelector("[data-k='missing-tool']")?.textContent).toBe("base/docker");
    expect(row.querySelector("[data-k='missing-note']")?.textContent).toBe("E: Unable to locate package docker-compose-v2");
    expect(row.querySelector("[data-mark]")?.textContent).toBe("failed");
  });

  it("two missing tools sharing a label are two rows keyed apart", async () => {
    const missing = [
      { id: "tools/brew/gh", name: "gh", outcome: "skipped" as const, note: "no Linux bottle" },
      { id: "tools/cli/gh", name: "gh", outcome: "failed" as const, note: "curl: not found" },
    ];
    const lineage: SnapshotLineage = { name: "default", head: 12, versions: [gv(11), { ...gv(12), missingTools: missing }] };
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await mount([onV12()], CAPS, lineage);
    await waitFor(() => expect(marks("v12")).toEqual(["head", "this fork"]));
    const rows = [...document.querySelectorAll("[data-k='missing-tools'] li")].map(li => li.querySelector("[data-k='missing-note']")?.textContent);
    expect(rows).toEqual(["no Linux bottle", "curl: not found"]);
    expect([...document.querySelectorAll("[data-k='missing-tools'] [data-mark]")].map(el => el.textContent)).toEqual(["skipped", "failed"]);
    expect(errors.mock.calls.map(c => String(c[0]))).not.toContainEqual(expect.stringContaining("same key"));
    errors.mockRestore();
  });

  it("a version that recorded no missing tools gets no list and no label", async () => {
    await mount([onV12()], CAPS, twoVersions);
    await waitFor(() => expect(marks("v12")).toEqual(["head", "this fork"]));
    expect(document.querySelector("[data-k='missing-tools']")).toBeNull();
    expect(screen.queryByText("not on this image")).toBeNull();
  });

  it("lists what the pack left off the forked version's image under its own label, the file beside each note, under that version alone", async () => {
    const leftBehind = [
      { id: "agents/claude", path: "~/.claude/settings.json", note: "hook left behind: /opt/homebrew/bin/terminal-notifier" },
      { id: "agents/claude", path: "~/.claude/settings.json", note: "hook left behind: ~/.claude/hooks/gone" },
    ];
    const lineage: SnapshotLineage = { name: "default", head: 12, versions: [{ ...gv(11), leftBehind: [{ id: "agents/claude", path: "~/.claude/settings.json", note: "hook left behind: ~/old" }] }, { ...gv(12), leftBehind }] };
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await mount([onV12()], CAPS, lineage);
    await waitFor(() => expect(marks("v12")).toEqual(["head", "this fork"]));
    const lists = document.querySelectorAll("[data-k='left-behind']");
    expect(lists).toHaveLength(1);
    expect(lists[0]!.closest("li")?.querySelector("[data-k='v12']")).not.toBeNull();
    expect(lists[0]!.querySelector("p")?.textContent).toBe("left on this computer");
    const rows = [...lists[0]!.querySelectorAll("li")].map(li => [li.querySelector("[data-k='left-path']")?.textContent, li.querySelector("[data-k='left-note']")?.textContent]);
    expect(rows).toEqual([
      ["~/.claude/settings.json", "hook left behind: /opt/homebrew/bin/terminal-notifier"],
      ["~/.claude/settings.json", "hook left behind: ~/.claude/hooks/gone"],
    ]);
    expect(screen.queryByText("hook left behind: ~/old")).toBeNull();
    expect(document.querySelector("[data-k='missing-tools']")).toBeNull();
    expect(errors.mock.calls.map(c => String(c[0]))).not.toContainEqual(expect.stringContaining("same key"));
    errors.mockRestore();
  });

  it("a version that recorded nothing left behind gets no such list", async () => {
    await mount([onV12()], CAPS, twoVersions);
    await waitFor(() => expect(marks("v12")).toEqual(["head", "this fork"]));
    expect(document.querySelector("[data-k='left-behind']")).toBeNull();
    expect(screen.queryByText("left on this computer")).toBeNull();
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
    await waitFor(() => expect(marks("v11")).toEqual(["head"]));
    expect(marks("v12")).toEqual(["this fork"]);
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
    expect(marks("v12")).toEqual(["head", "this fork"]);
  });

  it("refetches the lineage when a golden seals", async () => {
    const api = await mount([onV12()], CAPS, twoVersions);
    await screen.findByRole("button", { name: "roll back to v11" });
    expect(api.listSnapshots).toHaveBeenCalledTimes(1);
    api.listSnapshots.mockResolvedValueOnce({ name: "default", head: 13, versions: [gv(11), gv(12), gv(13)] });
    act(() => api.emit({ type: "golden.stage", name: "default", stage: "snapshotting" }));
    expect(api.listSnapshots).toHaveBeenCalledTimes(1);
    act(() => api.emit({ type: "golden.stage", name: "default", stage: "sealed" }));
    await waitFor(() => expect(marks("v13")).toEqual(["head"]));
    expect(api.listSnapshots).toHaveBeenCalledTimes(2);
  });
});

describe("a workspace behind the golden's head", () => {
  const onV11 = (): WorkspaceView => ({ ...view("ws_a", "api"), golden: "snap_golden-v11" });

  it("says which version it is on and which is available, on its own row, and offers the move there instead of a rollback", async () => {
    const api = await mount([onV11()], CAPS, twoVersions);
    await waitFor(() => expect(marks("v11")).toEqual(["this fork"]));
    const row = document.querySelector("[data-k='v11']")!.closest("li")!;
    expect(row.textContent).toContain("on image v11, v12 available");
    // Two different actions, both on that row: Update moves this workspace, Roll back moves the head for every
    // fork after it. Neither may take the other's place.
    expect(within(row as HTMLElement).getByRole("button", { name: "update api to v12" })).toBeDefined();
    expect(within(row as HTMLElement).getByRole("button", { name: "roll back to v11" })).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "update api to v12" }));
    await waitFor(() => expect(fact("lineage-note")).toBe("api is on v12. Its files came across; anything running in it stopped with the old machine."));
    expect(api.updateImage.mock.calls).toEqual([["ws_a"]]);
  });

  it("the moved workspace is the one the rail holds: the row follows to the head and the offer goes", async () => {
    await mount([onV11()], CAPS, twoVersions);
    await waitFor(() => expect(marks("v11")).toEqual(["this fork"]));
    fireEvent.click(screen.getByRole("button", { name: "update api to v12" }));
    await waitFor(() => expect(marks("v12")).toEqual(["head", "this fork"]));
    expect(fact("v11")).toBe("v11");
    expect(useStore.getState().workspaces[0]!.golden).toBe("snap_golden-v12");
    expect(screen.queryByRole("button", { name: /^update api to/ })).toBeNull();
  });

  it.each([
    ["napping" as const, "api is paused; wake it to move it to a newer image"],
    ["gone" as const, "api's machine is gone; rebuild it to move it to a newer image"],
  ])("a %s workspace is not moved: the button is dead and the row says why, since the move replaces the machine", async (phase, why) => {
    await mount([{ ...onV11(), phase }], CAPS, twoVersions);
    await waitFor(() => expect(marks("v11")).toEqual(["this fork"]));
    expect(screen.getByRole("button", { name: "update api to v12" })).toHaveProperty("disabled", true);
    expect(fact("lineage-note")).toBe(why);
    // Roll back is the golden's action, not this workspace's, so a stopped machine never takes it away.
    expect(screen.getByRole("button", { name: "roll back to v11" })).toHaveProperty("disabled", false);
  });

  it("a workspace forked from a project image is not moved, and one that imported a project onto a plain fork still is", async () => {
    const onProject = { ...view("ws_a", "api"), golden: "snap_taken" };
    const lineage: SnapshotLineage = { name: "default", head: 12, versions: [gv(11), gv(12)] };
    await mount([onProject], CAPS, lineage, undefined, [pg("snap_taken", "snap_golden-v11")]);
    await waitFor(() => expect(screen.queryByRole("button", { name: /^update api to/ })).toBeNull());

    cleanup();
    // The runtime looks at the image it forked from, not at what was imported into it afterwards; so does this.
    await mount([{ ...onV11(), project: PROJECT }], CAPS, twoVersions);
    await waitFor(() => expect(marks("v11")).toEqual(["this fork"]));
    expect(screen.getByRole("button", { name: "update api to v12" })).toHaveProperty("disabled", false);
  });

  it("a workspace on the head is offered nothing to move to", async () => {
    await mount([onV12()], CAPS, twoVersions);
    await waitFor(() => expect(marks("v12")).toEqual(["head", "this fork"]));
    expect(screen.queryByRole("button", { name: /^update api to/ })).toBeNull();
    expect(document.body.textContent).not.toContain("available");
  });

  it("a client that cannot move a workspace shows the state and no button", async () => {
    // The op is gone before the first render, so no render ever offers a button whose call would throw.
    const api = fakeApi([onV11()], CAPS, twoVersions);
    delete (api as { updateImage?: unknown }).updateImage;
    useStore.getState().bind(api);
    render(<MachineSurface workspaceId="ws_a" />);
    await waitFor(() => expect(marks("v11")).toEqual(["this fork"]));
    expect(document.querySelector("[data-k='v11']")!.closest("li")!.textContent).toContain("on image v11, v12 available");
    expect(screen.queryByRole("button", { name: /^update api to/ })).toBeNull();
    expect(screen.getByRole("button", { name: "roll back to v11" })).toBeDefined();
  });

  it("a failed move leaves the note with the reason and the workspace where it was", async () => {
    const api = await mount([onV11()], CAPS, twoVersions);
    api.updateImage.mockRejectedValueOnce(new Error("at cap"));
    await waitFor(() => expect(marks("v11")).toEqual(["this fork"]));
    fireEvent.click(screen.getByRole("button", { name: "update api to v12" }));
    await waitFor(() => expect(fact("lineage-note")).toBe("at cap"));
  });

  it("lists what a version retired under a micro-label, under the forked version alone", async () => {
    const retired = [{ id: "tools/brew/yq", name: "yq" }, { id: "shell/zshrc", name: "~/.zshrc" }];
    const lineage: SnapshotLineage = { name: "default", head: 12, versions: [gv(11), { ...gv(12), retired }] };
    await mount([onV12()], CAPS, lineage);
    await waitFor(() => expect(marks("v12")).toEqual(["head", "this fork"]));
    const lists = document.querySelectorAll("[data-k='retired-rows']");
    expect(lists).toHaveLength(1);
    expect(lists[0]!.querySelector("p")?.textContent).toBe("retired, still on this image");
    expect([...lists[0]!.querySelectorAll("[data-k='retired-row']")].map(el => el.textContent)).toEqual(["yq", "~/.zshrc"]);
  });
});

describe("project goldens in the lineage", () => {
  const goldens = [pg("snap_p1", "snap_golden-v12"), pg("snap_p2", "snap_golden-v12", { createdAt: "2026-09-06T11:00:00.000Z", workspaceName: "task-a", workspaceId: "ws_b" }), pg("snap_p3", "snap_golden-v11")];
  const rowsUnder = (version: string): string[] => [...document.querySelectorAll(`[data-k='${version}']`)[0]!.closest("li")!.querySelectorAll("[data-k^='pg-']")].map(el => el.getAttribute("data-k")!);

  it("lists each project golden under the version it stands on, newest first, marks the one this workspace forks from, and a fork creates a workspace from its snapshot", async () => {
    const api = await mount([{ ...view("ws_a", "api"), golden: "snap_p2", project: PROJECT }], CAPS, twoVersions, undefined, goldens);
    await waitFor(() => expect(rowsUnder("v12")).toEqual(["pg-snap_p2", "pg-snap_p1"]));
    expect(rowsUnder("v11")).toEqual(["pg-snap_p3"]);
    expect(marks("v12")).toEqual(["head"]);
    expect(marks("pg-snap_p2")).toEqual(["this fork"]);
    expect(marks("pg-snap_p1")).toEqual([]);
    expect(screen.getByText("snapshot 2026-09-06 · imported 2026-09-06 · from task-a")).toBeDefined();
    expect(screen.getByText("forked 2026-08-30 · proj imported 2026-09-06")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "fork proj from snap_p1" }));
    await waitFor(() => expect(api.createWorkspace).toHaveBeenCalledWith("snap_p1", "proj-fork", undefined));
    expect(api.createFromGoldenHead).not.toHaveBeenCalled();
  });

  it("without any project golden the versions render as before and nothing is listed under them", async () => {
    await mount([onV12()], CAPS, twoVersions);
    await waitFor(() => expect(marks("v12")).toEqual(["head", "this fork"]));
    expect(document.querySelector("[data-k^='pg-']")).toBeNull();
    expect(screen.queryByRole("button", { name: /^snapshot / })).toBeNull();
  });

  it("snapshot sits on the live disk row once a project is loaded: it calls the api, lists the new golden and says what it is for; a refusal shows the runtime's sentence", async () => {
    const api = await mount([{ ...onV12(), project: PROJECT }], CAPS, twoVersions);
    await waitFor(() => expect(marks("v12")).toEqual(["head", "this fork"]));
    expect(api.listProjectGoldens).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "snapshot api as a project golden" }));
    await waitFor(() => expect(api.snapshotWorkspace).toHaveBeenCalledWith("ws_a"));
    await waitFor(() => expect(rowsUnder("v12")).toEqual(["pg-snap_taken"]));
    expect(api.listProjectGoldens).toHaveBeenCalledTimes(2);
    expect(fact("lineage-note")).toBe("Project golden of proj taken. New forks of it start with the project.");

    api.snapshotWorkspace.mockRejectedValueOnce(new Error("snapshot of api refused: machine m1 is not first-life (it was resumed); snapshots only come from fresh machines"));
    fireEvent.click(screen.getByRole("button", { name: "snapshot api as a project golden" }));
    await waitFor(() => expect(fact("lineage-note")).toBe("snapshot of api refused: machine m1 is not first-life (it was resumed); snapshots only come from fresh machines"));
    expect(rowsUnder("v12")).toEqual(["pg-snap_taken"]);
  });
});

describe("gone machines", () => {
  const gone = (): WorkspaceView => ({ ...view("ws_a", "api", "gone"), gone: "machine m_ws_a_0123456789abcdef is gone at the provider: Not found" });

  it("the footer offers forget in place of pause and holds upgrade; confirming names what goes and calls the api once", async () => {
    const api = await mount([gone()]);
    const forget = vi.fn(async (_id: string) => {});
    api.forget = forget;
    const forgetButton = await screen.findByRole("button", { name: "Forget api" });
    expect(screen.queryByRole("button", { name: "Pause api" })).toBeNull();
    expect((screen.getByRole("button", { name: "upgrade api" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(forgetButton);
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("Forget api?");
    expect(dialog.textContent).toContain("Its record and 0 threads leave this computer; the machine is already gone.");
    expect(forget).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Forget" }));
    await waitFor(() => expect(forget).toHaveBeenCalledTimes(1));
    expect(forget).toHaveBeenCalledWith("ws_a");
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });

  it("a record still saying running whose status found the machine gone reads no rate and no nap countdown, whatever the status and the last cost event carry", async () => {
    const w = view("ws_a", "api");
    const api = await mount([w], CAPS, EMPTY_LINEAGE, [costEvent("ws_a", 0.11, 60_000, new Date().toISOString())]);
    act(() => api.emit({ type: "workspace.status", status: { ...status(w), machineState: "gone", reach: { state: "gone" }, idleAt: Date.now() + 17 * 60_000, rateUsdPerHour: 0.11, reason: "machine m_ws_a is gone at the provider: the status poll found it gone at 2026-09-06T10:21:04Z" } }));
    await waitFor(() => expect(fact("reason")).toContain("the status poll found it gone"));
    expect(fact("idle")).toBe("not scheduled");
    expect(fact("rate")).toBe("$0.000/hr");
  });

  it("the host's refusal shows in the dialog, which stays open", async () => {
    const api = await mount([gone()]);
    const reason = "api's machine m_ws_a is still running; pause it or delete it at the provider first";
    api.forget = vi.fn(async (_id: string) => {
      throw new Error(reason);
    });
    fireEvent.click(await screen.findByRole("button", { name: "Forget api" }));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Forget" }));
    await waitFor(() => expect(fact("forget-refusal")).toBe(reason));
    expect(screen.getByRole("alertdialog")).toBeDefined();
  });
});

describe("pause and wake", () => {
  it("pause paints the phase immediately and calls the api once", async () => {
    const api = await mount([view("ws_a", "api")]);
    fireEvent.click(screen.getByRole("button", { name: "Pause api" }));
    expect(useStore.getState().workspaces[0]!.phase).toBe("pausing");
    expect(fact("state")).toBe("Pausing");
    const held = screen.getByRole("button", { name: "Wake api" }) as HTMLButtonElement;
    expect(held.textContent).toBe("Pausing…");
    expect(held.disabled).toBe(true);
    await waitFor(() => expect(api.nap).toHaveBeenCalledTimes(1));
    expect(api.nap).toHaveBeenCalledWith("ws_a");
  });

  it("wake calls the api once and paints waking", async () => {
    const api = await mount([view("ws_a", "api", "napping")]);
    fireEvent.click(screen.getByRole("button", { name: "Wake api" }));
    expect(useStore.getState().workspaces[0]!.phase).toBe("waking");
    expect(fact("state")).toBe("Waking");
    await waitFor(() => expect(api.wake).toHaveBeenCalledTimes(1));
    expect(api.wake).toHaveBeenCalledWith("ws_a");
  });

  it("reverts on failure", async () => {
    const api = await mount([view("ws_a", "api")]);
    api.nap.mockRejectedValueOnce(new Error("backend said no"));
    fireEvent.click(screen.getByRole("button", { name: "Pause api" }));
    await waitFor(() => expect(useStore.getState().workspaces[0]!.phase).toBe("running"));
    expect(screen.getByRole("button", { name: "Pause api" })).toBeDefined();
  });
});

describe("upgrade", () => {
  const openPicker = () => fireEvent.click(screen.getByRole("button", { name: "upgrade api" }));

  it("offers the provider's sizes above the current one on both counts, the current left out, with the estimated rate", async () => {
    await mount([view("ws_a", "api")]);
    openPicker();
    expect(screen.getAllByRole("button").map(b => b.textContent).filter(t => t?.includes("vCPU"))).toEqual(["4 vCPU · 8 GB", "4 vCPU · 16 GB", "8 vCPU · 16 GB", "16 vCPU · 32 GB"]);
    expect(screen.queryByRole("button", { name: "2 vCPU · 4 GB" })).toBeNull();
    // The new row prices the pick at the table's own rate, not the current rate scaled by vCPU.
    expect(fact("resize-to")).toBe("4 vCPU · 8 GB · $0.22/hr");
    fireEvent.click(screen.getByRole("button", { name: "4 vCPU · 16 GB" }));
    expect(fact("resize-to")).toBe("4 vCPU · 16 GB · $0.30/hr");
    expect(fact("resize-from")).toBe("2 vCPU · 4 GB · $0.11/hr");
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
    expect(screen.queryByRole("button", { name: "Rebuild api" })).toBeNull();
    act(() => api.emit({ type: "workspace.status", status: zombie(w) }));
    await waitFor(() => expect(fact("reach")).toBe("zombie"));
    expect(document.querySelector('[data-reach="zombie"]')).not.toBeNull();
    expect(fact("reason")).toBe("m_ws_a answered nothing for 92s after slow at 14:02:11");
    expect(screen.getByRole("button", { name: "Rebuild api" })).toBeDefined();
  });

  it("asks before rebuilding; confirming calls the api once", async () => {
    const w = view("ws_a", "api");
    const api = await mount([w]);
    const rebuild = vi.fn(async (id: string) => ({ ...view(id, "api"), machineId: "m_fresh" }));
    api.rebuild = rebuild;
    act(() => api.emit({ type: "workspace.status", status: zombie(w) }));
    fireEvent.click(await screen.findByRole("button", { name: "Rebuild api" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("Rebuild api?");
    expect(rebuild).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Rebuild" }));
    await waitFor(() => expect(rebuild).toHaveBeenCalledTimes(1));
    expect(rebuild).toHaveBeenCalledWith("ws_a");
    await waitFor(() => expect(screen.getByText("Machine rebuilt from the golden.")).toBeDefined());
  });

  it("a machine that stopped answering with memory near full says so, names the next size up, and offers the rebuild only after them", async () => {
    const GiB = 1024 ** 3;
    resetLive();
    const w = view("ws_a", "api");
    const api = await mount([w]);
    act(() => {
      getLive("ws_a").feedStatus("live");
      getLive("ws_a").feedSample({ type: "sys.sample", cpu: 99, load1: 6.4, mem: { used: 3.59 * GiB, total: 3.94 * GiB }, disk: { used: 1, total: 10 }, at: 1 });
    });
    // Answering, whatever the figures: nothing to say in the Machine section.
    expect(fact("out-of-memory")).toBe("");
    act(() => {
      getLive("ws_a").feedStatus("connecting");
      api.emit({ type: "workspace.status", status: { ...status(w), reach: { state: "unreachable" } } });
    });
    await waitFor(() => expect(fact("out-of-memory")).toBe("Out of memory (3.6 GB of 3.9 GB used, load 6.4) when the machine last answered; the work on it took the memory, not a fault of the machine"));
    expect(fact("bigger-size")).toBe("A workspace on 4 vCPU · 8 GB ($0.22/hr) fits more; pick it when you make the next one");
    // Not a zombie yet: no rebuild on offer for a machine the runtime is still waiting on.
    expect(screen.queryByRole("button", { name: "Rebuild api" })).toBeNull();
    act(() => api.emit({ type: "workspace.status", status: zombie(w) }));
    const rebuild = await screen.findByRole("button", { name: "Rebuild api" });
    const bigger = document.querySelector('[data-k="bigger-size"]')!;
    expect(bigger.compareDocumentPosition(rebuild) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    act(() => getLive("ws_a").feedStatus("live"));
    await waitFor(() => expect(fact("out-of-memory")).toBe(""));
  });

  it("cancel leaves the zombie alone", async () => {
    const w = view("ws_a", "api");
    const api = await mount([w]);
    const rebuild = vi.fn(async (id: string) => view(id, "api"));
    api.rebuild = rebuild;
    act(() => api.emit({ type: "workspace.status", status: zombie(w) }));
    fireEvent.click(await screen.findByRole("button", { name: "Rebuild api" }));
    await screen.findByRole("alertdialog");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(rebuild).not.toHaveBeenCalled();
  });
});

describe("gone machine", () => {
  const WORDS = "machine m_ws_a_0123456789abcdef is gone at the provider: Not found";
  const gone = (): WorkspaceView => ({ ...view("ws_a", "api", "gone"), gone: WORDS });

  it("reads Gone with the provider's words, no rate and no nap window, offers the rebuild and neither pause, wake nor upgrade", async () => {
    await mount([gone()]);
    expect(fact("state")).toBe("Gone");
    expect(fact("reach")).toBe("gone");
    expect(fact("reason")).toBe(WORDS);
    expect(fact("idle")).toBe("not scheduled");
    expect(fact("rate")).toBe("$0.000/hr");
    expect(screen.getByRole("button", { name: "Rebuild api" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Pause api" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Wake api" })).toBeNull();
    expect((screen.getByRole("button", { name: "upgrade api" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("the rebuild asks first, then calls the api once", async () => {
    const api = await mount([gone()]);
    const rebuild = vi.fn(async (id: string) => ({ ...view(id, "api"), machineId: "m_fresh" }));
    api.rebuild = rebuild;
    fireEvent.click(screen.getByRole("button", { name: "Rebuild api" }));
    await screen.findByRole("alertdialog");
    fireEvent.click(screen.getByRole("button", { name: "Rebuild" }));
    await waitFor(() => expect(rebuild).toHaveBeenCalledTimes(1));
    expect(rebuild).toHaveBeenCalledWith("ws_a");
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

describe("daemon version", () => {
  it("the machine tab offers nothing about a daemon older than the app: the runtime replaces it and the machine's row says so", async () => {
    await mount([view("ws_a", "api")]);
    act(() => provideDaemonHello("ws_a", { root: "/root", version: 1 }));
    expect(document.querySelector('[data-k="daemon-update"]')).toBeNull();
    expect(screen.queryByRole("button", { name: "update the daemon on api" })).toBeNull();
    expect(document.body.textContent).not.toContain("predates");
  });
});
