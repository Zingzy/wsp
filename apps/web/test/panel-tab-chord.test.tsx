// SPDX-License-Identifier: AGPL-3.0-only
// The Tab pair inside the right panel: with focus there and more than one tab
// open it steps the panel's tabs, wrapping, the focus landing in the tab it
// opens, and the switcher stays down. Anywhere else, and in a panel of one
// tab, the same chords open the switcher. A terminal in the panel hands the
// pair on rather than typing it.
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PREFERENCES, type SessionView, type WorkspaceView } from "@wsp/protocol";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "../src/keybindingDefaults.js";
import { isTerminalAppShortcut } from "../src/keybindings.js";
import type { Api } from "../src/protocol/client.js";
import { useStore } from "../src/protocol/store.js";
import { selectWorkspaceRightPanelState, useRightPanelStore } from "../src/rightPanelStore.js";
import { AppShell } from "../src/shell/AppShell.js";
import { useThreadHistory } from "../src/shell/threadHistory.js";
import { useWorkspaceSwitcher } from "../src/shell/workspaceSwitcher.js";
import { useTerminalDrawerStore } from "../src/terminal/drawerStore.js";
import { caps } from "./caps.js";
import { noDaemonApi } from "./fake-daemon-api.js";
import { clearNotices } from "./notice-text.js";

const CAPS = caps();
const MAC = "MacIntel";
const LINUX = "Linux x86_64";

const WORKSPACE: WorkspaceView = { id: "ws_a", name: "api", machineId: "m_a", project: { id: "pr_1", name: "the-project", path: "/root", computer: "default" }, phase: "running", golden: "snap_g", createdAt: "2026-09-01T00:00:00Z" };
const thread = (id: string, prompt: string, minutesAgo: number): SessionView => ({ id: `s_${id}`, threadId: id, workspaceId: "ws_a", harness: "claude", status: "completed", prompt, startedBy: "person", startedAt: Date.now() - minutesAgo * 60_000, endedAt: Date.now() - minutesAgo * 60_000 + 30_000 });
const THREADS = [thread("thr_1", "Fix the login redirect.", 5), thread("thr_2", "Bump the lockfile.", 10)];

function fakeApi(): Api {
  return {
    listWorkspaces: async () => [WORKSPACE],
    getWorkspace: async () => WORKSPACE,
    createWorkspace: async () => WORKSPACE,
    watchStatuses: async () => [],
    nap: async () => WORKSPACE,
    wake: async () => WORKSPACE,
    capabilities: async () => CAPS,
    startSession: async o => ({ id: "s9", workspaceId: o.workspaceId, harness: "claude", status: "running" }),
    portReach: async (_id, port) => ({ url: `https://m1-${port}.preview.example/?pt_token=e`, expiresAt: Date.now() + 3_600_000 }),
    daemon: noDaemonApi,
    sessionHistory: async () => [],
    listSnapshots: async () => ({ name: "default", head: null, versions: [] }),
    snapshotStorage: async () => null,
    rollbackSnapshot: async () => ({ lineage: { name: "default", head: null, versions: [] }, existingWorkspaces: "untouched" }),
    listSessions: async () => THREADS,
    subscribe: () => () => {},
    getGolden: async () => undefined,
  };
}

const ctrlTab = (target: Element | Window, mods: { shiftKey?: boolean } = {}) => fireEvent.keyDown(target, { key: "Tab", code: "Tab", ctrlKey: true, ...mods });
const panel = () => selectWorkspaceRightPanelState(useRightPanelStore.getState().byWorkspaceId, "ws_a");
const content = () => document.querySelector<HTMLElement>("[data-preview-panel-mode] [data-right-panel-surface-content]");

beforeEach(() => {
  window.localStorage.clear();
  vi.spyOn(navigator, "platform", "get").mockReturnValue(MAC);
  window.wsp = {};
  useStore.setState({ api: null, conn: "live", capabilities: null, workspaces: [], statuses: {}, costs: {}, spending: {}, selectedId: null, selectedThreadId: null, creations: [], sessions: {}, ready: false, preferences: { ...DEFAULT_PREFERENCES, labs: true } });
  clearNotices();
  useRightPanelStore.setState({ byWorkspaceId: {} });
  useTerminalDrawerStore.setState({ byWorkspaceId: {} });
  useThreadHistory.setState({ recent: [] });
  useWorkspaceSwitcher.getState().close();
});

afterEach(() => {
  cleanup();
  delete window.wsp;
  vi.restoreAllMocks();
});

async function mountWithTabs(kinds: ReadonlyArray<"machine" | "processes" | "pr">): Promise<string[]> {
  useStore.getState().bind(fakeApi());
  render(
    <AppShell>
      <div>center content</div>
    </AppShell>,
  );
  await waitFor(() => expect(useStore.getState().sessions["ws_a"]?.length).toBe(2));
  act(() => useStore.getState().select("ws_a", "thr_1"));
  act(() => {
    for (const kind of kinds) useRightPanelStore.getState().open("ws_a", kind);
  });
  await waitFor(() => expect(document.querySelectorAll("[data-right-panel-tab-list] [data-active-tab]")).toHaveLength(kinds.length));
  return panel().surfaces.map(surface => surface.id);
}

describe("the Tab pair inside the right panel", () => {
  it("steps to the next tab and back, wrapping, lands the focus in the tab it opened and leaves the switcher down", async () => {
    const ids = await mountWithTabs(["machine", "processes", "pr"]);
    expect(panel().activeSurfaceId).toBe(ids[2]);
    // A tab's own button holds the focus, as a click on the strip leaves it.
    act(() => document.querySelector<HTMLElement>("[data-right-panel-tab-list] [data-active-tab='true'] button:last-of-type")!.focus());
    expect(content()!.contains(document.activeElement)).toBe(false);
    ctrlTab(document.activeElement!);
    await waitFor(() => expect(panel().activeSurfaceId).toBe(ids[0]));
    await waitFor(() => expect(content()!.contains(document.activeElement)).toBe(true));
    ctrlTab(document.activeElement!);
    await waitFor(() => expect(panel().activeSurfaceId).toBe(ids[1]));
    expect(content()!.contains(document.activeElement)).toBe(true);
    ctrlTab(document.activeElement!, { shiftKey: true });
    await waitFor(() => expect(panel().activeSurfaceId).toBe(ids[0]));
    ctrlTab(document.activeElement!, { shiftKey: true });
    await waitFor(() => expect(panel().activeSurfaceId).toBe(ids[2]));
    expect(useWorkspaceSwitcher.getState().open).toBe(false);
    expect(useStore.getState().selectedThreadId).toBe("thr_1");
  });

  it("opens the switcher as before with the focus outside the panel", async () => {
    const ids = await mountWithTabs(["machine", "processes"]);
    act(() => (document.activeElement as HTMLElement | null)?.blur());
    ctrlTab(window);
    await waitFor(() => expect(useWorkspaceSwitcher.getState().open).toBe(true));
    expect(panel().activeSurfaceId).toBe(ids[1]);
  });

  it("opens the switcher from a panel of one tab, which has nowhere to step", async () => {
    await mountWithTabs(["machine"]);
    act(() => content()!.focus());
    ctrlTab(document.activeElement!);
    await waitFor(() => expect(useWorkspaceSwitcher.getState().open).toBe(true));
  });
});

describe("a terminal in the right panel", () => {
  /** A panel shaped as RightPanelTabs draws it, with a terminal's input inside its content. */
  function panelWith(tabs: number): { input: HTMLTextAreaElement; remove: () => void } {
    const root = document.createElement("div");
    root.dataset["previewPanelMode"] = "inline";
    const list = document.createElement("div");
    list.dataset["rightPanelTabList"] = "";
    for (let i = 0; i < tabs; i++) {
      const tab = document.createElement("div");
      tab.dataset["activeTab"] = String(i === 0);
      list.appendChild(tab);
    }
    const term = document.createElement("div");
    term.dataset["terminalOwner"] = "right-panel";
    const input = document.createElement("textarea");
    term.appendChild(input);
    root.append(list, term);
    document.body.appendChild(root);
    input.focus();
    return { input, remove: () => root.remove() };
  }
  const key = (key: string, mods: { ctrlKey?: boolean; shiftKey?: boolean; metaKey?: boolean } = {}) => ({ key, code: key === "Tab" ? "Tab" : `Key${key.toUpperCase()}`, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...mods });

  it("hands the Tab pair on to the shell while the panel holds more than one tab, on both platforms", () => {
    const { remove } = panelWith(2);
    try {
      for (const platform of [MAC, LINUX]) {
        expect(isTerminalAppShortcut(key("Tab", { ctrlKey: true }), DEFAULT_RESOLVED_KEYBINDINGS, platform)).toBe(true);
        expect(isTerminalAppShortcut(key("Tab", { ctrlKey: true, shiftKey: true }), DEFAULT_RESOLVED_KEYBINDINGS, platform)).toBe(true);
      }
      // The shell's own Control keys stay the shell's, a Control mod's chords included.
      expect(isTerminalAppShortcut(key("d", { ctrlKey: true }), DEFAULT_RESOLVED_KEYBINDINGS, LINUX)).toBe(false);
      expect(isTerminalAppShortcut(key("c", { ctrlKey: true }), DEFAULT_RESOLVED_KEYBINDINGS, MAC)).toBe(false);
    } finally {
      remove();
    }
  });

  it("keeps the pair with one tab, and in the drawer, where no tab is to step to", () => {
    const one = panelWith(1);
    try {
      expect(isTerminalAppShortcut(key("Tab", { ctrlKey: true }), DEFAULT_RESOLVED_KEYBINDINGS, MAC)).toBe(false);
    } finally {
      one.remove();
    }
    const drawer = document.createElement("div");
    drawer.dataset["terminalOwner"] = "drawer";
    const input = document.createElement("textarea");
    drawer.appendChild(input);
    document.body.appendChild(drawer);
    input.focus();
    try {
      expect(isTerminalAppShortcut(key("Tab", { ctrlKey: true }), DEFAULT_RESOLVED_KEYBINDINGS, MAC)).toBe(false);
    } finally {
      drawer.remove();
    }
  });
});
