// SPDX-License-Identifier: AGPL-3.0-only
// The right panel store's persisted shape is read on every render; a value
// stored at the current version with a shape this build cannot render must
// hydrate to something usable, since zustand runs migrate only on a version
// change.
import { cleanup, render, screen } from "@testing-library/react";
import type { WorkspaceView } from "@wsp/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useStore } from "../src/protocol/store.js";
import { selectActiveRightPanel, selectPanelTerminalIds, selectWorkspaceRightPanelState, useRightPanelStore } from "../src/rightPanelStore.js";
import { RightPanel } from "../src/shell/RightPanel.js";

const KEY = "wsp:right-panel-state:v1";
const WS = "ws_panel_store";

const view: WorkspaceView = { id: WS, name: "panel", machineId: "m_panel", phase: "running", golden: "snap_g", createdAt: "2026-09-01T00:00:00Z" };

beforeEach(() => {
  window.localStorage.clear();
  useRightPanelStore.setState({ byWorkspaceId: {} });
});

afterEach(cleanup);

/** Seeds the store's key at the current version and hydrates it. */
async function hydrate(surfaces: unknown[], activeSurfaceId: string | null = null): Promise<void> {
  window.localStorage.setItem(KEY, JSON.stringify({ state: { byWorkspaceId: { [WS]: { isOpen: true, activeSurfaceId, surfaces } } }, version: 1 }));
  await useRightPanelStore.persist.rehydrate();
}

describe("rightPanelStore hydrate", () => {
  it("a stored value with a bad shape at the current version hydrates to a usable state", async () => {
    window.localStorage.setItem(KEY, JSON.stringify({ state: { byWorkspaceId: { [WS]: { isOpen: true, activeSurfaceId: "diff" } } }, version: 1 }));
    await useRightPanelStore.persist.rehydrate();
    const state = selectWorkspaceRightPanelState(useRightPanelStore.getState().byWorkspaceId, WS);
    expect(state).toEqual({ isOpen: true, activeSurfaceId: null, surfaces: [] });
    expect(selectActiveRightPanel(useRightPanelStore.getState().byWorkspaceId, WS)).toBeNull();
  });

  it("drops surfaces of an unknown kind and terminal surfaces without pty ids; the active id follows what is left", async () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({
        state: {
          byWorkspaceId: {
            [WS]: {
              isOpen: true,
              activeSurfaceId: "terminal:t_bad",
              surfaces: [
                { id: "plan", kind: "plan" },
                { id: "terminal:t_bad", kind: "terminal", resourceId: "t_bad" },
                { id: "terminal:p1", kind: "terminal", resourceId: "p1", terminalIds: ["p1", "p2"], activeTerminalId: "p9" },
                { id: "diff", kind: "diff" },
              ],
            },
          },
        },
        version: 1,
      }),
    );
    await useRightPanelStore.persist.rehydrate();
    const byWorkspaceId = useRightPanelStore.getState().byWorkspaceId;
    const state = selectWorkspaceRightPanelState(byWorkspaceId, WS);
    expect(state.surfaces.map(s => s.id)).toEqual(["terminal:p1", "diff"]);
    expect(state.activeSurfaceId).toBe("terminal:p1");
    expect(state.surfaces[0]).toMatchObject({ terminalIds: ["p1", "p2"], activeTerminalId: "p1" });
    expect(selectPanelTerminalIds(byWorkspaceId, WS)).toEqual(["p1", "p2"]);
  });

  it("drops a file surface without a path and a preview without a tab id; keeps the placeholder preview and fills a file's reveal fields", async () => {
    await hydrate(
      [
        { id: "file:x", kind: "file" },
        { id: "browser:t9", kind: "preview" },
        { id: "browser:new", kind: "preview", resourceId: null },
        { id: "file:src/a.ts", kind: "file", relativePath: "src/a.ts" },
        { id: "browser:t1", kind: "preview", resourceId: "t1" },
      ],
      "file:x",
    );
    const state = selectWorkspaceRightPanelState(useRightPanelStore.getState().byWorkspaceId, WS);
    expect(state.surfaces).toEqual([
      { id: "browser:new", kind: "preview", resourceId: null },
      { id: "file:src/a.ts", kind: "file", relativePath: "src/a.ts", revealLine: null, revealRequestId: 0 },
      { id: "browser:t1", kind: "preview", resourceId: "t1" },
    ]);
    expect(state.activeSurfaceId).toBe("browser:new");
  });

  it("the tab strip renders after hydrating a file surface without a path", async () => {
    useStore.setState({ api: null, conn: "live", capabilities: null, workspaces: [view], statuses: {}, costs: {}, spending: {}, toast: null, selectedId: WS, sessions: {}, ready: true });
    await hydrate([{ id: "file:x", kind: "file" }, { id: "diff", kind: "diff" }], "diff");
    const Panel = () => {
      const state = useRightPanelStore(s => selectWorkspaceRightPanelState(s.byWorkspaceId, WS));
      return <RightPanel workspaceId={WS} state={state} mode="inline" />;
    };
    render(<Panel />);
    expect(screen.getAllByText(/diff/i).length).toBeGreaterThan(0);
  });

  it("a stored value that is not an object hydrates to the empty map", async () => {
    window.localStorage.setItem(KEY, JSON.stringify({ state: { byWorkspaceId: 7 }, version: 1 }));
    await useRightPanelStore.persist.rehydrate();
    expect(useRightPanelStore.getState().byWorkspaceId).toEqual({});
  });
});
