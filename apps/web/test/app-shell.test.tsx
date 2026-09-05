// SPDX-License-Identifier: AGPL-3.0-only
// The shell's three regions, the right panel's toggle, resize and picker,
// and the banner that follows the runtime socket.
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceView } from "@wsp/protocol";
import { App, Shell } from "../src/App.js";
import { MARK_PATH } from "../src/brand/Brand.js";
import type { Api } from "../src/protocol/client.js";
import { useStore } from "../src/protocol/store.js";
import { RIGHT_PANEL_WIDTH_STORAGE_KEY, useRightPanelStore } from "../src/rightPanelStore.js";
import { AppShell } from "../src/shell/AppShell.js";
import { onNewThreadRequest } from "../src/shell/shellRequests.js";

const view = (id: string, name: string): WorkspaceView => ({
  id,
  name,
  machineId: `m_${id}`,
  phase: "running",
  golden: "snap_g",
  createdAt: "2026-09-01T00:00:00Z",
});

const CAPS = { liveCloneForks: true, ramPreservingPause: true, resize: true, previewUrls: true, signedUrls: true, containers: true, callbackRelay: true, snapshotListing: true };

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
    daemonReach: async () => ({ url: "ws://127.0.0.1:1", expiresAt: 0 }),
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

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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
    expect(screen.getByText("Open a surface")).toBeTruthy();
  });

  it("the header's new-thread button raises the request for the selected workspace", async () => {
    await mountShell();
    const seen: string[] = [];
    const off = onNewThreadRequest(d => seen.push(d.workspaceId));
    fireEvent.click(screen.getByRole("button", { name: "New thread" }));
    expect(seen).toEqual(["ws_a"]);
    off();
    act(() => useStore.getState().select(null));
    await waitFor(() => expect(screen.queryByRole("button", { name: "New thread" })).toBeNull());
  });

  it("the header names the model and effort the selected workspace's latest session runs with", async () => {
    await mountShell();
    act(() => useStore.setState({ sessions: { ws_a: [{ id: "s1", workspaceId: "ws_a", harness: "claude", status: "running", model: "claude-opus-5", effort: "high" }] } }));
    const label = document.querySelector("[data-thread-model]");
    expect(label?.textContent).toContain("claude-opus-5");
    expect(label?.textContent).toContain("high");
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

  it("opens the machine surface from the picker", async () => {
    await mountShell();
    fireEvent.click(screen.getByText("Machine", { selector: "span" }).closest("button")!);
    await settle();
    expect(screen.queryByText("Open a surface")).toBeNull();
    const tab = document.querySelector('[data-active-tab="true"]');
    expect(tab?.textContent).toContain("Machine");
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

describe("no golden image", () => {
  it("the line pointing at wsp init leads with the mark", async () => {
    useStore.getState().bind(fakeApi([]));
    render(<Shell />);
    const line = await screen.findByText(/No golden image yet/);
    expect(line.querySelector("svg path")?.getAttribute("d")).toBe(MARK_PATH);
  });
});

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
});
