// SPDX-License-Identifier: AGPL-3.0-only
// The palette over the shell: opens on its shortcut, filters, runs actions;
// every default shortcut dispatches into the sidebar, the right panel store
// and the terminal link; when-clauses and typing contexts are respected.
import { act, configure, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionView, WorkspaceView } from "@wsp/protocol";
import { SidebarProvider, useSidebar } from "../src/components/ui/sidebar.js";
import { compileResolvedKeybindingsConfig } from "../src/keybindingDefaults.js";
import type { Api } from "../src/protocol/client.js";
import { useStore } from "../src/protocol/store.js";
import { useRightPanelStore } from "../src/rightPanelStore.js";
import { AppShell } from "../src/shell/AppShell.js";
import { KeybindingDispatcher } from "../src/shell/KeybindingDispatcher.js";
import { onNewThreadRequest } from "../src/shell/shellRequests.js";
import { useTerminalDrawerStore } from "../src/terminal/drawerStore.js";
import { provideTerminals, WorkspaceTerminals } from "../src/terminal/link.js";

const view = (id: string, name: string, phase: WorkspaceView["phase"] = "running"): WorkspaceView => ({
  id,
  name,
  machineId: `m_${id}`,
  phase,
  golden: "snap_g",
  createdAt: `2026-09-01T00:0${id.length}:00Z`,
});

const session = (id: string, workspaceId: string, prompt: string): SessionView => ({
  id,
  workspaceId,
  harness: "claude",
  status: "completed",
  prompt,
  startedAt: Date.now() - 60_000,
});

const CAPS = { liveCloneForks: true, ramPreservingPause: true, resize: true, previewUrls: true, signedUrls: true, containers: true, callbackRelay: true };

function fakeApi(workspaces: WorkspaceView[], sessions: SessionView[]): Api & { nap: ReturnType<typeof vi.fn> } {
  return {
    listWorkspaces: async () => workspaces,
    getWorkspace: async id => workspaces.find(w => w.id === id)!,
    createWorkspace: async () => workspaces[0]!,
    createFromGoldenHead: async () => workspaces[0]!,
    watchStatuses: async () => [],
    nap: vi.fn(async (id: string) => view(id, "?", "napping")),
    wake: async id => workspaces.find(w => w.id === id)!,
    upgrade: async id => workspaces.find(w => w.id === id)!,
    capabilities: async () => CAPS,
    startSession: async o => ({ id: "s1", workspaceId: o.workspaceId, harness: "claude", status: "running" }),
    portReach: async (_id, port) => ({ url: `https://m1-${port}.preview.example/?pt_token=e`, expiresAt: Date.now() + 3_600_000 }),
    daemonReach: async () => ({ url: "ws://127.0.0.1:1", expiresAt: 0 }),
    builderReach: async () => ({ url: "ws://127.0.0.1:1", expiresAt: 0 }),
    sessionHistory: async () => [],
    listSnapshots: async () => ({ name: "default", head: null, versions: [] }),
    rollbackSnapshot: async () => ({ lineage: { name: "default", head: null, versions: [] }, existingWorkspaces: "untouched" }),
    listSessions: async () => sessions,
    subscribe: () => () => {},
    getGolden: async () => undefined,
    prepareGolden: async () => { throw new Error("no wizard in this fixture"); },
    sealGolden: async () => { throw new Error("no wizard in this fixture"); },
  };
}

/** A terminal link whose daemon is a counter: every pty.create hands out the next id. */
function fakeTerminals(): WorkspaceTerminals {
  let n = 0;
  return new WorkspaceTerminals({
    request: async (op: string) => (op === "pty.create" ? { ptyId: `pty${++n}` } : {}),
  });
}

const mod = (key: string, mods: { shiftKey?: boolean; altKey?: boolean } = {}, target: Element | Window = window) =>
  fireEvent.keyDown(target, { key, code: `Key${key.toUpperCase()}`, metaKey: true, ...mods });

const palette = () => document.querySelector<HTMLElement>("[data-command-palette]");
const inPalette = () => within(palette()!);
const tabbar = () => document.querySelector("[data-right-panel-tabbar]");
const sidebarState = () => document.querySelector('[data-slot="sidebar"]')?.getAttribute("data-state");
const panel = (id: string) => useRightPanelStore.getState().byWorkspaceId[id];
const drawer = (id: string) => useTerminalDrawerStore.getState().byWorkspaceId[id];
const settle = () => act(() => new Promise<void>(resolve => setTimeout(resolve, 0)));

// Shell render plus palette open and close: about 250 ms idle, under 1.5 s with eight CPU hogs; a saturated box has pushed the whole test past 5 s.
// Every waitFor in the file shares the 10 s ceiling too, else one wait trips at the library's 1 s default before the test budget applies.
vi.setConfig({ testTimeout: 15_000 });
configure({ asyncUtilTimeout: 10_000 });

beforeEach(() => {
  window.localStorage.clear();
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  useStore.setState({ api: null, conn: "live", capabilities: null, workspaces: [], statuses: {}, costs: {}, spending: {}, toast: null, selectedId: null, sessions: {}, ready: false });
  useRightPanelStore.setState({ byWorkspaceId: {} });
  useTerminalDrawerStore.setState({ byWorkspaceId: {} });
});

afterEach(() => {
  vi.restoreAllMocks();
  provideTerminals("ws_a", null);
  provideTerminals("ws_b", null);
});

async function mountShell(sessions: SessionView[] = []) {
  const api = fakeApi([view("ws_a", "api"), view("ws_b", "worker")], sessions);
  useStore.getState().bind(api);
  render(
    <AppShell>
      <div>center content</div>
    </AppShell>,
  );
  await waitFor(() => expect(useStore.getState().selectedId).toBe("ws_a"));
  await waitFor(() => expect(useStore.getState().workspaces.length).toBe(2));
  return api;
}

describe("command palette", () => {
  it("opens on mod+k, lists actions, workspaces and threads, and closes on mod+k again", async () => {
    await mountShell([session("s1", "ws_b", "fix the flaky test")]);
    expect(palette()).toBeNull();
    mod("k");
    await waitFor(() => expect(palette()).not.toBeNull());
    expect(inPalette().getByText("Toggle right panel")).toBeTruthy();
    expect(inPalette().getAllByText("worker").length).toBeGreaterThan(0);
    expect(inPalette().getByText("fix the flaky test")).toBeTruthy();
    mod("k");
    await waitFor(() => expect(palette()).toBeNull());
  });

  it("filters by query and switches workspace from a row", async () => {
    await mountShell();
    mod("k");
    await waitFor(() => expect(palette()).not.toBeNull());
    fireEvent.change(screen.getByPlaceholderText(/Search commands/), { target: { value: "work" } });
    await waitFor(() => expect(inPalette().queryByText("Toggle sidebar")).toBeNull());
    fireEvent.click(inPalette().getByText("worker"));
    await waitFor(() => expect(palette()).toBeNull());
    expect(useStore.getState().selectedId).toBe("ws_b");
  });

  it("runs an action: pausing the selected workspace calls nap", async () => {
    const api = await mountShell();
    mod("k");
    await waitFor(() => expect(palette()).not.toBeNull());
    fireEvent.change(screen.getByPlaceholderText(/Search commands/), { target: { value: ">pause" } });
    fireEvent.click(await screen.findByText("Pause workspace"));
    await waitFor(() => expect(api.nap).toHaveBeenCalledWith("ws_a"));
    expect(palette()).toBeNull();
  });

  it("opens the new-workspace dialog through the sidebar", async () => {
    await mountShell();
    mod("k");
    await waitFor(() => expect(palette()).not.toBeNull());
    fireEvent.click(screen.getByText("New workspace", { selector: "[data-slot=command-item] span" }));
    await waitFor(() => expect(screen.getByRole("dialog", { name: "New workspace" })).toBeTruthy());
  });

  it("raises a new-thread request for the selected workspace", async () => {
    await mountShell();
    const seen: string[] = [];
    const off = onNewThreadRequest(d => seen.push(d.workspaceId));
    mod("k");
    await waitFor(() => expect(palette()).not.toBeNull());
    fireEvent.click(screen.getByText("New thread"));
    expect(seen).toEqual(["ws_a"]);
    off();
  });

  it("stays shut while the terminal owns focus", async () => {
    await mountShell();
    const term = document.createElement("div");
    term.dataset["terminalOwner"] = "drawer";
    const ta = document.createElement("textarea");
    term.appendChild(ta);
    document.body.appendChild(term);
    ta.focus();
    mod("k", {}, ta);
    await settle();
    expect(palette()).toBeNull();
    term.remove();
  });
});

describe("default shortcuts", () => {
  it("mod+b toggles the sidebar", async () => {
    await mountShell();
    expect(sidebarState()).toBe("expanded");
    mod("b");
    await waitFor(() => expect(sidebarState()).toBe("collapsed"));
  });

  it("mod+alt+b toggles the right panel and the header tooltip names it", async () => {
    await mountShell();
    expect(tabbar()).not.toBeNull();
    fireEvent.keyDown(window, { key: "∫", code: "KeyB", metaKey: true, altKey: true });
    await waitFor(() => expect(tabbar()).toBeNull());
    expect(panel("ws_a")?.isOpen).toBe(false);
  });

  it("mod+shift+j toggles the browser surface", async () => {
    await mountShell();
    mod("j", { shiftKey: true });
    await waitFor(() => expect(panel("ws_a")?.activeSurfaceId).toBe("browser:new"));
    mod("j", { shiftKey: true });
    await waitFor(() => expect(panel("ws_a")?.isOpen).toBe(false));
  });

  it("mod+j toggles the terminal drawer and never touches the right panel", async () => {
    await mountShell();
    provideTerminals("ws_a", fakeTerminals());
    mod("j");
    await waitFor(() => expect(drawer("ws_a")?.terminalOpen).toBe(true));
    mod("j");
    await waitFor(() => expect(drawer("ws_a")?.terminalOpen ?? false).toBe(false));
    expect(panel("ws_a")?.surfaces.filter(s => s.kind === "terminal") ?? []).toEqual([]);
  });

  it("mod+d splits and mod+n opens a drawer terminal only while the terminal has focus", async () => {
    await mountShell();
    provideTerminals("ws_a", fakeTerminals());
    mod("d");
    await settle();
    expect(drawer("ws_a")).toBeUndefined();

    const term = document.createElement("div");
    term.dataset["terminalOwner"] = "drawer";
    const ta = document.createElement("textarea");
    term.appendChild(ta);
    document.body.appendChild(term);
    ta.focus();
    mod("n", {}, ta);
    await waitFor(() => expect(drawer("ws_a")?.terminalIds).toEqual(["pty1"]));
    expect(drawer("ws_a")?.terminalOpen).toBe(true);
    mod("d", {}, ta);
    await waitFor(() => expect(drawer("ws_a")?.terminalGroups.map(g => g.terminalIds)).toEqual([["pty1", "pty2"]]));
    mod("n", {}, ta);
    await waitFor(() => expect(drawer("ws_a")?.terminalGroups.map(g => g.terminalIds)).toEqual([["pty1", "pty2"], ["pty3"]]));
    expect(panel("ws_a")?.surfaces.filter(s => s.kind === "terminal") ?? []).toEqual([]);
    term.remove();
  });

  it("mod+d and mod+n act on the right panel's terminal while one of its terminals has focus", async () => {
    await mountShell();
    const terms = fakeTerminals();
    provideTerminals("ws_a", terms);
    const tab = await terms.open();
    act(() => useRightPanelStore.getState().openTerminal("ws_a", tab.ptyId));
    await waitFor(() => expect(panel("ws_a")?.activeSurfaceId).toBe("terminal:pty1"));

    const term = document.createElement("div");
    term.dataset["terminalOwner"] = "right-panel";
    const ta = document.createElement("textarea");
    term.appendChild(ta);
    document.body.appendChild(term);
    ta.focus();
    mod("d", {}, ta);
    await waitFor(() => {
      const surface = panel("ws_a")?.surfaces[0];
      expect(surface?.kind === "terminal" && surface.terminalIds).toEqual(["pty1", "pty2"]);
    });
    mod("n", {}, ta);
    await waitFor(() => expect(panel("ws_a")?.activeSurfaceId).toBe("terminal:pty3"));
    expect(drawer("ws_a")).toBeUndefined();
    term.remove();
  });

  it("reports a missing terminal link instead of failing silently", async () => {
    await mountShell();
    const term = document.createElement("div");
    term.dataset["terminalOwner"] = "drawer";
    const ta = document.createElement("textarea");
    term.appendChild(ta);
    document.body.appendChild(term);
    ta.focus();
    mod("n", {}, ta);
    await waitFor(() => expect(useStore.getState().toast).toContain("no terminal link"));
    term.remove();
  });
});

describe("typing contexts", () => {
  const rules = compileResolvedKeybindingsConfig([
    { key: "b", command: "sidebar.toggle" },
    { key: "mod+b", command: "sidebar.toggle" },
  ]);

  function SidebarOpenProbe() {
    return <span data-testid="sidebar-open">{String(useSidebar().open)}</span>;
  }

  function mountDispatcher() {
    render(
      <SidebarProvider defaultOpen>
        <KeybindingDispatcher keybindings={rules} />
        <SidebarOpenProbe />
        <input aria-label="probe" />
      </SidebarProvider>,
    );
  }
  const sidebarOpen = () => screen.getByTestId("sidebar-open").textContent;

  it("ignores a bare key typed into an input but honours the same key chorded", async () => {
    mountDispatcher();
    const input = screen.getByLabelText("probe");
    input.focus();
    fireEvent.keyDown(input, { key: "b", code: "KeyB" });
    await settle();
    expect(sidebarOpen()).toBe("true");
    fireEvent.keyDown(input, { key: "b", code: "KeyB", metaKey: true });
    await waitFor(() => expect(sidebarOpen()).toBe("false"));
  });

  it("fires a bare key outside a typing context", async () => {
    mountDispatcher();
    fireEvent.keyDown(window, { key: "b", code: "KeyB" });
    await waitFor(() => expect(sidebarOpen()).toBe("false"));
  });
});
