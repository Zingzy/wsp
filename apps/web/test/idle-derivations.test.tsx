// SPDX-License-Identifier: AGPL-3.0-only
// The shell over 200 threads, each in a worktree workspace of its own as a builder started with --branch is, while one
// thread streams 200 events: deltas, subagent starts and a permission prompt opening and closing. What the host
// answers again unchanged costs nothing, the palette builds nothing while it is shut, and no other thread is folded
// again.
import { act, render, waitFor } from "@testing-library/react";
import { cloneElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PREFERENCES, type SessionView, type WorkspaceView } from "@wsp/protocol";
import type { Api, ProtocolEvent } from "../src/protocol/client.js";
import { useStore } from "../src/protocol/store.js";
import { AppShell } from "../src/shell/AppShell.js";
import { caps } from "./caps.js";
import { noDaemonApi } from "./fake-daemon-api.js";

const counts = vi.hoisted(() => ({ palette: 0, tiles: 0, folds: new Map<string, number>() }));

vi.mock("../src/components/palette/paletteItems.js", async importOriginal => {
  const real = await importOriginal<typeof import("../src/components/palette/paletteItems.js")>();
  return { ...real, buildPaletteItems: (input: Parameters<typeof real.buildPaletteItems>[0]) => (counts.palette++, real.buildPaletteItems(input)) };
});
vi.mock("../src/sidebar/threadTree.js", async importOriginal => {
  const real = await importOriginal<typeof import("../src/sidebar/threadTree.js")>();
  return { ...real, sidebarTiles: (...args: Parameters<typeof real.sidebarTiles>) => (counts.tiles++, real.sidebarTiles(...args)) };
});
vi.mock("@wsp/protocol", async importOriginal => {
  const real = await importOriginal<typeof import("@wsp/protocol")>();
  const foldThreads: typeof real.foldThreads = rows => {
    for (const id of new Set(rows.map(row => row.workspaceId))) counts.folds.set(id, (counts.folds.get(id) ?? 0) + 1);
    return real.foldThreads(rows);
  };
  return { ...real, foldThreads };
});
vi.mock("../src/components/ui/tooltip.js", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ render: element, children }: { render?: ReactElement<{ children?: ReactNode }>; children?: ReactNode }) =>
    element === undefined ? <>{children}</> : cloneElement(element, {}, children ?? element.props.children),
  TooltipPopup: () => null,
}));

const THREADS = 200;
const NOW = Date.now();
const STREAMED = "ws_000";

const workspaceAt = (i: number): WorkspaceView => {
  const id = `ws_${String(i).padStart(3, "0")}`;
  return {
    id,
    name: `lab-${id}`,
    machineId: `m_${id}`,
    project: { id: "pr_1", name: "lab", path: "/root/lab", computer: "default" },
    phase: "running",
    golden: "snap_g",
    createdAt: new Date(NOW - (THREADS - i) * 60_000).toISOString(),
    worktree: { path: `/root/.wsp/worktrees/lab-${id}`, branch: `fix/${id}`, made: true },
  };
};
const rowAt = (w: WorkspaceView, i: number): SessionView => ({
  id: `s_${w.id}`,
  workspaceId: w.id,
  threadId: `thr_${w.id}`,
  harness: "claude",
  status: i < 15 ? "running" : "completed",
  startedBy: "agent",
  prompt: `Build: ticket ${1000 + i}`,
  harnessTitle: `Build: ticket ${1000 + i}`,
  startedAt: NOW - (THREADS - i) * 60_000,
  ...(i < 15 ? {} : { endedAt: NOW - (THREADS - i) * 30_000, lastLine: `Pushed ticket ${1000 + i}, gate green.` }),
});

/** A host holding one row per workspace, which answers every read with fresh objects as the wire does, and changes
 * the streamed thread's row as its turn moves. */
function labHost() {
  const workspaces = Array.from({ length: THREADS }, (_, i) => workspaceAt(i));
  const rows = new Map(workspaces.map((w, i) => [w.id, [rowAt(w, i)]]));
  const listeners: Array<(e: ProtocolEvent) => void> = [];
  let reading = 0;
  const read = <T,>(value: T): Promise<T> => {
    reading++;
    return new Promise(resolve => setTimeout(() => (reading--, resolve(structuredClone(value))), 0));
  };
  const api: Api = {
    listWorkspaces: async () => workspaces,
    getWorkspace: async id => workspaces.find(w => w.id === id)!,
    createWorkspace: async () => workspaces[0]!,
    watchStatuses: async () => [],
    nap: async id => workspaces.find(w => w.id === id)!,
    wake: async id => workspaces.find(w => w.id === id)!,
    capabilities: async () => caps(),
    startSession: async o => ({ id: "s1", workspaceId: o.workspaceId, harness: "claude", status: "running" }),
    portReach: async (_id, port) => ({ url: `https://m1-${port}.preview.example/`, expiresAt: NOW + 3_600_000 }),
    daemon: noDaemonApi,
    sessionHistory: async () => [],
    listSnapshots: async () => ({ name: "default", head: null, versions: [] }),
    snapshotStorage: async () => null,
    rollbackSnapshot: async () => ({ lineage: { name: "default", head: null, versions: [] }, existingWorkspaces: "untouched" }),
    listSessions: id => read(id === undefined ? [...rows.values()].flat() : (rows.get(id) ?? [])),
    subscribe: fn => {
      listeners.push(fn);
      return () => listeners.splice(listeners.indexOf(fn), 1);
    },
    getGolden: async () => undefined,
  };
  /** The streamed thread's row moves, and the host pushes it as it does after every event that moves a row. */
  const streamed = (patch: Partial<SessionView>): ProtocolEvent => {
    const { prompt: _told, ...row } = { ...rows.get(STREAMED)![0]!, ...patch };
    rows.set(STREAMED, [{ ...rows.get(STREAMED)![0]!, ...patch }]);
    return { type: "session.row", workspaceId: STREAMED, threadId: row.threadId, id: row.id, row } as ProtocolEvent;
  };
  return { api, emit: (e: ProtocolEvent) => listeners.forEach(fn => fn(e)), streamed, settled: () => reading === 0 };
}

/** The streamed thread's i-th events: a permission prompt opens at 50 and closes at 150, a subagent starts every
 * tenth, each of those followed by the row it moved, and the rest are lines of its transcript, which change no row. */
function streamEvents(host: ReturnType<typeof labHost>, i: number): ProtocolEvent[] {
  const scope = { workspaceId: STREAMED, sessionId: `s_${STREAMED}`, threadId: `thr_${STREAMED}`, turnId: `turn_${STREAMED}`, at: NOW + i };
  if (i === 50) {
    return [{ type: "session.permission", ...scope, askId: "ask_1", toolName: "Bash", toolUseId: "tu_ask", input: "{}", options: [{ id: "allow", label: "Allow", effect: "allow" }] } as ProtocolEvent, host.streamed({ asking: "Run pnpm install" })];
  }
  if (i === 150) {
    return [{ type: "session.permission.closed", ...scope, askId: "ask_1" } as ProtocolEvent, host.streamed({ asking: undefined })];
  }
  if (i % 10 === 0) {
    return [{ type: "session.subagent", ...scope, task: `sa_${i}`, state: "running", title: `Read the files ${i}` } as ProtocolEvent, host.streamed({ lastLine: `Subagent ${i} reading the files` })];
  }
  return [{ type: "session.delta", ...scope, kind: "text", text: `line ${i}`, messageId: `m_${i}` } as ProtocolEvent];
}

beforeEach(() => {
  window.localStorage.clear();
  useStore.setState({ api: null, conn: "live", capabilities: null, workspaces: [], statuses: {}, costs: {}, spending: {}, selectedId: null, creations: [], sessions: {}, ready: false, preferences: { ...DEFAULT_PREFERENCES, labs: true }, settingsOpen: false, projects: [], projectHome: null });
});

describe("one thread streaming among 200", () => {
  it("re-derives only that thread, and neither the palette nor any other thread", { timeout: 60_000 }, async () => {
    const host = labHost();
    useStore.getState().bind(host.api);
    render(
      <AppShell>
        <div>center content</div>
      </AppShell>,
    );
    await waitFor(() => expect(Object.keys(useStore.getState().sessions)).toHaveLength(THREADS), { timeout: 20_000 });
    await waitFor(() => expect(host.settled()).toBe(true));
    await act(() => new Promise<void>(resolve => setTimeout(resolve, 50)));
    counts.palette = 0;
    counts.tiles = 0;
    counts.folds.clear();

    /** Whether the streamed thread's tile stands under the Needs you section's row, before the next section's. */
    const needsYou = (): boolean => {
      const ids = [...document.querySelectorAll("[data-row-id]")].map(row => row.getAttribute("data-row-id")!);
      const from = ids.indexOf("section:needs-you");
      const to = ids.findIndex((id, i) => i > from && id.startsWith("section:"));
      const at = ids.indexOf(`thread:thr_${STREAMED}`);
      return from >= 0 && at > from && (to < 0 || at < to);
    };
    let askingShown = false;
    const started = performance.now();
    for (let i = 0; i < 200; i++) {
      const events = streamEvents(host, i);
      await act(async () => {
        for (const e of events) host.emit(e);
        await new Promise<void>(resolve => setTimeout(resolve, 0));
      });
      if (i === 100) askingShown = needsYou();
    }
    await waitFor(() => expect(host.settled()).toBe(true));
    await act(() => new Promise<void>(resolve => setTimeout(resolve, 300)));
    const spent = performance.now() - started;

    const others = [...counts.folds].filter(([id]) => id !== STREAMED).reduce((sum, [, n]) => sum + n, 0);
    const said = `sidebar derived ${counts.tiles} times in ${Math.round(spent)} ms`;
    expect({ palette: counts.palette, otherThreadFolds: others }, said).toEqual({ palette: 0, otherThreadFolds: 0 });
    // The sidebar is derived once per change to the streamed thread's row: at most one per subagent start and one
    // for each edge of the prompt, 21 in all.
    expect(counts.tiles, said).toBeLessThanOrEqual(21);
    expect(useStore.getState().sessions[STREAMED]?.[0]?.lastLine).toBe("Subagent 190 reading the files");
    // The one derivation per change is a fresh one: the prompt put the thread in Needs you and its close took it out.
    expect({ askingShown, afterClose: needsYou() }).toEqual({ askingShown: true, afterClose: false });
    // A budget, not a benchmark.
    expect(spent).toBeLessThan(15_000);
  });
});
