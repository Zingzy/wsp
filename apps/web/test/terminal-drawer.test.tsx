// SPDX-License-Identifier: AGPL-3.0-only
// The terminal drawer over the workspace's daemon link, on a fake wire: the
// first open spawns a pty and mounts a libghostty surface, bytes fed to the
// link reach that surface (its cursor report comes back out as a pty.write),
// new and split open more ptys and lay them out, close kills them. The same
// drawer mounts in panel mode as the right panel's terminal surface, and each
// pty has one owner: the panel keeps what it opened, the drawer the rest.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { WorkspaceView } from "@wsp/protocol";
import { cloneElement, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceTerminalDrawer } from "../src/components/WorkspaceTerminalDrawer.js";
import { useStore } from "../src/protocol/store.js";
import { selectWorkspaceRightPanelState, useRightPanelStore } from "../src/rightPanelStore.js";
import { RightPanel } from "../src/shell/RightPanel.js";
import { openPanelTerminal } from "../src/shell/shellCommands.js";
import { useTerminalDrawerStore } from "../src/terminal/drawerStore.js";
import { provideTerminals, WorkspaceTerminals, type TerminalWire } from "../src/terminal/link.js";

// The toolbar buttons are Base UI popover triggers (tooltip on hover). Under
// jsdom a click on one opens the popup, whose positioning against zero-size
// rects pegged the main thread for 12 s per click (measured); the popover has
// its own kit tests, so here the trigger is the bare button.
vi.mock("../src/components/ui/popover.js", () => ({
  Popover: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverTrigger: ({ render, children }: { render: ReactElement<{ children?: ReactNode }>; children: ReactNode }) =>
    cloneElement(render, {}, children),
  PopoverPopup: () => null,
}));

const WS = "ws_drawer_test";

// The daemon side of the wire: the ptys it holds outlive any WorkspaceTerminals
// over it, so relink() is a reload (a fresh model over the same daemon).
function fakeLink({ refuseCreate = false, ptys = [], holdList = false }: { refuseCreate?: boolean; ptys?: string[]; holdList?: boolean } = {}) {
  let next = ptys.length + 1;
  const held = new Set(ptys);
  const ops: { op: string; params: Record<string, unknown> }[] = [];
  // With holdList the daemon answers pty.list only when the test says so, to see what renders before adoption.
  let releaseList = (): void => {};
  const listGate = holdList ? new Promise<void>(resolve => (releaseList = resolve)) : Promise.resolve();
  const wire: TerminalWire = {
    request: async (op, params = {}) => {
      ops.push({ op, params });
      if (op === "pty.create") {
        if (refuseCreate) throw new Error("daemon unreachable");
        const ptyId = `p${next++}`;
        held.add(ptyId);
        return { ok: true, ptyId };
      }
      if (op === "pty.kill") held.delete(String(params["ptyId"]));
      if (op === "pty.list") {
        await listGate;
        return { ok: true, ptys: [...held].map(id => ({ id, pid: 1, cols: 80, rows: 24, exited: false })) };
      }
      return { ok: true };
    },
  };
  const relink = () => {
    const wt = new WorkspaceTerminals(wire);
    wt.feedStatus("live");
    provideTerminals(WS, wt);
    return wt;
  };
  const wt = relink();
  const writes = () => ops.filter(o => o.op === "pty.write").map(o => String(o.params["data"]));
  const count = (op: string) => ops.filter(o => o.op === op).length;
  return { wt, ops, writes, count, relink, releaseList: () => releaseList() };
}

// Surfaces size their grid from the mount; jsdom lays nothing out, so give every viewport a box.
function sizeViewports(): void {
  for (const el of document.querySelectorAll<HTMLElement>("[data-terminal-viewport]")) {
    if (el.clientWidth === 0) {
      Object.defineProperty(el, "clientWidth", { value: 600 });
      Object.defineProperty(el, "clientHeight", { value: 300 });
    }
  }
}

const canvases = (owner: string) => document.querySelectorAll(`[data-terminal-owner="${owner}"] canvas`);
const inputs = (owner: string) => document.querySelectorAll(`[data-terminal-owner="${owner}"] .ghostty-input`);

beforeEach(() => {
  window.localStorage.clear();
  useTerminalDrawerStore.setState({ byWorkspaceId: {} });
  useRightPanelStore.setState({ byWorkspaceId: {} });
});

afterEach(() => {
  cleanup();
  provideTerminals(WS, null);
});

describe("WorkspaceTerminalDrawer", () => {
  it("renders nothing while the drawer is closed, then opens a pty and a surface when opened", async () => {
    const { wt, count } = fakeLink();
    const { container } = render(<WorkspaceTerminalDrawer workspaceId={WS} />);
    expect(container.firstChild).toBeNull();
    expect(count("pty.create")).toBe(0);

    act(() => useTerminalDrawerStore.getState().setOpen(WS, true));
    await waitFor(() => expect(count("pty.create")).toBe(1));
    await waitFor(() => expect(canvases("drawer")).toHaveLength(1));
    expect(wt.tabs().map(t => t.ptyId)).toEqual(["p1"]);
    await waitFor(() => expect(inputs("drawer")).toHaveLength(1), { timeout: 15_000 });
  }, 20_000);

  it("bytes from the daemon link reach the surface: a cursor query is answered through pty.write", async () => {
    const { wt, writes } = fakeLink();
    useTerminalDrawerStore.getState().setOpen(WS, true);
    render(<WorkspaceTerminalDrawer workspaceId={WS} />);
    await waitFor(() => expect(inputs("drawer")).toHaveLength(1), { timeout: 15_000 });
    act(() => wt.feedEvent({ type: "pty.data", ptyId: "p1", data: "\x1b[6n" }));
    await waitFor(() => expect(writes().join("")).toContain("\x1b[1;1R"));
  }, 20_000);

  it("new opens another pty as its own tab; split opens one into the active group; close kills", async () => {
    const { wt, count } = fakeLink();
    useTerminalDrawerStore.getState().setOpen(WS, true);
    render(<WorkspaceTerminalDrawer workspaceId={WS} />);
    await waitFor(() => expect(inputs("drawer")).toHaveLength(1), { timeout: 15_000 });
    fireEvent.click(screen.getByLabelText(/^New Terminal/));
    await waitFor(() => expect(count("pty.create")).toBe(2));
    await waitFor(() => expect(useTerminalDrawerStore.getState().byWorkspaceId[WS]?.terminalIds).toEqual(["p1", "p2"]));
    const ui = useTerminalDrawerStore.getState().byWorkspaceId[WS]!;
    expect(ui.activeTerminalId).toBe("p2");
    expect(ui.terminalGroups.map(g => g.terminalIds)).toEqual([["p1"], ["p2"]]);
    // Two terminals: the tab list appears with the link's titles, one surface shown.
    expect(screen.getAllByText("shell")).toHaveLength(2);
    await waitFor(() => expect(canvases("drawer")).toHaveLength(1));
    fireEvent.click(screen.getByLabelText(/^Split Terminal Horizontally/));
    await waitFor(() => expect(count("pty.create")).toBe(3));
    await waitFor(() => expect(useTerminalDrawerStore.getState().byWorkspaceId[WS]?.terminalGroups.map(g => g.terminalIds)).toEqual([["p1"], ["p2", "p3"]]));
    await waitFor(() => expect(canvases("drawer")).toHaveLength(2));
    sizeViewports();
    await waitFor(() => expect(inputs("drawer")).toHaveLength(2), { timeout: 15_000 });

    fireEvent.click(screen.getByLabelText(/^Close Terminal/));
    await waitFor(() => expect(count("pty.kill")).toBe(1));
    await waitFor(() => expect(wt.tabs().map(t => t.ptyId)).toEqual(["p1", "p2"]));
    await waitFor(() => expect(canvases("drawer")).toHaveLength(1));
  }, 30_000);

  it("closing the last terminal closes the drawer; reopening shows the empty state and never respawns", async () => {
    const { count } = fakeLink();
    useTerminalDrawerStore.getState().setOpen(WS, true);
    const { container } = render(<WorkspaceTerminalDrawer workspaceId={WS} />);
    await waitFor(() => expect(inputs("drawer")).toHaveLength(1), { timeout: 15_000 });
    fireEvent.click(screen.getByLabelText(/^Close Terminal/));
    await waitFor(() => expect(count("pty.kill")).toBe(1));
    await waitFor(() => expect(container.firstChild).toBeNull());
    expect(useTerminalDrawerStore.getState().byWorkspaceId[WS]?.terminalOpen ?? false).toBe(false);

    act(() => useTerminalDrawerStore.getState().setOpen(WS, true));
    await screen.findByText(/No terminals for this workspace yet/);
    await new Promise(r => setTimeout(r, 50));
    expect(count("pty.create")).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: /^New Terminal/ }));
    await waitFor(() => expect(count("pty.create")).toBe(2));
    await waitFor(() => expect(inputs("drawer")).toHaveLength(1), { timeout: 15_000 });
  }, 20_000);
});

const view: WorkspaceView = { id: WS, name: "drawer", machineId: "m_drawer", phase: "running", golden: "snap_g", createdAt: "2026-09-01T00:00:00Z" };

function Panel() {
  const state = useRightPanelStore(s => selectWorkspaceRightPanelState(s.byWorkspaceId, WS));
  return <RightPanel workspaceId={WS} state={state} mode="inline" />;
}

describe("terminal as a right-panel surface", () => {
  beforeEach(() => {
    useStore.setState({ api: null, conn: "live", capabilities: null, workspaces: [view], statuses: {}, costs: {}, spending: {}, toast: null, selectedId: WS, sessions: {}, ready: true });
  });

  it("mounts the drawer in panel mode for a terminal surface and labels its tab from the link", async () => {
    const { wt, writes } = fakeLink();
    const tab = await wt.open();
    useRightPanelStore.getState().openTerminal(WS, tab.ptyId);
    render(<Panel />);
    await waitFor(() => expect(document.querySelector('[data-terminal-owner="right-panel"]')).not.toBeNull());
    await waitFor(() => expect(inputs("right-panel")).toHaveLength(1), { timeout: 15_000 });
    expect(screen.getAllByText("shell").length).toBeGreaterThan(0);
    act(() => wt.feedEvent({ type: "pty.data", ptyId: tab.ptyId, data: "\x1b[6n" }));
    await waitFor(() => expect(writes().join("")).toContain("\x1b[1;1R"));
  }, 20_000);

  it("split in the panel adds the new pty to the surface's group; new opens a second surface", async () => {
    const { wt, count } = fakeLink();
    const tab = await wt.open();
    useRightPanelStore.getState().openTerminal(WS, tab.ptyId);
    render(<Panel />);
    await waitFor(() => expect(inputs("right-panel")).toHaveLength(1), { timeout: 15_000 });

    fireEvent.click(screen.getByLabelText(/^Split Terminal Vertically/));
    await waitFor(() => expect(count("pty.create")).toBe(2));
    await waitFor(() => {
      const s = selectWorkspaceRightPanelState(useRightPanelStore.getState().byWorkspaceId, WS).surfaces[0];
      expect(s?.kind === "terminal" ? s.terminalIds : []).toEqual(["p1", "p2"]);
    });
    await waitFor(() => expect(canvases("right-panel")).toHaveLength(2));

    fireEvent.click(screen.getByLabelText(/^New Terminal/));
    await waitFor(() => expect(count("pty.create")).toBe(3));
    await waitFor(() => expect(selectWorkspaceRightPanelState(useRightPanelStore.getState().byWorkspaceId, WS).surfaces.map(s => s.id)).toEqual(["terminal:p1", "terminal:p3"]));
  }, 30_000);
});

describe("one owner per pty", () => {
  beforeEach(() => {
    useStore.setState({ api: null, conn: "live", capabilities: null, workspaces: [view], statuses: {}, costs: {}, spending: {}, toast: null, selectedId: WS, sessions: {}, ready: true });
  });

  it("a pty opened from the right panel is the panel's: the drawer never lists it and only the panel mounts it", async () => {
    const { count } = fakeLink();
    useTerminalDrawerStore.getState().setOpen(WS, true);
    render(
      <>
        <WorkspaceTerminalDrawer workspaceId={WS} />
        <Panel />
      </>,
    );
    await waitFor(() => expect(inputs("drawer")).toHaveLength(1), { timeout: 15_000 });
    await act(() => openPanelTerminal(WS));
    await waitFor(() => expect(count("pty.create")).toBe(2));
    await waitFor(() => expect(inputs("right-panel")).toHaveLength(1), { timeout: 15_000 });
    expect(useTerminalDrawerStore.getState().byWorkspaceId[WS]?.terminalIds).toEqual(["p1"]);
    expect(selectWorkspaceRightPanelState(useRightPanelStore.getState().byWorkspaceId, WS).surfaces.map(s => s.id)).toEqual(["terminal:p2"]);
    expect(canvases("drawer")).toHaveLength(1);
    expect(canvases("right-panel")).toHaveLength(1);
  }, 30_000);

  it("a drawer opened after the panel made a pty spawns its own; closing it leaves the panel's surface alone; a surface whose pty the link lacks is dropped", async () => {
    const { wt, count, ops } = fakeLink();
    const theirs = await wt.open();
    useRightPanelStore.getState().openTerminal(WS, theirs.ptyId);
    useRightPanelStore.getState().openTerminal(WS, "p_gone");
    useTerminalDrawerStore.getState().setOpen(WS, true);
    render(
      <>
        <WorkspaceTerminalDrawer workspaceId={WS} />
        <Panel />
      </>,
    );
    await waitFor(() => expect(selectWorkspaceRightPanelState(useRightPanelStore.getState().byWorkspaceId, WS).surfaces.map(s => s.id)).toEqual(["terminal:p1"]));
    // The panel's pty is not the drawer's, so the drawer's first open spawns its own.
    await waitFor(() => expect(count("pty.create")).toBe(2));
    await waitFor(() => expect(inputs("drawer")).toHaveLength(1), { timeout: 15_000 });
    expect(useTerminalDrawerStore.getState().byWorkspaceId[WS]?.terminalIds).toEqual(["p2"]);

    fireEvent.click(within(document.querySelector<HTMLElement>('[data-terminal-owner="drawer"]')!).getByLabelText(/^Close Terminal/));
    await waitFor(() => expect(count("pty.kill")).toBe(1));
    expect(ops.find(o => o.op === "pty.kill")?.params["ptyId"]).toBe("p2");
    await waitFor(() => expect(document.querySelector('[data-terminal-owner="drawer"]')).toBeNull());
    expect(selectWorkspaceRightPanelState(useRightPanelStore.getState().byWorkspaceId, WS).surfaces.map(s => s.id)).toEqual(["terminal:p1"]);
    expect(wt.tabs().map(t => t.ptyId)).toEqual(["p1"]);
  }, 30_000);

  it("two mounts racing for a workspace's first pty share one create", async () => {
    const { count } = fakeLink();
    useTerminalDrawerStore.getState().setOpen(WS, true);
    const { unmount } = render(
      <>
        <WorkspaceTerminalDrawer workspaceId={WS} />
        <WorkspaceTerminalDrawer workspaceId={WS} />
      </>,
    );
    await waitFor(() => expect(count("pty.create")).toBe(1));
    await new Promise(r => setTimeout(r, 50));
    expect(count("pty.create")).toBe(1);
    unmount();
  });
});

describe("reload adopts the daemon's ptys", () => {
  beforeEach(() => {
    useStore.setState({ api: null, conn: "live", capabilities: null, workspaces: [view], statuses: {}, costs: {}, spending: {}, toast: null, selectedId: WS, sessions: {}, ready: true });
  });

  it("two attaches over one daemon make one pty: the second link adopts the first's and the drawer spawns none", async () => {
    const { count, relink } = fakeLink();
    useTerminalDrawerStore.getState().setOpen(WS, true);
    const first = render(<WorkspaceTerminalDrawer workspaceId={WS} />);
    await waitFor(() => expect(inputs("drawer")).toHaveLength(1), { timeout: 15_000 });
    expect(count("pty.create")).toBe(1);
    first.unmount();

    const wt = relink();
    render(<WorkspaceTerminalDrawer workspaceId={WS} />);
    await waitFor(() => expect(wt.tabs().map(t => t.ptyId)).toEqual(["p1"]));
    await waitFor(() => expect(inputs("drawer")).toHaveLength(1), { timeout: 15_000 });
    await new Promise(r => setTimeout(r, 50));
    expect(count("pty.create")).toBe(1);
    expect(count("pty.list")).toBe(2);
    expect(count("pty.attach")).toBe(2);
    expect(useTerminalDrawerStore.getState().byWorkspaceId[WS]?.terminalIds).toEqual(["p1"]);
  }, 30_000);

  it("a reload with two live ptys shows both in the stored arrangement (a split, p2 active) and spawns none", async () => {
    const { wt, ops, count, releaseList } = fakeLink({ ptys: ["p1", "p2"], holdList: true });
    const drawer = useTerminalDrawerStore.getState();
    drawer.setOpen(WS, true);
    drawer.add(WS, "p1");
    drawer.split(WS, "p2", "vertical");
    render(<WorkspaceTerminalDrawer workspaceId={WS} />);
    // Until the daemon has answered, the stored ptys are not shown as terminals: no surface binds to a pty the link does not know.
    await screen.findByText(/Not connected to this workspace/);
    expect(canvases("drawer")).toHaveLength(0);
    releaseList();
    await waitFor(() => expect(canvases("drawer")).toHaveLength(2));
    sizeViewports();
    await waitFor(() => expect(inputs("drawer")).toHaveLength(2), { timeout: 15_000 });
    await new Promise(r => setTimeout(r, 50));
    expect(count("pty.create")).toBe(0);
    expect(count("pty.attach")).toBe(2);
    const ui = useTerminalDrawerStore.getState().byWorkspaceId[WS]!;
    expect(ui.terminalIds).toEqual(["p1", "p2"]);
    expect(ui.activeTerminalId).toBe("p2");
    expect(ui.terminalGroups.map(g => [g.terminalIds, g.splitDirection])).toEqual([[["p1", "p2"], "vertical"]]);
    // Both surfaces are bound to their adopted ptys: bytes in come back out.
    act(() => wt.feedEvent({ type: "pty.data", ptyId: "p2", data: "\x1b[6n" }));
    await waitFor(() => expect(ops.filter(o => o.op === "pty.write" && o.params["ptyId"] === "p2").map(o => o.params["data"]).join("")).toContain("\x1b[1;1R"));
  }, 20_000);

  it("ownership survives a reload: the panel keeps its pty, the drawer takes its own and any pty no store claims", async () => {
    const { wt, ops, count, releaseList } = fakeLink({ ptys: ["p1", "p2", "p3"], holdList: true });
    useRightPanelStore.getState().openTerminal(WS, "p2");
    useTerminalDrawerStore.getState().setOpen(WS, true);
    useTerminalDrawerStore.getState().add(WS, "p1");
    render(
      <>
        <WorkspaceTerminalDrawer workspaceId={WS} />
        <Panel />
      </>,
    );
    // Before the daemon answers, neither side shows a terminal or drops the panel's surface.
    await waitFor(() => expect(screen.getAllByText(/Not connected to this workspace/)).toHaveLength(2));
    expect(selectWorkspaceRightPanelState(useRightPanelStore.getState().byWorkspaceId, WS).surfaces.map(s => s.id)).toEqual(["terminal:p2"]);
    releaseList();
    await waitFor(() => expect(useTerminalDrawerStore.getState().byWorkspaceId[WS]?.terminalIds).toEqual(["p1", "p3"]));
    await waitFor(() => expect(inputs("right-panel")).toHaveLength(1), { timeout: 15_000 });
    await waitFor(() => expect(inputs("drawer")).toHaveLength(1), { timeout: 15_000 });
    expect(selectWorkspaceRightPanelState(useRightPanelStore.getState().byWorkspaceId, WS).surfaces.map(s => s.id)).toEqual(["terminal:p2"]);
    expect(count("pty.create")).toBe(0);
    expect(count("pty.attach")).toBe(3);
    act(() => wt.feedEvent({ type: "pty.data", ptyId: "p2", data: "\x1b[6n" }));
    await waitFor(() => expect(ops.filter(o => o.op === "pty.write" && o.params["ptyId"] === "p2").map(o => o.params["data"]).join("")).toContain("\x1b[1;1R"));
  }, 30_000);
});

describe("drawer resilience", () => {
  it("a stored value with a bad shape at the current version hydrates to a usable state and renders", async () => {
    window.localStorage.setItem("wsp:terminal-drawer:v1", JSON.stringify({ state: { byWorkspaceId: { [WS]: { terminalOpen: true } } }, version: 1 }));
    await useTerminalDrawerStore.persist.rehydrate();
    expect(useTerminalDrawerStore.getState().byWorkspaceId[WS]).toMatchObject({ terminalOpen: true, terminalIds: [], terminalGroups: [] });
    const { count } = fakeLink();
    render(<WorkspaceTerminalDrawer workspaceId={WS} />);
    await waitFor(() => expect(count("pty.create")).toBe(1));
  });

  it("while the link is down the empty state says so and offers no terminal; going live spawns one", async () => {
    const { wt, count } = fakeLink();
    wt.feedStatus("connecting");
    useTerminalDrawerStore.getState().setOpen(WS, true);
    render(<WorkspaceTerminalDrawer workspaceId={WS} />);
    await screen.findByText(/Not connected to this workspace/);
    expect(screen.queryByRole("button", { name: /^New Terminal/ })).toBeNull();
    expect(count("pty.create")).toBe(0);
    act(() => wt.feedStatus("live"));
    await waitFor(() => expect(count("pty.create")).toBe(1));
  });

  it("a refused pty.create reaches the toast from the first open, New Terminal and the panel", async () => {
    const { count } = fakeLink({ refuseCreate: true });
    useTerminalDrawerStore.getState().setOpen(WS, true);
    render(<WorkspaceTerminalDrawer workspaceId={WS} />);
    await waitFor(() => expect(useStore.getState().toast).toBe("terminal: daemon unreachable"));
    await screen.findByText(/No terminals for this workspace yet/);
    await new Promise(r => setTimeout(r, 50));
    expect(count("pty.create")).toBe(1);

    useStore.setState({ toast: null });
    fireEvent.click(screen.getByRole("button", { name: /^New Terminal/ }));
    await waitFor(() => expect(useStore.getState().toast).toBe("terminal: daemon unreachable"));

    useStore.setState({ toast: null });
    await act(() => openPanelTerminal(WS));
    expect(useStore.getState().toast).toBe("terminal: daemon unreachable");
    expect(selectWorkspaceRightPanelState(useRightPanelStore.getState().byWorkspaceId, WS).surfaces).toEqual([]);
  });
});
