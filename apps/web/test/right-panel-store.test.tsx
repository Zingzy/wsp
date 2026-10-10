// SPDX-License-Identifier: AGPL-3.0-only
// The right panel store's persisted shape is read on every render; a value
// stored at the current version with a shape this build cannot render must
// hydrate to something usable, since zustand runs migrate only on a version
// change.
import { cleanup, render, screen } from "@testing-library/react";
import type { WorkspaceView } from "@wsp/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useStore } from "../src/protocol/store.js";
import { guestCapLine, keepListedPanels, openBrowserAt, roomForBrowserTab, selectActiveRightPanel, selectPanelTerminalIds, selectWorkspaceRightPanelState, useRightPanelStore } from "../src/rightPanelStore.js";
import { RightPanel } from "../src/shell/RightPanel.js";
import { useBrowserTabs } from "../src/browser/tabs.js";
import { GUEST_CAP, hideGuest, resetGuests, showGuest, useGuests } from "../src/browser/guests.js";
import { HERE_KEY } from "../src/terminal/computer.js";
import { clearNotices, lastNotice, noticeTexts } from "./notice-text.js";

const KEY = "wsp:right-panel-state:v1";
const WS = "ws_panel_store";

const view: WorkspaceView = { id: WS, name: "panel", machineId: "m_panel", project: { id: "pr_1", name: "the-project", path: "/root", computer: "default" }, phase: "running", golden: "snap_g", createdAt: "2026-09-01T00:00:00Z" };

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

describe("a new browser tab from the panel", () => {
  it("opens a new browser tab on the servers list each time, active, beside the one already open", () => {
    const { open, openNewBrowser } = useRightPanelStore.getState();
    open(WS, "preview");
    openNewBrowser(WS);
    openNewBrowser(WS);
    const state = selectWorkspaceRightPanelState(useRightPanelStore.getState().byWorkspaceId, WS);
    const browsers = state.surfaces.filter(surface => surface.kind === "preview");
    expect(browsers).toHaveLength(2);
    expect(new Set(browsers.map(surface => surface.id)).size).toBe(2);
    expect(state.activeSurfaceId).toBe(browsers[1]!.id);
    for (const surface of browsers) {
      const tabId = surface.kind === "preview" ? surface.resourceId : null;
      expect(tabId).not.toBeNull();
      const tab = useBrowserTabs.getState().byWorkspaceId[WS]![tabId!]!;
      expect(tab.entries[tab.index]).toBeNull();
    }
  });

  it("every other road that opens the browser keeps reusing the tab already open", () => {
    const { openNewBrowser, open } = useRightPanelStore.getState();
    openNewBrowser(WS);
    open(WS, "preview");
    expect(selectWorkspaceRightPanelState(useRightPanelStore.getState().byWorkspaceId, WS).surfaces.filter(surface => surface.kind === "preview")).toHaveLength(1);
  });
});

describe("rightPanelStore hydrate", () => {
  it("keeps a stored Agents surface, and keeps it active", async () => {
    await hydrate([{ id: "diff", kind: "diff" }, { id: "agents", kind: "agents" }], "agents");
    const state = selectWorkspaceRightPanelState(useRightPanelStore.getState().byWorkspaceId, WS);
    expect(state.surfaces).toEqual([{ id: "diff", kind: "diff" }, { id: "agents", kind: "agents" }]);
    expect(selectActiveRightPanel(useRightPanelStore.getState().byWorkspaceId, WS)).toBe("agents");
  });

  it("opens Agents as one surface however often it is asked for", () => {
    useRightPanelStore.getState().open(WS, "agents");
    useRightPanelStore.getState().open(WS, "agents");
    expect(selectWorkspaceRightPanelState(useRightPanelStore.getState().byWorkspaceId, WS).surfaces).toEqual([{ id: "agents", kind: "agents" }]);
  });

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

  it("drops a surface of a kind this build no longer has and a preview without a tab id; keeps the placeholder preview", async () => {
    await hydrate(
      [
        { id: "file:x", kind: "file" },
        { id: "browser:t9", kind: "preview" },
        { id: "browser:new", kind: "preview", resourceId: null },
        { id: "screen", kind: "screen" },
        { id: "browser:t1", kind: "preview", resourceId: "t1" },
      ],
      "file:x",
    );
    const state = selectWorkspaceRightPanelState(useRightPanelStore.getState().byWorkspaceId, WS);
    expect(state.surfaces).toEqual([
      { id: "browser:new", kind: "preview", resourceId: null },
      { id: "browser:t1", kind: "preview", resourceId: "t1" },
    ]);
    expect(state.activeSurfaceId).toBe("browser:new");
  });

  it("drops the side question's tab, whose question lived in memory alone, and opens on the tab beside it", async () => {
    await hydrate([{ id: "machine", kind: "machine" }, { id: "aside", kind: "aside" }], "aside");
    const state = selectWorkspaceRightPanelState(useRightPanelStore.getState().byWorkspaceId, WS);
    expect(state.surfaces).toEqual([{ id: "machine", kind: "machine" }]);
    expect(state.activeSurfaceId).toBe("machine");
  });

  it("the tab strip renders after hydrating a surface of a kind this build no longer has", async () => {
    useStore.setState({ api: null, conn: "live", capabilities: null, workspaces: [view], statuses: {}, costs: {}, spending: {}, selectedId: WS, sessions: {}, ready: true });
    clearNotices();
    await hydrate([{ id: "file:x", kind: "file" }, { id: "diff", kind: "diff" }], "diff");
    const Panel = () => {
      const state = useRightPanelStore(s => selectWorkspaceRightPanelState(s.byWorkspaceId, WS));
      return <RightPanel workspaceId={WS} state={state} mode="inline" />;
    };
    render(<Panel />);
    expect(screen.getAllByText(/changes/i).length).toBeGreaterThan(0);
  });

  it("a stored value that is not an object hydrates to the empty map", async () => {
    window.localStorage.setItem(KEY, JSON.stringify({ state: { byWorkspaceId: 7 }, version: 1 }));
    await useRightPanelStore.persist.rehydrate();
    expect(useRightPanelStore.getState().byWorkspaceId).toEqual({});
  });
});

describe("the browser tab cap counts guests holding a page", () => {
  const LIVE = "ws_live";
  const RECT = { x: 0, y: 0, width: 400, height: 300, raised: false };
  const browserTabsOf = (workspaceId: string) =>
    (useRightPanelStore.getState().byWorkspaceId[workspaceId]?.surfaces ?? []).filter(s => s.kind === "preview" && s.resourceId !== null);
  /** A guest holding a page for a tab of this workspace, shown and then hidden at the time given. */
  const loaded = (workspaceId: string, n: number, hiddenAt: number) => {
    const key = `${workspaceId}/t${n}`;
    showGuest(key, { workspaceId, tabId: `t${n}`, src: "https://github.com/", route: null, loaded: 0 }, RECT);
    hideGuest(key, hiddenAt);
    return key;
  };

  beforeEach(() => {
    resetGuests();
    clearNotices();
  });
  afterEach(resetGuests);

  it("never counts saved tabs with no page loaded, those of a workspace removed last week among them", async () => {
    const saved = Array.from({ length: 10 }, (_, i) => ({ id: `browser:old${i}`, kind: "preview", resourceId: `old${i}` }));
    window.localStorage.setItem(KEY, JSON.stringify({ state: { byWorkspaceId: { ws_deleted_last_week: { isOpen: true, activeSurfaceId: null, surfaces: saved } } }, version: 1 }));
    await useRightPanelStore.persist.rehydrate();
    expect(useRightPanelStore.getState().byWorkspaceId["ws_deleted_last_week"]?.surfaces).toHaveLength(10);
    useRightPanelStore.getState().openNewBrowser(LIVE);
    expect(browserTabsOf(LIVE)).toHaveLength(1);
    expect(noticeTexts()).toEqual([]);
  });

  it("refuses a tab once ten guests hold a page, saying how many and how many are in other threads", () => {
    for (let i = 0; i < 6; i++) loaded(LIVE, i, 1_000 + i);
    for (let i = 0; i < 4; i++) loaded("ws_other", i, 2_000 + i);
    expect(Object.keys(useGuests.getState().guests)).toHaveLength(GUEST_CAP);
    useRightPanelStore.getState().openNewBrowser(LIVE);
    expect(browserTabsOf(LIVE)).toHaveLength(0);
    expect(lastNotice()).toBe("10 browser tabs have a page open, the most wsp keeps. Close one to open another; 4 of them are in other threads.");
    openBrowserAt(LIVE, { port: 3000, path: "/" });
    expect(browserTabsOf(LIVE)).toHaveLength(0);
    expect(guestCapLine(10, 0)).toBe("10 browser tabs have a page open, the most wsp keeps. Close one to open another.");
    expect(guestCapLine(10, 1)).toBe("10 browser tabs have a page open, the most wsp keeps. Close one to open another; 1 of them is in another thread.");
    expect(roomForBrowserTab("ws_other")).toBe(false);
    expect(lastNotice()).toContain("6 of them are in other threads");
  });

  it("a link in a reply opens a tab on its place while there is room", () => {
    openBrowserAt(LIVE, { port: 3000, path: "/docs" });
    const [tab] = browserTabsOf(LIVE);
    expect(useRightPanelStore.getState().byWorkspaceId[LIVE]?.activeSurfaceId).toBe(tab?.id);
  });

  it("a saved tab shown again past the cap unloads the guest hidden longest, so no more than ten are ever held", () => {
    const keys = Array.from({ length: GUEST_CAP }, (_, i) => loaded(LIVE, i, 5_000 - i));
    showGuest(`${LIVE}/t99`, { workspaceId: LIVE, tabId: "t99", src: "https://github.com/", route: null, loaded: 0 }, RECT);
    const held = Object.keys(useGuests.getState().guests);
    expect(held).toHaveLength(GUEST_CAP);
    expect(held).not.toContain(keys[GUEST_CAP - 1]);
    expect(held).toContain(`${LIVE}/t99`);
  });
});

describe("a workspace the host stops listing", () => {
  const listed = (ids: string[]): WorkspaceView[] => ids.map(id => ({ ...view, id }));

  it("drops its panel and its browser tabs, and keeps this computer's own panel and the listed ones", () => {
    useStore.setState({ ready: false, workspaces: [], creations: [] });
    const store = useRightPanelStore.getState();
    for (const id of ["ws_kept", "ws_gone", HERE_KEY]) store.open(id, "diff");
    const tab = useBrowserTabs.getState().createTab("ws_gone", { url: "https://github.com/" });
    store.openBrowser("ws_gone", tab);
    const stop = keepListedPanels();
    try {
      expect(Object.keys(useRightPanelStore.getState().byWorkspaceId).sort()).toEqual([HERE_KEY, "ws_gone", "ws_kept"].sort());
      useStore.setState({ ready: true, workspaces: listed(["ws_kept"]) });
      expect(Object.keys(useRightPanelStore.getState().byWorkspaceId).sort()).toEqual([HERE_KEY, "ws_kept"].sort());
      expect(useBrowserTabs.getState().byWorkspaceId["ws_gone"]).toBeUndefined();
      useStore.setState({ workspaces: [] });
      expect(Object.keys(useRightPanelStore.getState().byWorkspaceId)).toEqual([HERE_KEY]);
    } finally {
      stop();
      useStore.setState({ ready: false, workspaces: [] });
    }
  });
});
