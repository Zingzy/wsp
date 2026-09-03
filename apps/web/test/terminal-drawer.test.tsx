// SPDX-License-Identifier: AGPL-3.0-only
// The terminal drawer over the workspace's daemon link, on a fake wire: the
// first open spawns a pty and mounts a libghostty surface, bytes fed to the
// link reach that surface (its cursor report comes back out as a pty.write),
// new and split open more ptys and lay them out, close kills them. The same
// drawer mounts in panel mode as the right panel's terminal surface.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { WorkspaceView } from "@wsp/protocol";
import { cloneElement, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceTerminalDrawer } from "../src/components/WorkspaceTerminalDrawer.js";
import { useStore } from "../src/protocol/store.js";
import { selectWorkspaceRightPanelState, useRightPanelStore } from "../src/rightPanelStore.js";
import { RightPanel } from "../src/shell/RightPanel.js";
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

function fakeLink() {
  let next = 1;
  const ops: { op: string; params: Record<string, unknown> }[] = [];
  const wire: TerminalWire = {
    request: async (op, params = {}) => {
      ops.push({ op, params });
      if (op === "pty.create") return { ok: true, ptyId: `p${next++}` };
      return { ok: true };
    },
  };
  const wt = new WorkspaceTerminals(wire);
  wt.feedStatus("live");
  provideTerminals(WS, wt);
  const writes = () => ops.filter(o => o.op === "pty.write").map(o => String(o.params["data"]));
  const count = (op: string) => ops.filter(o => o.op === op).length;
  return { wt, ops, writes, count };
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
