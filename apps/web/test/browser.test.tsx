// SPDX-License-Identifier: AGPL-3.0-only
// Browser tab against a fake api feeding port events in the @wsp/protocol
// vocabulary. No daemon, no cloud: the directory is whatever this client saw.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EventUnion, WorkspaceView } from "@wsp/protocol";
import { useStore } from "../src/protocol/store.js";
import type { Api, ProtocolEvent } from "../src/protocol/client.js";
import { BrowserTab } from "../src/tabs/BrowserTab.js";
import { resetBrowsers } from "../src/browser/model.js";

const WS = "ws_browser01";
const OTHER = "ws_other0002";

const workspace: WorkspaceView = {
  id: WS,
  name: "api",
  machineId: "m1",
  phase: "running",
  golden: "snap_g",
  createdAt: "2026-09-01T00:00:00Z",
};

function fakeApi(workspaces: WorkspaceView[]) {
  const listeners = new Set<(e: ProtocolEvent) => void>();
  const api: Api = {
    listWorkspaces: async () => workspaces,
    getWorkspace: async id => workspaces.find(w => w.id === id)!,
    createWorkspace: async () => workspaces[0]!,
    createFromGoldenHead: async () => workspaces[0]!,
    watchStatuses: async () => [],
    nap: async id => workspaces.find(w => w.id === id)!,
    wake: async id => workspaces.find(w => w.id === id)!,
    listSessions: async () => [],
    subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); },
  };
  const emit = (e: EventUnion) => act(() => { for (const fn of [...listeners]) fn(e); });
  return { api, emit };
}

const open = (workspaceId: string, port: number, pid?: number): EventUnion =>
  ({ type: "port.open", workspaceId, port, ...(pid !== undefined ? { pid } : {}) });
const close = (workspaceId: string, port: number): EventUnion => ({ type: "port.close", workspaceId, port });

function setup(workspaceId = WS) {
  const { api, emit } = fakeApi([workspace]);
  act(() => useStore.getState().bind(api));
  const view = render(<BrowserTab workspaceId={workspaceId} />);
  return { emit, view };
}

afterEach(() => {
  cleanup();
  resetBrowsers();
});

describe("port directory", () => {
  it("starts empty and says so", () => {
    setup();
    expect(screen.getByText("no open ports")).toBeDefined();
    expect(screen.getByText("nothing is listening in this workspace yet")).toBeDefined();
    expect(screen.queryByRole("list", { name: "open ports" })).toBeNull();
  });

  it("port.open renders a card with the port, pid and first-seen time; port.close removes it", () => {
    const { emit } = setup();
    emit(open(WS, 5173, 4182));
    emit(open(WS, 5000));
    const cards = screen.getAllByRole("listitem");
    expect(cards.map(c => c.textContent)).toEqual([expect.stringContaining(":5000"), expect.stringContaining(":5173")]);
    expect(screen.getByText("pid 4182")).toBeDefined();
    expect(screen.getAllByRole("time")).toHaveLength(2);
    expect(screen.getByText("2 listening")).toBeDefined();

    emit(close(WS, 5173));
    expect(screen.queryByText(":5173")).toBeNull();
    expect(screen.getByText("1 listening")).toBeDefined();

    emit(close(WS, 5000));
    expect(screen.getByText("no open ports")).toBeDefined();
  });

  it("a repeated port.open does not duplicate the card", () => {
    const { emit } = setup();
    emit(open(WS, 3000, 1));
    emit(open(WS, 3000, 1));
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
  });

  it("events for another workspace never render here", () => {
    const { emit } = setup();
    emit(open(OTHER, 8080, 611));
    expect(screen.getByText("no open ports")).toBeDefined();
    expect(screen.queryByText(":8080")).toBeNull();
  });
});

describe("click-through", () => {
  it("clicking a card opens that port: address bar and a copyable localhost url", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const { emit } = setup();
    emit(open(WS, 5173, 4182));
    fireEvent.click(screen.getByRole("button", { name: "open :5173" }));

    expect(screen.getByRole("textbox", { name: "address" })).toHaveProperty("value", "http://localhost:5173");
    expect(screen.getByText("http://localhost:5173")).toBeDefined();
    expect(screen.queryByText("no open ports")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "copy url" }));
    expect(writeText).toHaveBeenCalledWith("http://localhost:5173");
    await screen.findByText("copied");

    fireEvent.click(screen.getByRole("button", { name: "port directory" }));
    expect(screen.getByRole("textbox", { name: "address" })).toHaveProperty("value", `wsp://${WS}/ports`);
    expect(screen.getByRole("button", { name: "open :5173" })).toBeDefined();
  });

  it("an open port view notes when its port stops listening", () => {
    const { emit } = setup();
    emit(open(WS, 5173));
    fireEvent.click(screen.getByRole("button", { name: "open :5173" }));
    emit(close(WS, 5173));
    expect(screen.getByText(":5173 stopped listening")).toBeDefined();
    expect(screen.getByRole("textbox", { name: "address" })).toHaveProperty("value", "http://localhost:5173");
  });
});

describe("browser tabs inside the pane", () => {
  it("new tab opens on the directory while the first keeps its port; switching restores each", () => {
    const { emit } = setup();
    emit(open(WS, 5173));
    emit(open(WS, 5000));
    fireEvent.click(screen.getByRole("button", { name: "open :5173" }));
    expect(screen.getAllByRole("tab")).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "new browser tab" }));
    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(2);
    expect(tabs[1]).toHaveProperty("ariaSelected", "true");
    expect(screen.getByText("2 listening")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "open :5000" }));
    expect(screen.getByRole("textbox", { name: "address" })).toHaveProperty("value", "http://localhost:5000");

    fireEvent.click(screen.getByRole("tab", { name: ":5173" }));
    expect(screen.getByRole("textbox", { name: "address" })).toHaveProperty("value", "http://localhost:5173");
    fireEvent.click(screen.getByRole("tab", { name: ":5000" }));
    expect(screen.getByRole("textbox", { name: "address" })).toHaveProperty("value", "http://localhost:5000");
  });

  it("closing a tab activates its neighbour; the last tab cannot be closed", () => {
    const { emit } = setup();
    emit(open(WS, 5173));
    fireEvent.click(screen.getByRole("button", { name: "open :5173" }));
    fireEvent.click(screen.getByRole("button", { name: "new browser tab" }));
    expect(screen.getAllByRole("tab")).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "close tab :5173" }));
    expect(screen.getAllByRole("tab")).toHaveLength(1);
    expect(screen.getByRole("textbox", { name: "address" })).toHaveProperty("value", `wsp://${WS}/ports`);
    expect(screen.queryByRole("button", { name: /^close tab/ })).toBeNull();
  });

  it("tabs and directory survive tab-away: unmount and remount land on the same view", () => {
    const { emit, view } = setup();
    emit(open(WS, 5173, 7));
    fireEvent.click(screen.getByRole("button", { name: "open :5173" }));
    view.unmount();
    render(<BrowserTab workspaceId={WS} />);
    expect(screen.getByRole("textbox", { name: "address" })).toHaveProperty("value", "http://localhost:5173");
    fireEvent.click(screen.getByRole("button", { name: "port directory" }));
    expect(screen.getByText("pid 7")).toBeDefined();
  });

  it("port events that arrive while the tab is parked still update the directory", () => {
    const { emit, view } = setup();
    emit(open(WS, 5173));
    fireEvent.click(screen.getByRole("button", { name: "open :5173" }));
    view.unmount();
    emit(close(WS, 5173));
    emit(open(WS, 5000, 9));
    render(<BrowserTab workspaceId={WS} />);
    expect(screen.getByText(":5173 stopped listening")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "port directory" }));
    expect(screen.queryByText(":5173")).toBeNull();
    expect(screen.getByText("pid 9")).toBeDefined();
  });

  it("a deleted workspace forgets its tabs and directory", () => {
    const { emit, view } = setup();
    emit(open(WS, 5173));
    fireEvent.click(screen.getByRole("button", { name: "open :5173" }));
    view.unmount();
    emit({ type: "workspace.deleted", workspaceId: WS });
    render(<BrowserTab workspaceId={WS} />);
    expect(screen.getByText("no open ports")).toBeDefined();
    expect(screen.getAllByRole("tab")).toHaveLength(1);
  });

  it("each workspace has its own tabs and directory", () => {
    const { emit, view } = setup();
    emit(open(WS, 5173));
    fireEvent.click(screen.getByRole("button", { name: "open :5173" }));
    view.unmount();
    render(<BrowserTab workspaceId={OTHER} />);
    expect(screen.getByText("no open ports")).toBeDefined();
    expect(screen.getAllByRole("tab")).toHaveLength(1);
    expect(screen.getByRole("textbox", { name: "address" })).toHaveProperty("value", `wsp://${OTHER}/ports`);
  });
});
