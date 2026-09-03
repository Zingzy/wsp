// SPDX-License-Identifier: AGPL-3.0-only
// The right panel's browser surface against a fake api: fixture ports arrive
// as protocol events, routes come from a fake portReach. No daemon, no cloud.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EventUnion, WorkspaceView } from "@wsp/protocol";
import { useStore } from "../src/protocol/store.js";
import type { Api, ProtocolEvent } from "../src/protocol/client.js";
import { resetBrowsers } from "../src/browser/model.js";
import { REACH_REASK_FLOOR_MS, REACH_REFRESH_WITH_MS_LEFT } from "../src/browser/reach.js";
import { resetBrowserTabs } from "../src/browser/tabs.js";
import { RightPanel } from "../src/shell/RightPanel.js";
import { selectWorkspaceRightPanelState, useRightPanelStore } from "../src/rightPanelStore.js";

const WS = "ws_browser01";
const OTHER = "ws_other0002";

const workspace = (id: string, phase: WorkspaceView["phase"] = "running"): WorkspaceView => ({
  id,
  name: "api",
  machineId: "m1",
  phase,
  golden: "snap_g",
  createdAt: "2026-09-01T00:00:00Z",
});

const PUBLIC = (port: number, token = "e") => `https://m1-${port}.preview.example/?pt_token=${token}`;
const SHOWN = (port: number) => `https://m1-${port}.preview.example/`;
const mint: Api["portReach"] = async (_id, port) => ({ url: PUBLIC(port), expiresAt: Date.now() + 3_600_000 });

function fakeApi(workspaces: WorkspaceView[], portReach: Api["portReach"] = mint) {
  const listeners = new Set<(e: ProtocolEvent) => void>();
  const api: Api = {
    listWorkspaces: async () => workspaces,
    getWorkspace: async id => workspaces.find(w => w.id === id)!,
    createWorkspace: async () => workspaces[0]!,
    createFromGoldenHead: async () => workspaces[0]!,
    watchStatuses: async () => [],
    nap: async id => workspaces.find(w => w.id === id)!,
    wake: async id => workspaces.find(w => w.id === id)!,
    upgrade: async id => workspaces.find(w => w.id === id)!,
    capabilities: async () => ({ liveCloneForks: true, ramPreservingPause: true, resize: true, previewUrls: true, signedUrls: true, containers: true }),
    portReach,
    daemonReach: async () => ({ url: "ws://127.0.0.1:1", expiresAt: 0 }),
    builderReach: async () => ({ url: "ws://127.0.0.1:1", expiresAt: 0 }),
    startSession: async o => ({ id: "s1", workspaceId: o.workspaceId, harness: "claude", status: "running" }),
    sessionHistory: async () => [],
    listSnapshots: async () => ({ name: "default", head: null, versions: [] }),
    rollbackSnapshot: async () => ({ lineage: { name: "default", head: null, versions: [] }, existingWorkspaces: "untouched" }),
    listSessions: async () => [],
    subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); },
    getGolden: async () => undefined,
    prepareGolden: async () => { throw new Error("no wizard in this fixture"); },
    sealGolden: async () => { throw new Error("no wizard in this fixture"); },
  };
  const emit = (e: EventUnion) => act(() => { for (const fn of [...listeners]) fn(e); });
  return { api, emit };
}

const open = (workspaceId: string, port: number, pid?: number, process?: string): EventUnion =>
  ({ type: "port.open", workspaceId, port, ...(pid !== undefined ? { pid } : {}), ...(process !== undefined ? { process } : {}) });
const close = (workspaceId: string, port: number): EventUnion => ({ type: "port.close", workspaceId, port });

function Harness({ workspaceId }: { workspaceId: string }) {
  const state = useRightPanelStore(s => selectWorkspaceRightPanelState(s.byWorkspaceId, workspaceId));
  return <RightPanel workspaceId={workspaceId} state={state} mode="inline" />;
}

async function setup(opts: { portReach?: Api["portReach"]; workspaces?: WorkspaceView[]; openBrowser?: boolean } = {}) {
  const { api, emit } = fakeApi(opts.workspaces ?? [workspace(WS)], opts.portReach);
  await act(async () => { useStore.getState().bind(api); });
  if (opts.openBrowser !== false) act(() => useRightPanelStore.getState().open(WS, "preview"));
  const view = render(<Harness workspaceId={WS} />);
  await waitFor(() => expect(useStore.getState().workspaces.length).toBeGreaterThan(0));
  return { emit, view, api };
}

const address = () => screen.getByPlaceholderText("Search or enter URL") as HTMLInputElement;
const frame = (port: number) => screen.getByTitle(`:${port}`);
const serverCard = (port: number) => screen.getByRole("button", { name: new RegExp(`^\\S+ localhost:${port}$`) });

beforeEach(() => {
  window.localStorage.clear();
  useRightPanelStore.setState({ byWorkspaceId: {} });
});

afterEach(() => {
  cleanup();
  resetBrowsers();
  resetBrowserTabs();
  vi.useRealTimers();
});

describe("availability", () => {
  it("the picker offers the browser while the workspace runs and greys it out otherwise", async () => {
    await setup({ openBrowser: false });
    expect(screen.getByRole("button", { name: /Browser/ })).toBeDefined();
    cleanup();
    resetBrowsers();
    await setup({ openBrowser: false, workspaces: [workspace(WS, "napping")] });
    expect(screen.queryByRole("button", { name: /Browser/ })).toBeNull();
    expect(screen.getByText("Available while the workspace is running.")).toBeDefined();
  });
});

describe("servers list", () => {
  it("starts on the empty state and says so", async () => {
    await setup();
    expect(screen.getByText("No preview yet")).toBeDefined();
    expect(address().value).toBe("");
  });

  it("lists each listening port with process, host:port and a live dot; port.close removes it", async () => {
    const { emit } = await setup();
    emit(open(WS, 5173, 4182, "node"));
    emit(open(WS, 8080));
    const card = serverCard(5173);
    expect(card.textContent).toContain("node");
    expect(card.textContent).toContain("localhost:5173");
    expect(card.querySelector('[data-slot="live-dot"]')).not.toBeNull();
    expect(serverCard(8080).textContent).toContain("Listening");
    emit(close(WS, 8080));
    expect(screen.queryByRole("button", { name: /localhost:8080/ })).toBeNull();
    expect(screen.queryByText("No preview yet")).toBeNull();
  });

  it("a repeated port.open does not duplicate the card, and another workspace's ports never show", async () => {
    const { emit } = await setup();
    emit(open(WS, 5173));
    emit(open(WS, 5173));
    emit(open(OTHER, 9999));
    expect(screen.getAllByRole("button", { name: /localhost:5173/ })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /localhost:9999/ })).toBeNull();
  });
});

describe("framing a port", () => {
  it("opening a server frames its public route, elides the token in the bar and copies the real url", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const { emit } = await setup();
    emit(open(WS, 5173, 4182, "node"));
    fireEvent.click(serverCard(5173));

    const f = await screen.findByTitle(":5173");
    expect(f.tagName).toBe("IFRAME");
    expect(f.getAttribute("src")).toBe(PUBLIC(5173));
    expect(f.hasAttribute("sandbox")).toBe(false);
    expect(address().value).toBe(SHOWN(5173));
    expect(address().value).not.toContain("pt_token");

    fireEvent.click(screen.getByRole("button", { name: "Copy URL" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(PUBLIC(5173)));

    expect(screen.getByRole("button", { name: "Close node :5173" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Capture screenshot" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Annotate preview" })).toBeNull();
  });

  it("typing a loopback address or a bare port in the bar frames that port", async () => {
    await setup();
    act(() => address().focus());
    fireEvent.change(address(), { target: { value: "localhost:3000" } });
    fireEvent.keyDown(address(), { key: "Enter" });
    await screen.findByTitle(":3000");
    expect(address().value).toBe(SHOWN(3000));

    act(() => address().focus());
    fireEvent.change(address(), { target: { value: "4000" } });
    fireEvent.keyDown(address(), { key: "Enter" });
    await screen.findByTitle(":4000");
    expect(screen.queryByTitle(":3000")).toBeNull();
  });

  it("back returns to the servers list and forward re-frames the port", async () => {
    const { emit } = await setup();
    emit(open(WS, 5173));
    fireEvent.click(serverCard(5173));
    await screen.findByTitle(":5173");
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.queryByTitle(":5173")).toBeNull();
    expect(serverCard(5173)).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Forward" }));
    await screen.findByTitle(":5173");
  });

  it("asks for a fresh route before the current one expires and swaps the frame onto it", async () => {
    let calls = 0;
    const { emit } = await setup({
      portReach: async (_id, port) => {
        calls++;
        return { url: PUBLIC(port, `t${calls}`), expiresAt: Date.now() + 3_600_000 };
      },
    });
    vi.useFakeTimers();
    emit(open(WS, 5173));
    fireEvent.click(serverCard(5173));
    await act(async () => {});
    const f = frame(5173);
    expect(f.getAttribute("src")).toBe(PUBLIC(5173, "t1"));

    await act(() => vi.advanceTimersByTimeAsync(3_600_000 - REACH_REFRESH_WITH_MS_LEFT - 1));
    expect(calls).toBe(1);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(calls).toBe(2);
    expect(frame(5173)).toBe(f);
    expect(f.getAttribute("src")).toBe(PUBLIC(5173, "t2"));
  });

  it("a route handed back with under nine minutes left is re-asked no sooner than the floor", async () => {
    let calls = 0;
    const { emit } = await setup({
      portReach: async (_id, port) => {
        calls++;
        return { url: PUBLIC(port, `t${calls}`), expiresAt: Date.now() + 60_000 };
      },
    });
    vi.useFakeTimers();
    emit(open(WS, 5173));
    fireEvent.click(serverCard(5173));
    await act(async () => {});
    expect(calls).toBe(1);
    await act(() => vi.advanceTimersByTimeAsync(REACH_REASK_FLOOR_MS - 1));
    expect(calls).toBe(1);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(calls).toBe(2);
  });

  it("keeps the frame when the port stops listening and says so above it", async () => {
    const { emit } = await setup();
    emit(open(WS, 5173));
    fireEvent.click(serverCard(5173));
    await screen.findByTitle(":5173");
    emit(close(WS, 5173));
    expect(screen.getByText(":5173 stopped listening")).toBeDefined();
    expect(frame(5173).getAttribute("src")).toBe(PUBLIC(5173));
  });

  it("a route that cannot be minted is said plainly instead of a blank frame", async () => {
    const { emit } = await setup({ portReach: async () => { throw new Error("no preview urls on this backend"); } });
    emit(open(WS, 5173));
    fireEvent.click(serverCard(5173));
    await screen.findByText("no preview urls on this backend");
    expect(screen.queryByTitle(":5173")).toBeNull();
  });
});

describe("recents", () => {
  it("a framed port becomes a recent on the servers list, keyed by its loopback url, and survives a remount", async () => {
    const { emit, view } = await setup();
    emit(open(WS, 5173, 1, "node"));
    fireEvent.click(serverCard(5173));
    await screen.findByTitle(":5173");
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByText("Recently used")).toBeDefined();
    const recent = screen.getByRole("button", { name: /^localhost:5173/ });
    expect(recent.textContent).not.toContain("pt_token");

    view.unmount();
    resetBrowserTabs();
    act(() => useRightPanelStore.getState().open(WS, "preview"));
    render(<Harness workspaceId={WS} />);
    expect(screen.getByText("Recently used")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: /^localhost:5173/ }));
    await screen.findByTitle(":5173");
  });

  it("a recent can be removed and another workspace's recents stay apart", async () => {
    const { emit } = await setup();
    emit(open(WS, 5173));
    fireEvent.click(serverCard(5173));
    await screen.findByTitle(":5173");
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove localhost:5173 from history" }));
    expect(screen.queryByText("Recently used")).toBeNull();
    expect(window.localStorage.getItem(`wsp:browser-recents:v1:${OTHER}`)).toBeNull();
  });
});
