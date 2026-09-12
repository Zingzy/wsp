// SPDX-License-Identifier: AGPL-3.0-only
// The shell's three regions, the right panel's toggle, resize and picker,
// and the banner that follows the runtime socket.
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SIDEBAR_DEFAULT_WIDTH } from "../src/shell/sidebarWidth.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PREFERENCES, HOST_ASLEEP_LINE, type WorkspaceView } from "@wsp/protocol";
import { App } from "../src/App.js";
import type { Api } from "../src/protocol/client.js";
import { useStore } from "../src/protocol/store.js";
import { sidebarMaxWidthBeside } from "../src/rightPanelLayout.js";
import { RIGHT_PANEL_WIDTH_STORAGE_KEY, useRightPanelStore } from "../src/rightPanelStore.js";
import { AppShell } from "../src/shell/AppShell.js";
import { onNewThreadRequest } from "../src/shell/shellRequests.js";
import { caps } from "./caps.js";
import { noDaemonApi } from "./fake-daemon-api.js";

const view = (id: string, name: string): WorkspaceView => ({
  id,
  name,
  machineId: `m_${id}`,
  phase: "running",
  golden: "snap_g",
  createdAt: "2026-09-01T00:00:00Z",
});

const CAPS = caps();

function fakeApi(workspaces: WorkspaceView[]): Api {
  return {
    listWorkspaces: async () => workspaces,
    getWorkspace: async id => workspaces.find(w => w.id === id)!,
    createWorkspace: async () => workspaces[0]!,
    createFromGoldenHead: async () => workspaces[0]!,
    watchStatuses: async () => [],
    nap: async id => workspaces.find(w => w.id === id)!,
    wake: async id => workspaces.find(w => w.id === id)!,
    upgrade: async id => workspaces.find(w => w.id === id)!,
    capabilities: async () => CAPS,
    startSession: async o => ({ id: "s1", workspaceId: o.workspaceId, harness: "claude", status: "running" }),
    portReach: async (_id, port) => ({ url: `https://m1-${port}.preview.example/?pt_token=e`, expiresAt: Date.now() + 3_600_000 }),
    daemon: noDaemonApi,
    sessionHistory: async () => [],
    listSnapshots: async () => ({ name: "default", head: null, versions: [] }),
    snapshotStorage: async () => null,
    rollbackSnapshot: async () => ({ lineage: { name: "default", head: null, versions: [] }, existingWorkspaces: "untouched" }),
    listSessions: async () => [],
    subscribe: () => () => {},
    getGolden: async () => undefined,
  };
}

beforeEach(() => {
  window.localStorage.clear();
  useStore.setState({ api: null, conn: "connecting", capabilities: null, workspaces: [], statuses: {}, costs: {}, spending: {}, toast: null, selectedId: null, sessions: {}, ready: false, gaps: 0 });
  useRightPanelStore.setState({ byWorkspaceId: {} });
});

/** jsdom's own window width, put back after a case that sets its own. */
const JSDOM_INNER_WIDTH = window.innerWidth;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.innerWidth = JSDOM_INNER_WIDTH;
  delete (window as unknown as { __WSP__?: unknown }).__WSP__;
});

async function mountShell() {
  useStore.getState().bind(fakeApi([view("ws_a", "api")]));
  const result = render(
    <AppShell>
      <div>center content</div>
    </AppShell>,
  );
  await waitFor(() => expect(useStore.getState().selectedId).toBe("ws_a"));
  return result;
}

const tabbar = () => document.querySelector("[data-right-panel-tabbar]");
/** The boot object the host inlined into this page: with a token it was served on this computer's loopback, without
 * one it was served beyond it, which is the app's one reading of a window on another computer. */
const served = (token: string | undefined): void => {
  (window as unknown as { __WSP__?: unknown }).__WSP__ = { wsPort: 7788, wsPath: "/ws", paired: true, version: "0.0.0", ...(token === undefined ? {} : { token }) };
};
// Lets the kit's post-mount effects (scroll fades, the machine surface's lineage fetch) settle inside act.
const settle = () => act(() => new Promise<void>(resolve => setTimeout(resolve, 0)));

describe("app shell", () => {
  it("renders the sidebar, the center and the right panel", async () => {
    await mountShell();
    const sidebar = document.querySelector('[data-slot="sidebar"]');
    expect(sidebar?.textContent).toContain("Workspaces");
    expect(sidebar?.textContent).toContain("api");
    expect(screen.getByText("center content")).toBeTruthy();
    expect(tabbar()).not.toBeNull();
    // The launcher's own words, in the person's word for one of these: a panel, never a surface.
    expect(screen.getByText("Open a panel")).toBeTruthy();
    expect(document.body.textContent).not.toContain("surface");
  });

  it("toggles the right panel from the layout control", async () => {
    await mountShell();
    fireEvent.click(screen.getByRole("button", { name: "Toggle right panel" }));
    expect(tabbar()).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Toggle right panel" }));
    await settle();
    expect(tabbar()).not.toBeNull();
  });

  it("resizes the right panel by its handle and persists the width", async () => {
    // jsdom has no layout, pointer capture or PointerEvent; the hook needs all three to run.
    Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 1400 });
    vi.stubGlobal(
      "PointerEvent",
      class extends MouseEvent {
        readonly pointerId: number;
        constructor(type: string, init: MouseEventInit & { pointerId?: number } = {}) {
          super(type, init);
          this.pointerId = init.pointerId ?? 0;
        }
      },
    );
    HTMLElement.prototype.setPointerCapture = () => {};
    HTMLElement.prototype.releasePointerCapture = () => {};
    HTMLElement.prototype.hasPointerCapture = () => true;
    vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => { fn(0); return 1; });
    await mountShell();
    const panel = document.querySelector<HTMLElement>('[data-preview-panel-mode="inline"]')!;
    expect(panel.style.width).toBe("540px");
    const handle = screen.getByRole("separator");
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 800 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 700 });
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 700 });
    expect(panel.style.width).toBe("640px");
    expect(window.localStorage.getItem(RIGHT_PANEL_WIDTH_STORAGE_KEY)).toBe("640");
  });

  it("a load paints the kept width and the Spaces body from this browser's first-paint cache before the host answers, and the record wins when it lands", async () => {
    window.localStorage.setItem("wsp:first-paint", JSON.stringify({ theme: "dark", sidebarWidth: 312, sidebarMode: "spaces", labs: true }));
    vi.resetModules();
    const { useStore: bootStore } = await import("../src/protocol/store.js");
    const { AppShell: BootShell } = await import("../src/shell/AppShell.js");
    // A host that has not answered yet: the record is pending for the whole first frame.
    let answer: ((p: import("@wsp/protocol").Preferences) => void) | undefined;
    const api = { ...fakeApi([view("ws_a", "api"), view("ws_b", "web")]), preferences: () => new Promise<import("@wsp/protocol").Preferences>(r => (answer = r)) };
    bootStore.getState().bind(api);
    render(
      <BootShell>
        <div>center content</div>
      </BootShell>,
    );
    const wrapper = document.querySelector<HTMLElement>("[data-slot='sidebar-wrapper']")!;
    expect(wrapper.style.getPropertyValue("--sidebar-width")).toBe("312px");
    await waitFor(() => expect(document.querySelector("[data-space-header]")).not.toBeNull());
    // Spaces: the one workspace row is the space's header.
    expect(document.querySelectorAll("[data-row-id^='ws:']")).toHaveLength(1);
    await act(async () => answer!({ ...DEFAULT_PREFERENCES, labs: true, sidebarMode: "list" }));
    await waitFor(() => expect(document.querySelectorAll("[data-row-id^='ws:']")).toHaveLength(2));
    expect(wrapper.style.getPropertyValue("--sidebar-width")).toBe(`${SIDEBAR_DEFAULT_WIDTH}px`);
    expect(JSON.parse(window.localStorage.getItem("wsp:first-paint")!)).toEqual({ theme: "system", sidebarMode: "list", labs: true });
  });

  it("the sidebar opens at the width the host's record holds, follows a change to it, a cleared width puts the default back, and beside the inline panel a narrow window holds it to the shell's rule without touching the record", async () => {
    // A window every width here fits in; jsdom's own 1024 would already hold the sidebar to the rule.
    window.innerWidth = 1280;
    vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => { fn(0); return 1; });
    useStore.setState({ preferences: { ...DEFAULT_PREFERENCES, labs: true, sidebarWidth: 312 } });
    await mountShell();
    const wrapper = document.querySelector<HTMLElement>("[data-slot='sidebar-wrapper']")!;
    expect(wrapper.style.getPropertyValue("--sidebar-width")).toBe("312px");
    act(() => useStore.setState({ preferences: { ...DEFAULT_PREFERENCES, labs: true, sidebarWidth: 400 } }));
    expect(wrapper.style.getPropertyValue("--sidebar-width")).toBe("400px");
    // Past the sidebar's own bounds the kept width is held to them.
    act(() => useStore.setState({ preferences: { ...DEFAULT_PREFERENCES, labs: true, sidebarWidth: 900 } }));
    expect(wrapper.style.getPropertyValue("--sidebar-width")).toBe("480px");
    // The panel is inline: at 1024 px the sidebar gives way to what is left once the panel and the centre keep their
    // minimums, the record keeps the person's width, and closing the panel gives the sidebar its width back.
    expect(document.querySelector('[data-preview-panel-mode="inline"]')).not.toBeNull();
    window.innerWidth = 1024;
    act(() => void window.dispatchEvent(new Event("resize")));
    expect(wrapper.style.getPropertyValue("--sidebar-width")).toBe(`${sidebarMaxWidthBeside(1024, true)}px`);
    expect(useStore.getState().preferences.sidebarWidth).toBe(900);
    act(() => useRightPanelStore.getState().close("ws_a"));
    expect(wrapper.style.getPropertyValue("--sidebar-width")).toBe("480px");
    act(() => useStore.setState({ preferences: { ...DEFAULT_PREFERENCES, labs: true } }));
    expect(wrapper.style.getPropertyValue("--sidebar-width")).toBe(`${SIDEBAR_DEFAULT_WIDTH}px`);
  });

  it("a press on the rail without travel leaves the record alone, and a drag writes the width it asked for held to the record's own bounds, not the panel's cap", async () => {
    vi.stubGlobal(
      "PointerEvent",
      class extends MouseEvent {
        readonly pointerId: number;
        constructor(type: string, init: MouseEventInit & { pointerId?: number } = {}) {
          super(type, init);
          this.pointerId = init.pointerId ?? 0;
        }
      },
    );
    HTMLElement.prototype.setPointerCapture = () => {};
    HTMLElement.prototype.releasePointerCapture = () => {};
    HTMLElement.prototype.hasPointerCapture = () => true;
    vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => { fn(0); return 1; });
    useStore.setState({ preferences: { ...DEFAULT_PREFERENCES, labs: true, sidebarWidth: 480 } });
    await mountShell();
    expect(document.querySelector('[data-preview-panel-mode="inline"]')).not.toBeNull();
    const rail = document.querySelector<HTMLElement>("[data-slot='sidebar-rail']")!;
    // jsdom draws the sidebar at no width, so every drag starts from the kit's minimum.
    fireEvent.pointerDown(rail, { button: 0, pointerId: 1, clientX: 220 });
    fireEvent.pointerUp(rail, { pointerId: 1, clientX: 220 });
    expect(useStore.getState().preferences.sidebarWidth).toBe(480);
    fireEvent.pointerDown(rail, { button: 0, pointerId: 1, clientX: 220 });
    fireEvent.pointerMove(rail, { pointerId: 1, clientX: 520 });
    fireEvent.pointerUp(rail, { pointerId: 1, clientX: 520 });
    expect(useStore.getState().preferences.sidebarWidth).toBe(480);
    fireEvent.pointerDown(rail, { button: 0, pointerId: 1, clientX: 220 });
    fireEvent.pointerMove(rail, { pointerId: 1, clientX: 170 });
    fireEvent.pointerUp(rail, { pointerId: 1, clientX: 170 });
    expect(useStore.getState().preferences.sidebarWidth).toBe(220);
  });

  it("opens the workspace surface from the picker", async () => {
    await mountShell();
    fireEvent.click(screen.getByText("Workspace", { selector: "span" }).closest("button")!);
    await settle();
    expect(screen.queryByText("Open a surface")).toBeNull();
    const tab = document.querySelector('[data-active-tab="true"]');
    expect(tab?.textContent).toContain("Workspace");
    const content = document.querySelector("[data-right-panel-surface-content]");
    expect(content?.textContent).toContain("m_ws_a");
    expect(useRightPanelStore.getState().byWorkspaceId["ws_a"]?.activeSurfaceId).toBe("machine");
  });

  it("offers the screen surface only when the status carries a display stream", async () => {
    await mountShell();
    const cardButton = () => screen.getByText("Screen", { selector: "span" }).closest("button");
    expect(cardButton()).toBeNull();
    act(() => {
      useStore.setState(s => ({
        statuses: {
          ...s.statuses,
          ws_a: { ...view("ws_a", "api"), machineState: "running", reach: { state: "reachable" }, size: { cpu: 2, memMb: 4096 }, rateUsdPerHour: 0.1, screen: { streamUrl: "wss://screen" } },
        },
      }));
    });
    expect(cardButton()).not.toBeNull();
  });
});

type Frame = Record<string, unknown>;

class ScriptedSocket {
  static instances: ScriptedSocket[] = [];
  /** The runtime process answering events.subscribe; a test changes it to play a wsp restart. */
  static stream = "stream-a";
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    ScriptedSocket.instances.push(this);
    queueMicrotask(() => this.onopen?.());
  }
  send(data: string): void {
    const frame = JSON.parse(data) as Frame;
    if (frame["op"] === "events.subscribe") {
      queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ id: frame["id"], ok: true, seq: 1, stream: ScriptedSocket.stream }) }));
      return;
    }
    const reply: Frame = {
      id: frame["id"],
      ok: true,
      workspaces: [],
      sessions: [],
      statuses: [],
      capabilities: CAPS,
      manifest: { head: 1, versions: [{ version: 1, snapshotId: "snap_g", baseTemplate: "t", setupSha: "s", createdAt: "c", smoke: { cmd: "true", exitCode: 0 } }] },
    };
    queueMicrotask(() => this.onmessage?.({ data: JSON.stringify(reply) }));
  }
  close(): void {
    this.onclose?.({ code: 1000 });
  }
}

describe("disconnected banner", () => {
  it("appears while the runtime socket redials and clears when it is back", async () => {
    ScriptedSocket.instances.length = 0;
    vi.stubGlobal("WebSocket", ScriptedSocket);
    render(<App wsUrl="ws://test" token="tok" />);
    await waitFor(() => expect(useStore.getState().conn).toBe("live"));
    expect(document.querySelector("[data-disconnected-banner]")).toBeNull();
    act(() => ScriptedSocket.instances[0]!.close());
    expect(useStore.getState().conn).toBe("reconnecting");
    expect(screen.getByText("wsp is not running, reconnecting.")).toBeTruthy();
    // The scripted socket accepts the redial, so the client comes back on its own.
    await waitFor(() => expect(useStore.getState().conn).toBe("live"));
    expect(ScriptedSocket.instances.length).toBe(2);
    expect(document.querySelector("[data-disconnected-banner]")).toBeNull();
  });

  it("a redial answered by another runtime process counts a gap in the store", async () => {
    ScriptedSocket.instances.length = 0;
    ScriptedSocket.stream = "stream-a";
    vi.stubGlobal("WebSocket", ScriptedSocket);
    render(<App wsUrl="ws://test" token="tok" />);
    await waitFor(() => expect(useStore.getState().conn).toBe("live"));
    await waitFor(() => expect(useStore.getState().ready).toBe(true));
    expect(useStore.getState().gaps).toBe(0);
    ScriptedSocket.stream = "stream-b";
    act(() => ScriptedSocket.instances[0]!.close());
    await waitFor(() => expect(useStore.getState().conn).toBe("live"));
    await waitFor(() => expect(useStore.getState().gaps).toBe(1));
  });

  it("asks for a reload once the socket is closed for good", async () => {
    await mountShell();
    act(() => useStore.setState({ conn: "closed" }));
    expect(screen.getByText("wsp is not running.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();
  });

  it("is held back on a window the host did not serve on this computer: there the sidebar says the computer is asleep, and the banner is for a wsp that stopped where this window is", async () => {
    served(undefined);
    await mountShell();
    act(() => useStore.setState({ conn: "reconnecting" }));
    expect(document.querySelector("[data-disconnected-banner]")).toBeNull();
    expect(screen.queryByText("wsp is not running, reconnecting.")).toBeNull();
    expect(screen.getByText(HOST_ASLEEP_LINE)).toBeTruthy();
    act(() => useStore.setState({ conn: "closed" }));
    expect(document.querySelector("[data-disconnected-banner]")).toBeNull();
    // The same window with the host's own token is on the computer wsp runs on, where the banner is the right words.
    served("t_local");
    act(() => useStore.setState({ conn: "reconnecting" }));
    expect(screen.getByText("wsp is not running, reconnecting.")).toBeTruthy();
    expect(screen.queryByText(HOST_ASLEEP_LINE)).toBeNull();
  });
});

const toggleIn = (root: Element) => root.querySelector('[data-slot="sidebar-trigger"]');
const sidebarHeader = () => document.querySelector('[data-slot="sidebar-header"]')!;
const banner = () => screen.getByRole("banner");
const collapse = async () => {
  fireEvent.click(toggleIn(sidebarHeader())!);
  await waitFor(() => expect(document.querySelector("[data-sidebar-state=collapsed]")).not.toBeNull());
};

describe("the header row", () => {
  it("open: the sidebar's row carries the toggle then the wordmark, the page's row the workspace's breadcrumb with no toggle and no wordmark", async () => {
    await mountShell();
    expect(toggleIn(sidebarHeader())).not.toBeNull();
    expect(sidebarHeader().querySelector("[role=img][aria-label=wsp]")).not.toBeNull();
    expect(sidebarHeader().getAttribute("data-header-row")).toBe("frame");
    expect(toggleIn(banner())).toBeNull();
    expect(banner().querySelector("[role=img][aria-label=wsp]")).toBeNull();
    expect(banner().textContent).toContain("api");
    expect(banner().textContent).not.toContain("/");
  });

  it("collapsed: the page's row takes the toggle in front of the breadcrumb, folder glyph, workspace, slash, the open thread's title", async () => {
    await mountShell();
    act(() => useStore.setState({ sessions: { ws_a: [{ id: "s1", workspaceId: "ws_a", harness: "claude", status: "completed", prompt: "make me a simple server", threadId: "thr_1" }, { id: "s2", workspaceId: "ws_a", harness: "claude", status: "running", prompt: "add a health route", threadId: "thr_2" }] } }));
    await collapse();
    expect(toggleIn(banner())).not.toBeNull();
    expect(banner().querySelector("[data-header-row]")!.getAttribute("data-header-row")).toBe("frame");
    const crumb = banner().querySelector("[data-thread-breadcrumb]")!;
    expect(crumb.querySelector("svg")).not.toBeNull();
    expect(crumb.textContent).toBe("api/add a health route");
    act(() => useStore.getState().select("ws_a", "thr_1"));
    expect(banner().querySelector("[data-thread-breadcrumb]")!.textContent).toBe("api/make me a simple server");
    act(() => useStore.getState().select(null));
    expect(banner().querySelector("[data-thread-breadcrumb]")!.textContent).toBe("No workspace selected");
  });

  it("the compose glyph sits in the search row, raises the request for the selected workspace, and leaves with it", async () => {
    await mountShell();
    const seen: string[] = [];
    const off = onNewThreadRequest(d => seen.push(d.workspaceId));
    const compose = screen.getByRole("button", { name: "New thread" });
    expect(compose.closest("[data-sidebar-search]")).not.toBeNull();
    expect(banner().contains(compose)).toBe(false);
    fireEvent.click(compose);
    expect(seen).toEqual(["ws_a"]);
    off();
    act(() => useStore.getState().select(null));
    await waitFor(() => expect(screen.queryByRole("button", { name: "New thread" })).toBeNull());
  });
});

describe("the macOS desktop window", () => {
  const noDrag = (root: Element) => Array.from(root.querySelectorAll("button")).map(b => b.className.includes("[-webkit-app-region:no-drag]"));
  afterEach(() => document.documentElement.classList.remove("desktop-mac"));

  it("with the desktop-mac class on html: both header rows drag the window, their buttons do not, the sidebar shows the window's glass", async () => {
    document.documentElement.classList.add("desktop-mac");
    await mountShell();
    const pageRow = () => banner().querySelector("[data-header-row]")!;
    expect(sidebarHeader().className).toContain("drag-region");
    expect(sidebarHeader().className).toContain("pl-[var(--header-frame-inset)]");
    expect(pageRow().className).toContain("drag-region");
    expect(pageRow().className).not.toContain("pl-[var(--header-frame-inset)]");
    expect(noDrag(sidebarHeader()).length).toBeGreaterThan(0);
    expect(noDrag(sidebarHeader()).every(Boolean)).toBe(true);
    await collapse();
    expect(pageRow().className).toContain("drag-region");
    expect(pageRow().className).toContain("pl-[var(--header-frame-inset)]");
    expect(noDrag(banner()).length).toBeGreaterThan(0);
    expect(noDrag(banner()).every(Boolean)).toBe(true);
    const container = document.querySelector('[data-slot="sidebar-container"]')!;
    expect(container.className).toContain("sidebar-vibrancy");
    expect(container.className).not.toContain("sidebar-glass");
  });

  it("without the class, a browser tab or another platform: nothing drags and the sidebar paints its own glass", async () => {
    await mountShell();
    expect(sidebarHeader().className).not.toContain("drag-region");
    expect(banner().querySelector("[data-header-row]")!.className).not.toContain("drag-region");
    const container = document.querySelector('[data-slot="sidebar-container"]')!;
    expect(container.className).toContain("sidebar-glass");
    expect(container.className).not.toContain("sidebar-vibrancy");
  });
});
